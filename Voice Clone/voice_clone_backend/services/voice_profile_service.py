"""
services/voice_profile_service.py — 使用者聲音克隆 Profile 管理

對應需求：使用者丟入一段音訊 → 克隆出聲音 → 指派給某個 agent（或全部 agent）
在對話中用這個聲音做 TTS 輸出。

CosyVoice 2 走「zero-shot 克隆」：不需要另外訓練/微調，只需要一段 3-10 秒的
參考音訊 + 這段音訊的逐字稿（prompt_text），推理時就能模仿該聲音念出任意文字
（`inference_zero_shot(tts_text, prompt_text, prompt_speech_16k, stream=True)`）。
所以本模組的核心工作是：

    1. 接收上傳的音訊，存成暫存檔
    2. 建立 profile 時，若使用者沒有手動提供逐字稿，就呼叫既有的
       STTService 自動轉錄參考音訊，取得 reference_text
    3. 把 profile metadata（不含音訊本體）存成 JSON 檔

為什麼用「檔案式儲存」而不是像其他 service 一樣用進程內記憶體 dict：
    CosyVoice 2 的實際推理常駐在 services/cosyvoice_server.py，
    這是「獨立的 process」（架構文件建議跟主 API 分開常駐，避免每次呼叫
    重新載入權重）。兩個 process 沒辦法共用 Python 記憶體，所以 profile
    資訊要落地成檔案，兩邊各自讀取同一份 JSON + 音檔目錄
    （兩個 process 建議跑在同一台機器上，見架構文件 2.4 節）。

使用方式：
    svc = get_voice_profile_service()
    tmp_filename = svc.save_uploaded_sample(audio_bytes, ext=".wav")
    profile = await svc.create_profile(tmp_filename, label="我的聲音")
    profile = svc.get_profile(profile.profile_id)
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from config import get_settings
from models.schemas import VoiceProfile

logger = logging.getLogger(__name__)

_PROFILES_FILENAME = "profiles.json"

ALLOWED_AUDIO_EXTS = {".wav", ".webm", ".mp4", ".m4a", ".ogg", ".mp3"}


class VoiceProfileService:
    """管理使用者上傳音訊 → 建立聲音克隆 profile 的檔案式儲存。"""

    def __init__(self, base_dir: Optional[str] = None):
        settings = get_settings()
        self._base_dir = Path(base_dir or settings.voice_profiles_dir)
        self._base_dir.mkdir(parents=True, exist_ok=True)
        self._profiles_path = self._base_dir / _PROFILES_FILENAME

    # ── 上傳暫存樣本 ──────────────────────────────────────────────

    def save_uploaded_sample(self, audio_bytes: bytes, ext: str = ".wav") -> str:
        """把上傳的音訊存成暫存檔，回傳檔名（供 create_profile 使用）。"""
        if ext not in ALLOWED_AUDIO_EXTS:
            ext = ".wav"
        tmp_filename = f"tmp_{uuid.uuid4().hex[:12]}{ext}"
        tmp_path = self._base_dir / tmp_filename
        tmp_path.write_bytes(audio_bytes)
        logger.info("聲音樣本已暫存：%s（%d bytes）", tmp_filename, len(audio_bytes))
        return tmp_filename

    # ── 建立 Profile ──────────────────────────────────────────────

    async def create_profile(
        self,
        sample_filename: str,
        label: str = "",
        reference_text: str = "",
        stt_service=None,
    ) -> VoiceProfile:
        """
        依已上傳的暫存樣本建立 VoiceProfile。

        若 reference_text 未提供，會呼叫 stt_service（未注入則使用預設單例）
        自動轉錄參考音訊，取得 CosyVoice 2 zero-shot 克隆需要的逐字稿。
        """
        sample_path = self._base_dir / sample_filename
        if not sample_path.exists():
            raise FileNotFoundError(f"找不到樣本檔案：{sample_filename}")

        profile_id = uuid.uuid4().hex

        if not reference_text:
            reference_text = await self._auto_transcribe(sample_path, stt_service)

        profile = VoiceProfile(
            profile_id=profile_id,
            label=label or "未命名聲音",
            reference_audio_path=str(sample_path.resolve()),
            reference_text=reference_text,
            created_at=datetime.now(timezone.utc).isoformat(),
        )

        profiles = self._load_all()
        profiles[profile_id] = profile.model_dump()
        self._save_all(profiles)

        logger.info(
            "聲音克隆 profile 建立完成：profile_id=%s, label=%s, reference_text=%s",
            profile_id,
            profile.label,
            reference_text[:30],
        )
        return profile

    async def _auto_transcribe(self, sample_path: Path, stt_service=None) -> str:
        """呼叫 STTService 自動轉錄參考音訊，取得逐字稿。轉錄失敗則回傳空字串（不阻斷建立流程）。"""
        try:
            if stt_service is None:
                from services.stt_service import get_stt_service

                stt_service = get_stt_service()
            audio_bytes = sample_path.read_bytes()
            result = await stt_service.transcribe(audio_bytes)
            return result.text
        except Exception as exc:  # noqa: BLE001 — 自動轉錄失敗不應該讓建立 profile 整個失敗
            logger.warning("自動轉錄參考音訊逐字稿失敗（%s），reference_text 留空", exc)
            return ""

    # ── 查詢 ──────────────────────────────────────────────────────

    def get_profile(self, profile_id: str) -> Optional[VoiceProfile]:
        profiles = self._load_all()
        data = profiles.get(profile_id)
        return VoiceProfile(**data) if data else None

    def list_profiles(self) -> list[VoiceProfile]:
        profiles = self._load_all()
        return [VoiceProfile(**data) for data in profiles.values()]

    def delete_profile(self, profile_id: str) -> bool:
        profiles = self._load_all()
        if profile_id not in profiles:
            return False
        removed = profiles.pop(profile_id)
        self._save_all(profiles)
        audio_path = Path(removed.get("reference_audio_path", ""))
        if audio_path.exists():
            try:
                audio_path.unlink()
            except OSError as exc:
                logger.warning("刪除 profile 音檔失敗：%s", exc)
        return True

    # ── 內部：JSON 檔讀寫 ─────────────────────────────────────────

    def _load_all(self) -> dict:
        if not self._profiles_path.exists():
            return {}
        try:
            return json.loads(self._profiles_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            logger.warning("profiles.json 損毀，視為空的 profile 清單")
            return {}

    def _save_all(self, profiles: dict) -> None:
        self._profiles_path.write_text(
            json.dumps(profiles, ensure_ascii=False, indent=2), encoding="utf-8"
        )


_voice_profile_service_singleton: Optional[VoiceProfileService] = None


def get_voice_profile_service() -> VoiceProfileService:
    global _voice_profile_service_singleton
    if _voice_profile_service_singleton is None:
        _voice_profile_service_singleton = VoiceProfileService()
    return _voice_profile_service_singleton

"""
voice_service.py — 語音處理服務

責任：
- STT：faster-whisper（local，繁體中文優先，medium 模型，float16）
- TTS：Coqui XTTS v2（local 聲音克隆合成，取代 F5-TTS）
- 雲端備用：ElevenLabs API（設定 ELEVENLABS_API_KEY 後自動啟用）
- 後處理：pitch_shift / speed / energy 調整，讓各物件聲音有所差異
- GPU 記憶體管理：STT 與 TTS 分時載入，維持 4GB VRAM 上限

TTS 方案選擇說明（見 README「已知套件衝突」章節）：
  F5-TTS 與 TripoSR 的 transformers 版本衝突（F5-TTS 強制升級到 5.x，TripoSR 需要 4.35.0），
  改用 Coqui XTTS v2（TTS>=0.22.0），其 transformers>=4.33.0 與 TripoSR 完全相容。

VRAM 估算（GTX 1650 4GB）：
  - faster-whisper medium：~1.5GB
  - XTTS v2：~2.0GB
  - 兩者分時使用，不同時載入

使用方式：
    service = VoiceService()
    profile = await service.clone_voice(audio_bytes, object_id="obj-001")
    audio_bytes = await service.synthesize("你好，我是那把吉他", profile)
    text = await service.transcribe(audio_bytes)
"""

import asyncio
import io
import logging
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf

from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# ── 延遲載入重量級模型（避免啟動時佔用 VRAM）────────────────────────────────
_whisper_model = None          # faster-whisper WhisperModel instance
_xtts_model = None             # Coqui XTTS v2 TTS instance
_xtts_load_attempted = False   # 防止 DLL 缺失等已知錯誤重複重試


# ─────────────────────────────────────────────────────────────────────────────
# 資料結構
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class VoiceProfile:
    """
    單一物件的聲音設定檔。

    Attributes:
        profile_id: 唯一識別碼（UUID）
        reference_audio_path: 用戶原始錄音的絕對路徑（WAV, 16kHz mono）
        pitch_shift: 音高偏移，單位半音（semitone）。正值升高，負值降低。
        speed: 語速倍率，1.0 為正常，< 1 較慢，> 1 較快。
        energy: 音量能量倍率，1.0 為原始，< 1 較輕柔，> 1 較強勁。
        object_id: 對應的 3D 物件 ID。
        object_name: 物件名稱。
    """
    profile_id: str
    reference_audio_path: str
    pitch_shift: float = 0.0
    speed: float = 1.0
    energy: float = 1.0
    object_id: str = ""
    object_name: str = ""

    def to_dict(self) -> dict:
        return {
            "profile_id": self.profile_id,
            "reference_audio_path": self.reference_audio_path,
            "pitch_shift": self.pitch_shift,
            "speed": self.speed,
            "energy": self.energy,
            "object_id": self.object_id,
            "object_name": self.object_name,
        }


# In-memory profile store（key: object_id）
_profiles: dict[str, VoiceProfile] = {}


# ─────────────────────────────────────────────────────────────────────────────
# GPU 記憶體輔助
# ─────────────────────────────────────────────────────────────────────────────

def _release_gpu_cache():
    """釋放 PyTorch CUDA 快取，確保下個模型有足夠 VRAM。"""
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def _get_torch_device() -> str:
    """回傳設定的 device，若 cuda 不可用則 fallback 到 cpu。"""
    try:
        import torch
        device = settings.torch_device
        if device == "cuda" and not torch.cuda.is_available():
            logger.warning("CUDA 不可用，fallback 到 CPU（速度較慢）")
            return "cpu"
        return device
    except ImportError:
        return "cpu"


# ─────────────────────────────────────────────────────────────────────────────
# STT：faster-whisper
# ─────────────────────────────────────────────────────────────────────────────

def _load_whisper():
    """
    延遲載入 faster-whisper 模型。
    GTX 1650 上 medium 模型約佔 1.5GB VRAM。
    """
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model

    try:
        from faster_whisper import WhisperModel

        model_size = settings.whisper_model
        device = _get_torch_device()
        compute_type = settings.torch_dtype if device == "cuda" else "float32"

        logger.info("載入 faster-whisper %s（device=%s, dtype=%s）…", model_size, device, compute_type)
        _whisper_model = WhisperModel(model_size, device=device, compute_type=compute_type)
        logger.info("faster-whisper 載入完成")

    except ImportError:
        logger.error("faster-whisper 未安裝。請執行：pip install -r requirements_voice.txt")
        raise

    return _whisper_model


async def transcribe(audio_bytes: bytes, language: str = "zh") -> str:
    """
    使用 faster-whisper 將音訊辨識為文字。

    Args:
        audio_bytes: WAV 格式音訊資料（16kHz, mono, 16bit 建議）。
        language: 目標語言，預設 "zh"（中文，涵蓋繁體與簡體）。

    Returns:
        辨識出的文字字串。空音訊或辨識失敗回傳空字串。
    """
    loop = asyncio.get_event_loop()

    def _run_transcribe():
        _release_gpu_cache()
        model = _load_whisper()
        audio_io = io.BytesIO(audio_bytes)
        segments, info = model.transcribe(
            audio_io,
            language=language,
            beam_size=5,
            vad_filter=True,
            initial_prompt="以下是繁體中文內容：",
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        logger.debug("STT 完成：語言=%s (%.2f)，結果=%s", info.language, info.language_probability, text[:60])
        return text

    try:
        return await loop.run_in_executor(None, _run_transcribe)
    except Exception as exc:
        logger.error("STT 失敗：%s", exc, exc_info=True)
        return ""


# ─────────────────────────────────────────────────────────────────────────────
# 後處理：pitch / speed / energy
# ─────────────────────────────────────────────────────────────────────────────

def _apply_audio_adjustments(
    audio_data: np.ndarray,
    sample_rate: int,
    pitch_shift: float,
    speed: float,
    energy: float,
) -> tuple[np.ndarray, int]:
    """對已合成的音訊套用 pitch、speed、energy 調整。"""
    try:
        import librosa

        if abs(speed - 1.0) > 0.01:
            audio_data = librosa.effects.time_stretch(audio_data, rate=speed)

        if abs(pitch_shift) > 0.01:
            audio_data = librosa.effects.pitch_shift(audio_data, sr=sample_rate, n_steps=pitch_shift)

    except ImportError:
        logger.warning("librosa 未安裝，跳過 pitch/speed 調整")

    if abs(energy - 1.0) > 0.01:
        audio_data = np.clip(audio_data * energy, -1.0, 1.0)

    return audio_data, sample_rate


def _audio_array_to_wav_bytes(audio_data: np.ndarray, sample_rate: int) -> bytes:
    """將 numpy float32 array 轉換為 WAV bytes。"""
    buf = io.BytesIO()
    sf.write(buf, audio_data, sample_rate, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return buf.read()


# ─────────────────────────────────────────────────────────────────────────────
# TTS：Coqui XTTS v2（取代 F5-TTS）
# ─────────────────────────────────────────────────────────────────────────────

def _load_xtts():
    """
    延遲載入 Coqui XTTS v2 模型。

    VRAM：GTX 1650 上約佔 2.0GB。
    首次執行會自動下載模型（~2GB），請確保磁碟空間充足。
    載入失敗後不再重試（_xtts_load_attempted = True）。

    選用原因：
        transformers>=4.33.0，與 TripoSR 的 transformers==4.35.0 完全相容。
        F5-TTS 會強制升級 transformers 到 5.x，破壞 TripoSR 環境。
    """
    global _xtts_model, _xtts_load_attempted
    if _xtts_load_attempted:
        return _xtts_model
    _xtts_load_attempted = True

    try:
        from TTS.api import TTS  # type: ignore  (pip install TTS)

        device = _get_torch_device()
        gpu = (device == "cuda")
        print(f"[XTTS] 開始載入 XTTS v2（gpu={gpu}）…", flush=True)
        print("[XTTS] 首次使用會自動下載模型約 2GB，請耐心等候", flush=True)

        # XTTS v2：多語言，支援聲音克隆，中文 language code = "zh-cn"
        _xtts_model = TTS(
            model_name="tts_models/multilingual/multi-dataset/xtts_v2",
            gpu=gpu,
        )
        print("[XTTS] 載入完成 ✓", flush=True)

    except ImportError as exc:
        print(f"[XTTS] ImportError：{exc}", flush=True)
        logger.warning(
            "Coqui TTS 匯入失敗（%s）。"
            "請在 venv 中執行：python -c \"from TTS.api import TTS\" 確認問題。",
            exc,
        )

    except Exception as exc:
        print(f"[XTTS] 載入失敗：{exc}", flush=True)
        logger.error("XTTS 載入失敗：%s", exc, exc_info=True)

    return _xtts_model


async def _synthesize_xtts(text: str, reference_audio_path: str) -> Optional[bytes]:
    """
    使用 XTTS v2 進行聲音克隆合成。

    Args:
        text: 要合成的文字（繁體中文）。
        reference_audio_path: 用戶錄音路徑（XTTS 需要至少 6 秒）。

    Returns:
        WAV bytes（24kHz），或 None（若 XTTS 不可用）。
    """
    loop = asyncio.get_event_loop()

    def _run_xtts():
        _release_gpu_cache()
        model = _load_xtts()
        if model is None:
            return None

        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name

        try:
            # XTTS v2 聲音克隆推論
            # language="zh-cn" 支援繁體與簡體中文字符
            model.tts_to_file(
                text=text,
                speaker_wav=reference_audio_path,
                language="zh-cn",
                file_path=tmp_path,
            )
            with open(tmp_path, "rb") as f:
                return f.read()
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    try:
        return await loop.run_in_executor(None, _run_xtts)
    except Exception as exc:
        logger.error("XTTS 合成失敗：%s", exc, exc_info=True)
        return None


async def _synthesize_elevenlabs(text: str, profile: "VoiceProfile") -> Optional[bytes]:
    """
    使用 ElevenLabs API 合成語音（雲端備用）。
    僅在設定了 ELEVENLABS_API_KEY 時啟用。
    """
    api_key = settings.elevenlabs_api_key
    if not api_key:
        return None

    try:
        from elevenlabs.client import ElevenLabs  # type: ignore

        client = ElevenLabs(api_key=api_key)
        logger.info("使用 ElevenLabs 備用 TTS（object=%s）", profile.object_id)
        loop = asyncio.get_event_loop()

        def _run():
            audio = client.text_to_speech.convert(
                voice_id="Rachel",
                text=text,
                model_id="eleven_multilingual_v2",
            )
            return b"".join(audio)

        return await loop.run_in_executor(None, _run)

    except ImportError:
        logger.warning("elevenlabs 未安裝：pip install elevenlabs")
        return None
    except Exception as exc:
        logger.error("ElevenLabs API 失敗：%s", exc)
        return None


def _generate_silence_wav(duration_sec: float = 1.0, sample_rate: int = 24000) -> bytes:
    """產生靜音 WAV（TTS 全部失敗時的安全 fallback）。"""
    samples = np.zeros(int(sample_rate * duration_sec), dtype=np.float32)
    return _audio_array_to_wav_bytes(samples, sample_rate)


# ─────────────────────────────────────────────────────────────────────────────
# 主要 Service 類別
# ─────────────────────────────────────────────────────────────────────────────

class VoiceService:
    """
    語音處理服務的統一入口。

    TTS 優先順序：
        1. Coqui XTTS v2（本地，需 pip install TTS）
        2. ElevenLabs API（雲端，需 ELEVENLABS_API_KEY）
        3. 靜音 WAV（安全 fallback，避免前端崩潰）
    """

    def __init__(self):
        self._samples_dir = Path(settings.voice_samples_dir)
        self._samples_dir.mkdir(parents=True, exist_ok=True)
        logger.info("VoiceService 初始化，samples_dir=%s", self._samples_dir)

    async def clone_voice(
        self,
        audio_bytes: bytes,
        object_id: str,
        object_name: str = "",
        pitch_shift: float = 0.0,
        speed: float = 1.0,
        energy: float = 1.0,
    ) -> VoiceProfile:
        """
        建立聲音 profile，儲存用戶錄音作為 XTTS v2 的 reference audio。

        XTTS v2 建議提供至少 6 秒的清晰錄音，品質越好克隆效果越佳。
        """
        profile_id = str(uuid.uuid4())
        filename = f"{object_id}_{profile_id[:8]}.wav"
        save_path = self._samples_dir / filename

        with open(save_path, "wb") as f:
            f.write(audio_bytes)
        logger.info("Reference audio 已儲存：%s", save_path)

        profile = VoiceProfile(
            profile_id=profile_id,
            reference_audio_path=str(save_path),
            pitch_shift=pitch_shift,
            speed=speed,
            energy=energy,
            object_id=object_id,
            object_name=object_name,
        )
        _profiles[object_id] = profile
        return profile

    async def synthesize(self, text: str, profile: VoiceProfile) -> bytes:
        """
        合成語音並套用 pitch/speed/energy 後處理。

        優先使用 XTTS v2；若失敗且有 ElevenLabs key，自動 fallback。
        """
        if not text.strip():
            return _generate_silence_wav(0.5)

        wav_bytes = None

        # 1. 嘗試 XTTS v2（本地）
        if Path(profile.reference_audio_path).exists():
            wav_bytes = await _synthesize_xtts(text, profile.reference_audio_path)

        # 2. Fallback：ElevenLabs
        if wav_bytes is None:
            wav_bytes = await _synthesize_elevenlabs(text, profile)

        # 3. 靜音 fallback
        if wav_bytes is None:
            logger.warning("TTS 全部失敗，回傳靜音（object_id=%s）", profile.object_id)
            return _generate_silence_wav(1.0)

        # 套用後處理（pitch / speed / energy）
        needs_processing = not (
            abs(profile.pitch_shift) < 0.01
            and abs(profile.speed - 1.0) < 0.01
            and abs(profile.energy - 1.0) < 0.01
        )
        if needs_processing:
            try:
                audio_data, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32")
                audio_data, sr = _apply_audio_adjustments(
                    audio_data, sr,
                    pitch_shift=profile.pitch_shift,
                    speed=profile.speed,
                    energy=profile.energy,
                )
                wav_bytes = _audio_array_to_wav_bytes(audio_data, sr)
            except Exception as exc:
                logger.warning("音訊後處理失敗（跳過）：%s", exc)

        return wav_bytes

    async def transcribe(self, audio_bytes: bytes) -> str:
        """辨識音訊為文字（繁體中文優先）。"""
        return await transcribe(audio_bytes)

    def get_profile(self, object_id: str) -> Optional[VoiceProfile]:
        return _profiles.get(object_id)

    def list_profiles(self) -> list[dict]:
        return [p.to_dict() for p in _profiles.values()]

    def update_profile(
        self,
        profile_id: str,
        pitch_shift: Optional[float] = None,
        speed: Optional[float] = None,
        energy: Optional[float] = None,
    ) -> Optional[VoiceProfile]:
        """即時更新指定 profile 的音訊參數。"""
        for profile in _profiles.values():
            if profile.profile_id == profile_id:
                if pitch_shift is not None:
                    profile.pitch_shift = max(-3.0, min(3.0, pitch_shift))
                if speed is not None:
                    profile.speed = max(0.8, min(1.2, speed))
                if energy is not None:
                    profile.energy = max(0.5, min(1.5, energy))
                logger.info(
                    "Profile %s 更新：pitch=%.2f speed=%.2f energy=%.2f",
                    profile_id, profile.pitch_shift, profile.speed, profile.energy,
                )
                return profile
        return None


# ── Module-level singleton ────────────────────────────────────────────────────
_voice_service_instance: Optional[VoiceService] = None


def get_voice_service() -> VoiceService:
    """回傳 VoiceService 單例（懶載入）。"""
    global _voice_service_instance
    if _voice_service_instance is None:
        _voice_service_instance = VoiceService()
    return _voice_service_instance

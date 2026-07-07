"""
services/tts_service.py — CosyVoice 2 串流 TTS 服務封裝

對照架構文件 2.4 節：
    - CosyVoice 2 非 Pipecat 內建的 TTS 服務，需自己包一層 custom TTS service class
    - 建議把 Pipecat worker process 跟 CosyVoice 2 服務放在同一台 RTX 5090 機器上，
      讓「音訊生成」是 localhost 內部呼叫，只有「LLM 文字 token」需要真的往返雲端網路
    - CosyVoice 2 本身不是台灣腔專用模型，精準台灣腔需額外用台灣腔語料微調
      （見 config.py 的 cosyvoice_taiwan_lora_path，目前尚未訓練，留空使用官方權重）

使用者聲音克隆（見 services/voice_profile_service.py）：
    - 使用者上傳一段音訊 → 建立 VoiceProfile（含自動轉錄的逐字稿）
    - agent 的 AgentConfig.voice_profile_id 指到某個 profile，
      本檔案的 resolve_voice_profile() 負責把 id 換成實際的參考音訊路徑 + 逐字稿
    - CosyVoice 2 走 zero-shot 克隆，不需要另外訓練，載入參考音訊當下就能用

架構：
    CosyVoiceServer（獨立常駐行程，本檔案下方的 CosyVoiceModelServer）
        - 常駐載入 CosyVoice 2 權重，避免每次呼叫重新載入
        - 對外提供 WebSocket streaming 合成介面（文字進、音訊 chunk 串流出）
    CosyVoiceTTSService（Pipecat pipeline 內使用的 client 端封裝）
        - 透過 WebSocket 呼叫上面的常駐服務，屬於 localhost 內部呼叫
    MockTTSService
        - 開發機（GTX 1660 Ti）VRAM 不足以流暢跑 CosyVoice 2 時的替代品，
          只驗證管線協定（文字 → 假音訊 bytes），不需要任何模型權重

使用方式（於 pipeline 中）：
    tts = get_tts_service()
    async for chunk in tts.synthesize(agent_id, sentence, voice_profile_id):
        await websocket.send(chunk.audio_bytes)
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import AsyncIterator, Optional, Protocol

from config import get_settings
from models.schemas import TTSAudioChunk

logger = logging.getLogger(__name__)


class TTSService(Protocol):
    async def synthesize(
        self, agent_id: str, text: str, voice_profile_id: str = ""
    ) -> AsyncIterator[TTSAudioChunk]:
        ...


# ─────────────────────────────────────────────────────────────────────────────
# CosyVoice 2 — 常駐模型服務（跑在 RTX 5090 上的獨立行程）
# ─────────────────────────────────────────────────────────────────────────────

class CosyVoiceModelServer:
    """
    CosyVoice 2 常駐模型服務。

    建議獨立啟動為一個 process（例如 `python -m services.cosyvoice_server`），
    Pipecat worker 透過 WebSocket 呼叫它，兩者在同一台機器上以 localhost 溝通，
    避免每次合成都重新載入權重（CosyVoice 2 權重載入通常需要數秒）。

    TODO：實際整合 CosyVoice 2 官方 repo（https://github.com/FunAudioLLM/CosyVoice）：
        from cosyvoice.cli.cosyvoice import CosyVoice2
        self._model = CosyVoice2(model_dir, load_jit=False, load_trt=False, fp16=True)
        for chunk in self._model.inference_zero_shot(text, prompt_text, prompt_speech, stream=True):
            yield chunk['tts_speech']
    """

    def __init__(self):
        self._model = None
        settings = get_settings()
        self._model_path = settings.cosyvoice_model_path
        self._taiwan_lora_path = settings.cosyvoice_taiwan_lora_path

    def _load(self):
        if self._model is not None:
            return self._model
        if not self._model_path:
            raise RuntimeError(
                "COSYVOICE_MODEL_PATH 未設定，請先下載 CosyVoice 2 權重並設定路徑。"
            )
        raise NotImplementedError(
            "CosyVoice 2 推理程式碼待整合，請參考官方 repo 補上模型載入與 "
            "inference_zero_shot() 串流呼叫（見本類別 docstring 的 TODO）。"
        )

    async def synthesize_stream(
        self, text: str, voice_profile_id: str = ""
    ) -> AsyncIterator[bytes]:
        """
        依 voice_profile_id 解析出使用者的克隆聲音，做 zero-shot 串流合成。

        voice_profile_id 對應到 services/voice_profile_service.py 建立的
        VoiceProfile（使用者上傳音訊後產生），內含：
            - reference_audio_path：使用者上傳的參考音訊
            - reference_text      ：該音訊的逐字稿（自動轉錄或使用者手動輸入）
        兩者就是 CosyVoice 2 zero-shot 克隆 inference_zero_shot() 需要的
        prompt_speech_16k / prompt_text；沒有指定 voice_profile_id 時
        （agent 使用預設官方音色），則走一般 TTS（沒有 prompt 音色參考）。
        """
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._load)

        profile = resolve_voice_profile(voice_profile_id) if voice_profile_id else None
        if voice_profile_id and profile is None:
            logger.warning(
                "找不到 voice_profile_id=%s 對應的克隆聲音 profile，改用預設音色", voice_profile_id
            )

        # TODO: 實際呼叫 self._model.inference_zero_shot(...)：
        #   prompt_speech = load_wav(profile.reference_audio_path, 16000)  # CosyVoice 官方工具函式
        #   for chunk in self._model.inference_zero_shot(
        #       text, profile.reference_text, prompt_speech, stream=True
        #   ):
        #       yield chunk['tts_speech'].numpy().tobytes()
        # 沒有 profile 時可改呼叫官方預設音色的推理方法（例如 inference_sft）。
        raise NotImplementedError("CosyVoice 2 串流合成待實作（見上方 TODO）")
        yield b""  # pragma: no cover — 讓函式維持 async generator 型別


def resolve_voice_profile(voice_profile_id: str):
    """查詢 voice_profile_service，取得 voice_profile_id 對應的 VoiceProfile（找不到回傳 None）。"""
    from services.voice_profile_service import get_voice_profile_service

    return get_voice_profile_service().get_profile(voice_profile_id)


# ─────────────────────────────────────────────────────────────────────────────
# CosyVoiceTTSService — Pipecat pipeline 內的 client 端封裝
# ─────────────────────────────────────────────────────────────────────────────

class CosyVoiceTTSService:
    """
    透過 WebSocket 呼叫本地常駐的 CosyVoiceModelServer（或獨立行程）。

    這一層對應架構文件裡「非 Pipecat 內建 TTS，需要自己包一層 custom TTS
    service class」的需求，也是實際掛進 Pipecat pipeline（見 pipeline/
    conversation_pipeline.py）的物件。
    """

    def __init__(self, host: Optional[str] = None, port: Optional[int] = None):
        settings = get_settings()
        self._host = host or settings.cosyvoice_server_host
        self._port = port or settings.cosyvoice_server_port

    async def synthesize(
        self, agent_id: str, text: str, voice_profile_id: str = ""
    ) -> AsyncIterator[TTSAudioChunk]:
        import websockets

        uri = f"ws://{self._host}:{self._port}/synthesize"
        start = time.perf_counter()
        first_chunk = True

        async with websockets.connect(uri) as ws:
            await ws.send(
                _encode_request(text=text, voice_profile_id=voice_profile_id)
            )
            async for raw in ws:
                ttfb = None
                if first_chunk:
                    ttfb = (time.perf_counter() - start) * 1000
                    first_chunk = False
                yield TTSAudioChunk(agent_id=agent_id, audio_bytes=raw, ttfb_ms=ttfb)

        yield TTSAudioChunk(agent_id=agent_id, audio_bytes=b"", is_final=True)


def _encode_request(text: str, voice_profile_id: str) -> bytes:
    import json

    return json.dumps({"text": text, "voice_profile_id": voice_profile_id}).encode("utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# MockTTSService — 開發機 / CI 使用，不需要任何模型權重
# ─────────────────────────────────────────────────────────────────────────────

class MockTTSService:
    """
    不載入 CosyVoice 2，直接依文字長度產生假音訊 bytes（靜音 PCM），
    用來驗證「pipeline 組裝 → WebSocket 串流 → 前端播放佇列」整條管線，
    在 GTX 1660 Ti 這種 VRAM 有限的開發機上完全不需要 GPU。

    也會模擬「串流分 chunk」的行為（每 chunk 對應約 0.5 秒音訊），
    讓上層程式碼（例如前端播放佇列）可以用同樣的邏輯處理 mock 與真實資料。

    雖然不做真的聲音克隆，仍會呼叫 resolve_voice_profile() 查詢 voice_profile_id
    是否存在，並記錄在 last_resolved_profile，方便測試斷言「有沒有正確查到
    使用者上傳的克隆聲音 profile」，之後換成 CosyVoiceTTSService 時這段查詢
    邏輯不需要改。
    """

    def __init__(self, sample_rate: int = 24000, chunk_seconds: float = 0.5):
        self._sample_rate = sample_rate
        self._chunk_seconds = chunk_seconds
        self.last_resolved_profile = None

    async def synthesize(
        self, agent_id: str, text: str, voice_profile_id: str = ""
    ) -> AsyncIterator[TTSAudioChunk]:
        self.last_resolved_profile = (
            resolve_voice_profile(voice_profile_id) if voice_profile_id else None
        )
        if voice_profile_id and self.last_resolved_profile is None:
            logger.warning("MockTTSService 找不到 voice_profile_id=%s", voice_profile_id)

        start = time.perf_counter()
        # 粗略估計：中文每字約 0.2 秒發音時間
        estimated_seconds = max(len(text) * 0.2, self._chunk_seconds)
        n_chunks = max(1, int(estimated_seconds / self._chunk_seconds))
        samples_per_chunk = int(self._sample_rate * self._chunk_seconds)
        silence_chunk = b"\x00\x00" * samples_per_chunk  # 16-bit PCM 靜音

        for i in range(n_chunks):
            await asyncio.sleep(0)  # 模擬串流節奏但不拖慢測試
            ttfb = (time.perf_counter() - start) * 1000 if i == 0 else None
            yield TTSAudioChunk(
                agent_id=agent_id,
                audio_bytes=silence_chunk,
                sample_rate=self._sample_rate,
                ttfb_ms=ttfb,
            )

        yield TTSAudioChunk(agent_id=agent_id, audio_bytes=b"", is_final=True)


# ─────────────────────────────────────────────────────────────────────────────
# Factory
# ─────────────────────────────────────────────────────────────────────────────

_tts_service_singleton: Optional[TTSService] = None


def get_tts_service() -> TTSService:
    """依 config 的 tts_engine 設定回傳對應的 TTS 服務單例。"""
    global _tts_service_singleton
    if _tts_service_singleton is None:
        settings = get_settings()
        if settings.tts_engine == "cosyvoice2":
            _tts_service_singleton = CosyVoiceTTSService()
        else:
            _tts_service_singleton = MockTTSService()
    return _tts_service_singleton

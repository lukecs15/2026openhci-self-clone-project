"""
services/stt_service.py — STT 雙引擎服務（常用 + 備援）

策略（對照架構文件 2.5 節）：
    主引擎（primary，常用）：Breeze ASR 25/26（MediaTek Research）
        - 針對台灣用語與口音優化，比 Whisper 精準度提升近 10%
        - 中英夾雜辨識提升 56%；26 版另支援台語辨識
    備援引擎（fallback）：faster-whisper (large-v3 / small)
        - 通用性高，RTX 5090 上速度遠超即時
        - primary 逾時（STT_PRIMARY_TIMEOUT_MS）或拋出例外時自動切換

低延遲高品質的作法：
    1. 兩個引擎都採「延遲載入 + 常駐」，避免每次請求重新載入權重。
    2. primary 用 asyncio.wait_for 設定逾時，一旦逾時立刻改跑 fallback，
       不會讓使用者等待 primary 完全失敗才有回應。
    3. fallback 也有自己的逾時保護（STT_FALLBACK_TIMEOUT_MS，預設 8 秒）。
       這是修過的一個真實 bug：如果 primary 和 fallback 都指向同一種引擎
       （例如 dev 環境預設兩者都是 faster-whisper），且模型權重是「延遲載入」，
       primary 逾時後改跑 fallback 時，fallback 是全新的引擎實例，會重新觸發
       一次載入/下載；如果網路很慢或被擋住，這個過程可能真的卡住不動。
       過去 fallback 呼叫完全沒有逾時保護，會讓整個請求無限期 hang 住
       （例如：上傳聲音樣本後「處理中」永遠不結束）。現在 fallback 逾時
       會直接拋出明確錯誤，而不是無限等待。
    4. dev（GTX 1660 Ti）環境預設兩個引擎都指向 faster-whisper 的不同模型大小，
       讓「主/備切換」的程式邏輯可以完整測試，不必依賴 Breeze ASR 權重就能跑。

使用方式：
    svc = get_stt_service()
    result = await svc.transcribe(audio_bytes)
    print(result.text, result.engine_used, result.used_fallback)
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional, Protocol

from config import get_settings
from models.schemas import STTEngineUsed, STTResult

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# 音訊解碼輔助（瀏覽器錄音常見 webm/opus，soundfile 無法直接解析）
# ─────────────────────────────────────────────────────────────────────────────

def decode_audio_bytes_to_mono_float32(audio_bytes: bytes):
    """
    把任意格式的音訊 bytes 解成 mono float32 numpy array（給 faster-whisper 用）。

    先用 soundfile 嘗試（涵蓋 WAV/FLAC/OGG 等，且不需要外部程式），失敗的話
    （常見情境：瀏覽器 MediaRecorder 錄出來的 webm/opus，或使用者上傳的
    m4a/mp4/mp3，soundfile 底層 libsndfile 不支援這些容器），改用 PyAV 解碼。

    修過的真實問題：一開始改用 pydub + 系統 ffmpeg，但 Windows 正式機常常
    沒把 ffmpeg 加進 PATH；後來改成 pydub + imageio-ffmpeg 內附執行檔，結果
    還是失敗——因為 pydub 在轉檔前會先呼叫 mediainfo_json() 探測音訊資訊，
    這一步是「另外」透過 pydub.utils.get_prober_name() 找系統 PATH 上的
    ffprobe/avprobe，完全不理會 AudioSegment.converter/ffmpeg 這些可覆寫的
    class 屬性，所以指定 imageio-ffmpeg 執行檔路徑也沒用，一樣是
    「WinError 2 系統找不到指定的檔案」。改用 PyAV（`av` 套件）後不再需要
    任何外部 ffmpeg/ffprobe 執行檔或 PATH 設定——PyAV 是直接連結 ffmpeg
    共用函式庫（libavformat/libavcodec）的 Python binding，wheel 內已經
    附帶對應平台的函式庫。

    若兩者皆失敗，會拋出例外（呼叫端負責決定要不要吞掉這個錯誤，例如
    voice_profile_service.py 的自動轉錄失敗時只會讓 reference_text 留空，
    不會擋住整個聲音克隆 profile 的建立）。
    """
    import io

    import numpy as np

    try:
        import soundfile as sf

        audio_np, _sr = sf.read(io.BytesIO(audio_bytes), dtype="float32")
    except Exception as exc:  # noqa: BLE001 — soundfile 對非其支援格式會直接拋例外
        logger.info("soundfile 無法解析音訊（%s），改用 PyAV 解碼", exc)
        audio_np = _decode_with_pyav(audio_bytes)

    if audio_np.ndim > 1:
        audio_np = audio_np.mean(axis=1)
    return audio_np.astype(np.float32)


def _decode_with_pyav(audio_bytes: bytes, target_sample_rate: int = 16000):
    """用 PyAV 把任意容器格式（webm/opus、m4a、mp3…）解成 mono float32 numpy array。

    不依賴系統安裝的 ffmpeg/ffprobe 執行檔或 PATH 設定（見上方
    decode_audio_bytes_to_mono_float32 docstring 的說明）。
    """
    import io

    import av
    import numpy as np

    container = av.open(io.BytesIO(audio_bytes))
    try:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="s16", layout="mono", rate=target_sample_rate)

        chunks = []
        for frame in container.decode(stream):
            for resampled in resampler.resample(frame):
                chunks.append(resampled.to_ndarray())
        # resampler 內部可能還緩衝著最後一小段，flush 一次拿出來
        for resampled in resampler.resample(None):
            chunks.append(resampled.to_ndarray())
    finally:
        container.close()

    if not chunks:
        raise RuntimeError("PyAV 未能從音訊中解出任何 frame（檔案可能是空的或已損毀）")

    pcm_int16 = np.concatenate(chunks, axis=1).reshape(-1)
    return (pcm_int16.astype(np.float32) / 32768.0)


# ─────────────────────────────────────────────────────────────────────────────
# 引擎介面
# ─────────────────────────────────────────────────────────────────────────────

class STTEngine(Protocol):
    """所有 STT 引擎共同介面，方便 primary/fallback 互換與測試時注入假引擎。"""

    name: STTEngineUsed

    async def transcribe(self, audio_bytes: bytes, language: str = "zh") -> str:
        ...


# ─────────────────────────────────────────────────────────────────────────────
# Breeze ASR（主引擎，台灣腔優化）
# ─────────────────────────────────────────────────────────────────────────────

class BreezeASREngine:
    """
    MediaTek Research Breeze ASR 25/26 封裝。

    TODO：目前僅提供延遲載入骨架，實際推理需安裝 funasr / modelscope
    並下載 breeze_asr_model 指定的權重（見 requirements/prod-rtx5090.txt）。
    """

    name = STTEngineUsed.BREEZE

    def __init__(self):
        self._model = None
        settings = get_settings()
        self._model_name = settings.breeze_asr_model

    def _load(self):
        if self._model is not None:
            return self._model
        try:
            # 實際整合時：
            #   from funasr import AutoModel
            #   self._model = AutoModel(model=self._model_name)
            raise NotImplementedError(
                "Breeze ASR 尚未整合實際推理程式碼，請安裝 funasr 後於此處補上模型載入邏輯。"
            )
        except ImportError as exc:
            logger.error("Breeze ASR 依賴未安裝：%s", exc)
            raise

    async def transcribe(self, audio_bytes: bytes, language: str = "zh") -> str:
        loop = asyncio.get_event_loop()
        model = await loop.run_in_executor(None, self._load)
        # TODO: 實際呼叫 model 做推理，回傳辨識文字
        return await loop.run_in_executor(None, lambda: self._run_inference(model, audio_bytes))

    def _run_inference(self, model, audio_bytes: bytes) -> str:
        raise NotImplementedError("Breeze ASR 推理邏輯待實作（見 TODO）")


# ─────────────────────────────────────────────────────────────────────────────
# faster-whisper（備援引擎，通用高速）
# ─────────────────────────────────────────────────────────────────────────────

class FasterWhisperEngine:
    """faster-whisper 封裝，延遲載入模型並常駐於記憶體。"""

    name = STTEngineUsed.FASTER_WHISPER

    def __init__(self):
        self._model = None
        settings = get_settings()
        self._model_size = settings.whisper_model
        self._device = settings.torch_device
        self._compute_type = settings.whisper_compute_type

    def _load(self):
        if self._model is not None:
            return self._model
        from faster_whisper import WhisperModel

        device = self._device
        try:
            import torch

            if device == "cuda" and not torch.cuda.is_available():
                logger.warning("CUDA 不可用，faster-whisper fallback 到 CPU")
                device = "cpu"
        except ImportError:
            device = "cpu"

        compute_type = self._compute_type if device == "cuda" else "float32"
        logger.info(
            "載入 faster-whisper %s（device=%s, compute_type=%s）…",
            self._model_size,
            device,
            compute_type,
        )
        self._model = WhisperModel(self._model_size, device=device, compute_type=compute_type)
        return self._model

    async def transcribe(self, audio_bytes: bytes, language: str = "zh") -> str:
        loop = asyncio.get_event_loop()
        model = await loop.run_in_executor(None, self._load)
        return await loop.run_in_executor(None, self._run_inference, model, audio_bytes, language)

    def _run_inference(self, model, audio_bytes: bytes, language: str) -> str:
        audio_np = decode_audio_bytes_to_mono_float32(audio_bytes)
        segments, _info = model.transcribe(audio_np, language=language, beam_size=5)
        return "".join(seg.text for seg in segments).strip()


# ─────────────────────────────────────────────────────────────────────────────
# Mock 引擎（開發機驗證管線用，不需任何模型權重）
# ─────────────────────────────────────────────────────────────────────────────

class MockSTTEngine:
    """
    不載入任何模型，直接回傳固定/可注入的文字。

    用途：在 GTX 1660 Ti 或 CI 環境驗證「WebSocket 協定 + 多 Agent 編排」邏輯，
    不需要真的跑語音辨識。
    """

    name = STTEngineUsed.MOCK

    def __init__(self, canned_text: str = "（mock）使用者語音輸入"):
        self._canned_text = canned_text

    async def transcribe(self, audio_bytes: bytes, language: str = "zh") -> str:
        await asyncio.sleep(0)  # 保持 async 介面一致
        return self._canned_text


# ─────────────────────────────────────────────────────────────────────────────
# 雙引擎協調服務
# ─────────────────────────────────────────────────────────────────────────────

_ENGINE_REGISTRY = {
    STTEngineUsed.BREEZE: BreezeASREngine,
    STTEngineUsed.FASTER_WHISPER: FasterWhisperEngine,
    STTEngineUsed.MOCK: MockSTTEngine,
}


def _build_engine(name: str) -> STTEngine:
    engine_enum = STTEngineUsed(name)
    return _ENGINE_REGISTRY[engine_enum]()


class STTService:
    """
    STT 雙引擎協調器：先嘗試 primary，逾時或失敗則自動切換 fallback。

    primary 與 fallback 都有各自的逾時保護（primary_timeout_ms / fallback_timeout_ms），
    兩者都逾時或失敗時會拋出 RuntimeError，而不是無限期等待。

    可透過建構子直接注入 primary_engine / fallback_engine（測試時傳入假引擎），
    未提供則依 config.py 設定自動建立。
    """

    def __init__(
        self,
        primary_engine: Optional[STTEngine] = None,
        fallback_engine: Optional[STTEngine] = None,
        primary_timeout_ms: Optional[int] = None,
        fallback_timeout_ms: Optional[int] = None,
    ):
        settings = get_settings()
        self._primary = primary_engine or _build_engine(settings.stt_primary_engine)
        self._fallback = fallback_engine or _build_engine(settings.stt_fallback_engine)
        self._timeout_s = (primary_timeout_ms or settings.stt_primary_timeout_ms) / 1000.0
        self._fallback_timeout_s = (
            fallback_timeout_ms or settings.stt_fallback_timeout_ms
        ) / 1000.0

    @property
    def primary_engine(self) -> STTEngine:
        return self._primary

    @property
    def fallback_engine(self) -> STTEngine:
        return self._fallback

    async def warmup(self) -> None:
        """伺服器啟動時預先載入 primary / fallback 權重，避免第一個真實請求才觸發延遲載入。

        修過的真實問題：primary 逾時保護（STT_PRIMARY_TIMEOUT_MS，預設僅
        1500ms）量的是「一次 transcribe 呼叫」的時間，但引擎第一次被呼叫時
        還包含權重載入（甚至下載）——對 faster-whisper large-v3 這種大模型
        來說遠超過 1500ms。結果是正式環境的第一次請求 primary 必定被誤判
        逾時、改跑 fallback，而 fallback 若跟 primary 同引擎（見 config.py
        「dev 環境預設兩者都是 faster-whisper」的說明），又要重新載入一次，
        使用者要多等一輪。啟動時就在背景執行緒把兩個引擎都載入好，之後
        逾時保護量到的才是真正的推理延遲。任何一個引擎預先載入失敗都只記
        警告，不阻擋伺服器啟動（仍會在第一次請求時照舊延遲載入重試）。
        """
        loop = asyncio.get_event_loop()
        for engine, label in ((self._primary, "primary"), (self._fallback, "fallback")):
            load_fn = getattr(engine, "_load", None)
            if load_fn is None:
                continue
            try:
                await loop.run_in_executor(None, load_fn)
                logger.info("STT %s 引擎（%s）已預先載入完成", label, engine.name.value)
            except Exception:
                logger.exception(
                    "STT %s 引擎（%s）預先載入失敗，仍會在第一次請求時延遲載入重試",
                    label,
                    engine.name.value,
                )

    async def transcribe(self, audio_bytes: bytes, language: str = "zh") -> STTResult:
        start = time.perf_counter()
        used_fallback = False
        engine_used = self._primary.name
        text = ""

        try:
            text = await asyncio.wait_for(
                self._primary.transcribe(audio_bytes, language), timeout=self._timeout_s
            )
        except asyncio.TimeoutError:
            logger.warning(
                "STT primary（%s）逾時（>%dms），切換 fallback（%s）",
                self._primary.name.value,
                int(self._timeout_s * 1000),
                self._fallback.name.value,
            )
            used_fallback = True
        except Exception as exc:  # noqa: BLE001 — 任何 primary 失敗都應該切換 fallback
            logger.warning(
                "STT primary（%s）失敗：%s，切換 fallback（%s）",
                self._primary.name.value,
                exc,
                self._fallback.name.value,
            )
            used_fallback = True

        if used_fallback:
            engine_used = self._fallback.name
            try:
                text = await asyncio.wait_for(
                    self._fallback.transcribe(audio_bytes, language),
                    timeout=self._fallback_timeout_s,
                )
            except asyncio.TimeoutError as exc:
                logger.error(
                    "STT fallback（%s）也逾時（>%dms），辨識失敗（不再無限等待）",
                    self._fallback.name.value,
                    int(self._fallback_timeout_s * 1000),
                )
                raise RuntimeError(
                    f"STT 辨識失敗：primary 與 fallback 引擎皆逾時"
                    f"（primary={self._primary.name.value}, fallback={self._fallback.name.value}）"
                ) from exc
            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "STT fallback（%s）也失敗：%s", self._fallback.name.value, exc
                )
                raise RuntimeError(
                    f"STT 辨識失敗：primary 與 fallback 引擎皆失敗（{exc}）"
                ) from exc

        latency_ms = (time.perf_counter() - start) * 1000
        return STTResult(
            text=text,
            engine_used=engine_used,
            used_fallback=used_fallback,
            latency_ms=latency_ms,
            language=language,
        )


_stt_service_singleton: Optional[STTService] = None


def get_stt_service() -> STTService:
    """回傳 STTService 單例（依目前 config 設定建立）。"""
    global _stt_service_singleton
    if _stt_service_singleton is None:
        _stt_service_singleton = STTService()
    return _stt_service_singleton

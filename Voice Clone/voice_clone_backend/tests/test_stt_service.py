"""
test_stt_service.py — 驗證 STT 雙引擎（primary + fallback）切換邏輯。

不載入任何真實模型，全部用假引擎（可控制是否逾時/拋例外）來驗證
STTService 的「主引擎失敗 → 自動切換備援」行為是否正確，以及修過的
「fallback 也要有逾時保護」這個 bug（過去 fallback 沒有逾時保護，
一旦 fallback 也卡住，整個請求會無限期 hang 住）。
"""

import asyncio
import time

import pytest

from models.schemas import STTEngineUsed
from services.stt_service import STTService, decode_audio_bytes_to_mono_float32


class _FakeEngine:
    """可控制回傳文字 / 延遲 / 是否拋例外的假 STT 引擎。"""

    def __init__(self, name: STTEngineUsed, text: str = "", delay: float = 0.0, raise_exc: bool = False):
        self.name = name
        self._text = text
        self._delay = delay
        self._raise_exc = raise_exc

    async def transcribe(self, audio_bytes: bytes, language: str = "zh") -> str:
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._raise_exc:
            raise RuntimeError("模擬 STT 引擎錯誤")
        return self._text


@pytest.mark.asyncio
async def test_primary_success_does_not_use_fallback():
    primary = _FakeEngine(STTEngineUsed.BREEZE, text="主引擎辨識結果")
    fallback = _FakeEngine(STTEngineUsed.FASTER_WHISPER, text="備援辨識結果")
    svc = STTService(primary_engine=primary, fallback_engine=fallback, primary_timeout_ms=1000)

    result = await svc.transcribe(b"fake-audio")

    assert result.text == "主引擎辨識結果"
    assert result.engine_used == STTEngineUsed.BREEZE
    assert result.used_fallback is False


@pytest.mark.asyncio
async def test_primary_exception_falls_back():
    primary = _FakeEngine(STTEngineUsed.BREEZE, raise_exc=True)
    fallback = _FakeEngine(STTEngineUsed.FASTER_WHISPER, text="備援辨識結果")
    svc = STTService(primary_engine=primary, fallback_engine=fallback, primary_timeout_ms=1000)

    result = await svc.transcribe(b"fake-audio")

    assert result.text == "備援辨識結果"
    assert result.engine_used == STTEngineUsed.FASTER_WHISPER
    assert result.used_fallback is True


@pytest.mark.asyncio
async def test_primary_timeout_falls_back():
    primary = _FakeEngine(STTEngineUsed.BREEZE, text="太慢了", delay=0.5)
    fallback = _FakeEngine(STTEngineUsed.FASTER_WHISPER, text="備援辨識結果")
    svc = STTService(primary_engine=primary, fallback_engine=fallback, primary_timeout_ms=50)

    result = await svc.transcribe(b"fake-audio")

    assert result.text == "備援辨識結果"
    assert result.used_fallback is True


@pytest.mark.asyncio
async def test_latency_is_recorded():
    primary = _FakeEngine(STTEngineUsed.BREEZE, text="ok")
    fallback = _FakeEngine(STTEngineUsed.FASTER_WHISPER, text="ok")
    svc = STTService(primary_engine=primary, fallback_engine=fallback, primary_timeout_ms=1000)

    result = await svc.transcribe(b"fake-audio")

    assert result.latency_ms >= 0


@pytest.mark.asyncio
async def test_fallback_timeout_raises_instead_of_hanging_forever():
    """
    迴歸測試：修過的 bug——primary 逾時後改跑 fallback，若 fallback
    也卡住（例如模型下載卡住），過去完全沒有逾時保護，會無限期 hang 住。
    現在應該在 fallback_timeout_ms 內拋出明確的 RuntimeError。
    """
    primary = _FakeEngine(STTEngineUsed.BREEZE, delay=10)  # 模擬 primary 卡住
    fallback = _FakeEngine(STTEngineUsed.FASTER_WHISPER, delay=10)  # fallback 也卡住
    svc = STTService(
        primary_engine=primary,
        fallback_engine=fallback,
        primary_timeout_ms=50,
        fallback_timeout_ms=100,
    )

    start = time.perf_counter()
    with pytest.raises(RuntimeError, match="STT 辨識失敗"):
        await svc.transcribe(b"fake-audio")
    elapsed_s = time.perf_counter() - start

    # 應該在 primary_timeout + fallback_timeout 附近就失敗（遠低於卡住的 10 秒）
    assert elapsed_s < 2.0


@pytest.mark.asyncio
async def test_fallback_exception_after_primary_failure_raises_clear_error():
    primary = _FakeEngine(STTEngineUsed.BREEZE, raise_exc=True)
    fallback = _FakeEngine(STTEngineUsed.FASTER_WHISPER, raise_exc=True)
    svc = STTService(primary_engine=primary, fallback_engine=fallback, primary_timeout_ms=1000)

    with pytest.raises(RuntimeError, match="STT 辨識失敗"):
        await svc.transcribe(b"fake-audio")


# ─────────────────────────────────────────────────────────────────────────────
# decode_audio_bytes_to_mono_float32：音訊解碼（webm/opus、m4a 等 fallback 到 PyAV）
# ─────────────────────────────────────────────────────────────────────────────

def _make_wav_bytes(duration_s: float = 0.5, sample_rate: int = 16000) -> bytes:
    import io

    import numpy as np
    import soundfile as sf

    t = np.linspace(0, duration_s, int(sample_rate * duration_s), endpoint=False)
    tone = (0.1 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    buf = io.BytesIO()
    sf.write(buf, tone, sample_rate, format="WAV")
    return buf.getvalue()


def test_decode_audio_bytes_handles_wav_via_soundfile():
    wav_bytes = _make_wav_bytes()
    audio_np = decode_audio_bytes_to_mono_float32(wav_bytes)

    assert audio_np.dtype.name == "float32"
    assert audio_np.ndim == 1
    assert len(audio_np) > 0


def _make_aac_adts_bytes(duration_s: float = 0.3, sample_rate: int = 16000) -> bytes:
    """用 PyAV 產生一段 AAC/ADTS 音訊（m4a 常見的音訊編碼），純 Python 不需要
    系統安裝 ffmpeg——libsndfile（soundfile 的底層）不支援 AAC，剛好用來
    測試「soundfile 解析失敗 → 改用 PyAV」這條 fallback 路徑，且跟真實回報
    過的情境一致（使用者上傳 .m4a 樣本失敗）。
    """
    import io

    import av
    import numpy as np

    t = np.linspace(0, duration_s, int(sample_rate * duration_s), endpoint=False)
    tone = (0.1 * np.sin(2 * np.pi * 440 * t) * 32767).astype(np.int16)

    buf = io.BytesIO()
    container = av.open(buf, mode="w", format="adts")
    stream = container.add_stream("aac", rate=sample_rate)
    frame = av.AudioFrame.from_ndarray(tone.reshape(1, -1), format="s16", layout="mono")
    frame.sample_rate = sample_rate
    for packet in stream.encode(frame):
        container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
    container.close()
    return buf.getvalue()


def test_decode_audio_bytes_falls_back_to_pyav_for_non_wav_container():
    """
    模擬瀏覽器 MediaRecorder / 使用者上傳 m4a 的情境：soundfile 無法解析的
    容器格式（這裡用 AAC/ADTS 當代表，libsndfile 不支援 AAC），應該自動
    改用 PyAV 解碼成功（見 decode_audio_bytes_to_mono_float32 docstring
    說明過去 pydub + 系統/imageio-ffmpeg 都無法可靠解決這個問題的原因）。
    """
    pytest.importorskip("av")

    aac_bytes = _make_aac_adts_bytes()
    audio_np = decode_audio_bytes_to_mono_float32(aac_bytes)

    assert audio_np.dtype.name == "float32"
    assert len(audio_np) > 0

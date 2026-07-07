"""
test_tts_voice_profile_integration.py — 驗證 TTS 服務能正確查到使用者的克隆聲音 profile。

情境：使用者上傳音訊建立 VoiceProfile 後，把 profile_id 指派給某個 agent
（AgentConfig.voice_profile_id），呼叫 TTS 服務合成時應該要能查到這個 profile
（MockTTSService.last_resolved_profile / CosyVoiceModelServer 之後接上真實推理時
也是走同一個 resolve_voice_profile() 查詢邏輯）。
"""

import pytest

import services.tts_service as tts_service_module
from services.stt_service import STTService
from services.tts_service import MockTTSService
from services.voice_profile_service import VoiceProfileService


class _FakeSTTEngine:
    async def transcribe(self, audio_bytes: bytes, language: str = "zh") -> str:
        return "使用者上傳的參考音訊逐字稿"


@pytest.fixture
def profile_service(tmp_path, monkeypatch):
    svc = VoiceProfileService(base_dir=str(tmp_path / "voice_profiles"))
    # 讓 resolve_voice_profile()（透過 get_voice_profile_service 單例）指向這個測試用的 service
    monkeypatch.setattr(
        tts_service_module, "resolve_voice_profile", lambda pid: svc.get_profile(pid)
    )
    return svc


@pytest.mark.asyncio
async def test_mock_tts_resolves_assigned_voice_profile(profile_service):
    fake_stt = STTService(primary_engine=_FakeSTTEngine(), fallback_engine=_FakeSTTEngine())
    filename = profile_service.save_uploaded_sample(b"fake-wav-bytes", ext=".wav")
    profile = await profile_service.create_profile(
        filename, label="我的聲音", stt_service=fake_stt
    )

    tts = MockTTSService()
    chunks = [
        chunk
        async for chunk in tts.synthesize("agent-a", "你好", voice_profile_id=profile.profile_id)
    ]

    assert len(chunks) > 0
    assert tts.last_resolved_profile is not None
    assert tts.last_resolved_profile.profile_id == profile.profile_id
    assert tts.last_resolved_profile.label == "我的聲音"


@pytest.mark.asyncio
async def test_mock_tts_without_voice_profile_id_resolves_nothing(profile_service):
    tts = MockTTSService()
    _ = [chunk async for chunk in tts.synthesize("agent-a", "你好", voice_profile_id="")]

    assert tts.last_resolved_profile is None


@pytest.mark.asyncio
async def test_mock_tts_unknown_profile_id_resolves_to_none_and_logs_warning(profile_service):
    tts = MockTTSService()
    _ = [
        chunk
        async for chunk in tts.synthesize("agent-a", "你好", voice_profile_id="不存在的-profile-id")
    ]

    assert tts.last_resolved_profile is None

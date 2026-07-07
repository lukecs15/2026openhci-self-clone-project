"""
test_voice_profile_service.py — 驗證使用者聲音克隆 profile 的建立/查詢/刪除邏輯。

全部用 tmp_path 隔離檔案系統，並注入假 STT 引擎（不需要真的跑語音辨識），
驗證「上傳樣本 → 自動轉錄逐字稿 → 建立 profile → 之後可查到」整條流程。
"""

import pytest

from models.schemas import STTEngineUsed
from services.stt_service import STTService
from services.voice_profile_service import VoiceProfileService


class _FakeSTTEngine:
    name = STTEngineUsed.MOCK

    def __init__(self, text: str = "這是我的聲音樣本"):
        self._text = text

    async def transcribe(self, audio_bytes: bytes, language: str = "zh") -> str:
        return self._text


@pytest.fixture
def profile_service(tmp_path):
    return VoiceProfileService(base_dir=str(tmp_path / "voice_profiles"))


@pytest.fixture
def fake_stt():
    return STTService(primary_engine=_FakeSTTEngine(), fallback_engine=_FakeSTTEngine())


def test_save_uploaded_sample_writes_file_and_returns_filename(profile_service):
    filename = profile_service.save_uploaded_sample(b"fake-wav-bytes", ext=".wav")
    assert filename.endswith(".wav")
    saved_path = profile_service._base_dir / filename
    assert saved_path.exists()
    assert saved_path.read_bytes() == b"fake-wav-bytes"


def test_save_uploaded_sample_rejects_unknown_ext_falls_back_to_wav(profile_service):
    filename = profile_service.save_uploaded_sample(b"data", ext=".exe")
    assert filename.endswith(".wav")


@pytest.mark.asyncio
async def test_create_profile_auto_transcribes_reference_text(profile_service, fake_stt):
    filename = profile_service.save_uploaded_sample(b"fake-wav-bytes", ext=".wav")

    profile = await profile_service.create_profile(
        sample_filename=filename, label="我的聲音", stt_service=fake_stt
    )

    assert profile.label == "我的聲音"
    assert profile.reference_text == "這是我的聲音樣本"
    assert profile.reference_audio_path.endswith(".wav")
    assert profile.profile_id


@pytest.mark.asyncio
async def test_create_profile_respects_manual_reference_text(profile_service, fake_stt):
    filename = profile_service.save_uploaded_sample(b"fake-wav-bytes", ext=".wav")

    profile = await profile_service.create_profile(
        sample_filename=filename,
        label="手動輸入逐字稿",
        reference_text="使用者手動打的逐字稿",
        stt_service=fake_stt,
    )

    assert profile.reference_text == "使用者手動打的逐字稿"


@pytest.mark.asyncio
async def test_create_profile_missing_sample_raises(profile_service, fake_stt):
    with pytest.raises(FileNotFoundError):
        await profile_service.create_profile(
            sample_filename="not-exists.wav", stt_service=fake_stt
        )


@pytest.mark.asyncio
async def test_get_and_list_profiles(profile_service, fake_stt):
    filename_a = profile_service.save_uploaded_sample(b"a", ext=".wav")
    filename_b = profile_service.save_uploaded_sample(b"b", ext=".wav")
    profile_a = await profile_service.create_profile(filename_a, label="A", stt_service=fake_stt)
    profile_b = await profile_service.create_profile(filename_b, label="B", stt_service=fake_stt)

    fetched = profile_service.get_profile(profile_a.profile_id)
    assert fetched is not None
    assert fetched.label == "A"

    all_profiles = profile_service.list_profiles()
    assert {p.profile_id for p in all_profiles} == {profile_a.profile_id, profile_b.profile_id}


def test_get_profile_not_found_returns_none(profile_service):
    assert profile_service.get_profile("does-not-exist") is None


@pytest.mark.asyncio
async def test_delete_profile_removes_metadata_and_audio_file(profile_service, fake_stt):
    filename = profile_service.save_uploaded_sample(b"fake-wav-bytes", ext=".wav")
    profile = await profile_service.create_profile(filename, label="待刪除", stt_service=fake_stt)

    deleted = profile_service.delete_profile(profile.profile_id)
    assert deleted is True
    assert profile_service.get_profile(profile.profile_id) is None


def test_delete_nonexistent_profile_returns_false(profile_service):
    assert profile_service.delete_profile("does-not-exist") is False


@pytest.mark.asyncio
async def test_auto_transcribe_failure_does_not_block_profile_creation(profile_service):
    class _BrokenSTT:
        async def transcribe(self, audio_bytes, language="zh"):
            raise RuntimeError("STT 掛了")

    filename = profile_service.save_uploaded_sample(b"fake-wav-bytes", ext=".wav")
    profile = await profile_service.create_profile(
        filename, label="轉錄失敗案例", stt_service=_BrokenSTT()
    )

    assert profile.reference_text == ""
    assert profile.profile_id

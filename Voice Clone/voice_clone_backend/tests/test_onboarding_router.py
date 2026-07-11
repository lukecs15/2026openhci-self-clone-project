"""
test_onboarding_router.py — 驗證 routers/onboarding.py 的 REST 端點行為。

用 FastAPI TestClient 直接打 app，但把 onboarding_session_service /
voice_profile_service 換成注入 tmp_path 的假物件（monkeypatch 掉
get_onboarding_session_service() / get_voice_profile_service()，避免
真的呼叫 STT 自動轉錄或碰到全域單例污染其他測試）。

涵蓋：
    GET .../{id}          尚未連結 → 404
    POST .../link          成功 → 201/200，回傳 5 位 agent，big_five 格式錯誤 → 400，
                            重複連結 → 409
    POST .../result         尚未連結就結束 → 404，正常回寫 → 200
    GET .../{id}/result     尚未結束 → 409，結束後 → 200 回傳總結+融合波形
"""

import json

import pytest
from fastapi.testclient import TestClient

import routers.onboarding as onboarding_router
import services.onboarding_session_service as onboarding_session_service_module
import services.voice_profile_service as voice_profile_service_module
from main import app
from models.schemas import STTEngineUsed
from services.onboarding_session_service import OnboardingSessionService
from services.stt_service import STTService
from services.voice_profile_service import VoiceProfileService


class _FakeSTTEngine:
    name = STTEngineUsed.MOCK

    async def transcribe(self, audio_bytes: bytes, language: str = "zh") -> str:
        return "假逐字稿"


@pytest.fixture(autouse=True)
def _isolated_services(tmp_path, monkeypatch):
    """把 onboarding router 用到的兩個 service 換成隔離在 tmp_path 的假單例。"""
    voice_profile_service = VoiceProfileService(base_dir=str(tmp_path / "voice_profiles"))
    onboarding_session_service = OnboardingSessionService(base_dir=str(tmp_path / "onboarding_sessions"))

    monkeypatch.setattr(
        voice_profile_service_module, "_voice_profile_service_singleton", voice_profile_service
    )
    monkeypatch.setattr(
        onboarding_session_service_module,
        "_onboarding_session_service_singleton",
        onboarding_session_service,
    )

    # create_profile() 預設會呼叫真正的 STTService 單例自動轉錄，測試環境用假引擎替換掉。
    fake_stt = STTService(primary_engine=_FakeSTTEngine(), fallback_engine=_FakeSTTEngine())
    original_create_profile = VoiceProfileService.create_profile

    async def _create_profile_with_fake_stt(self, sample_filename, label="", reference_text="", stt_service=None):
        return await original_create_profile(
            self, sample_filename, label=label, reference_text=reference_text, stt_service=fake_stt
        )

    monkeypatch.setattr(VoiceProfileService, "create_profile", _create_profile_with_fake_stt)

    yield


@pytest.fixture
def client():
    return TestClient(app)


VALID_BIG_FIVE = {
    "openness": 80,
    "conscientiousness": 40,
    "extraversion": 60,
    "agreeableness": 55,
    "neuroticism": 30,
}


def _link(client, session_id="sess-1", big_five=None):
    return client.post(
        f"/api/onboarding-sessions/{session_id}/link",
        data={"big_five": json.dumps(big_five or VALID_BIG_FIVE), "label": "我的聲音"},
        files={"file": ("sample.wav", b"fake-wav-bytes", "audio/wav")},
    )


def test_get_session_before_link_returns_404(client):
    resp = client.get("/api/onboarding-sessions/does-not-exist")
    assert resp.status_code == 404


def test_link_creates_five_self_agents(client):
    resp = _link(client)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "linked"
    assert len(body["agents"]) == 5
    agent_ids = {a["agent_id"] for a in body["agents"]}
    assert agent_ids == {
        "self-openness",
        "self-conscientiousness",
        "self-extraversion",
        "self-agreeableness",
        "self-neuroticism",
    }
    # 5 位共用同一個聲音克隆 profile
    voice_profile_ids = {a["voice_profile_id"] for a in body["agents"]}
    assert len(voice_profile_ids) == 1
    assert list(voice_profile_ids)[0] == body["voice_profile_id"]


def test_link_invalid_big_five_json_returns_400(client):
    resp = client.post(
        "/api/onboarding-sessions/sess-1/link",
        data={"big_five": "not-json"},
        files={"file": ("sample.wav", b"data", "audio/wav")},
    )
    assert resp.status_code == 400


def test_link_empty_audio_file_returns_400(client):
    resp = client.post(
        "/api/onboarding-sessions/sess-1/link",
        data={"big_five": json.dumps(VALID_BIG_FIVE)},
        files={"file": ("sample.wav", b"", "audio/wav")},
    )
    assert resp.status_code == 400


def test_relink_same_session_returns_409(client):
    first = _link(client, session_id="sess-dup")
    assert first.status_code == 200
    second = _link(client, session_id="sess-dup")
    assert second.status_code == 409


def test_get_session_after_link_returns_linked_status(client):
    _link(client, session_id="sess-2")
    resp = client.get("/api/onboarding-sessions/sess-2")
    assert resp.status_code == 200
    assert resp.json()["status"] == "linked"


def test_result_before_link_returns_404(client):
    resp = client.post(
        "/api/onboarding-sessions/never-linked/result",
        json={"summary_text": "總結"},
    )
    assert resp.status_code == 404


def test_get_result_before_completed_returns_409(client):
    _link(client, session_id="sess-3")
    resp = client.get("/api/onboarding-sessions/sess-3/result")
    assert resp.status_code == 409


def test_full_flow_link_then_complete_then_fetch_result(client):
    _link(client, session_id="sess-4")

    complete_resp = client.post(
        "/api/onboarding-sessions/sess-4/result",
        json={
            "summary_text": "這是一段美好的自我對話。",
            "waveform_signature": {"frequency": 1.1, "amplitude": 0.3, "hue": 210},
            "participant_agents": [{"agent_id": "self-openness", "display_name": "開放的自我"}],
        },
    )
    assert complete_resp.status_code == 200
    assert complete_resp.json()["status"] == "completed"

    result_resp = client.get("/api/onboarding-sessions/sess-4/result")
    assert result_resp.status_code == 200
    body = result_resp.json()
    assert body["summary_text"] == "這是一段美好的自我對話。"
    assert body["waveform_signature"]["hue"] == 210

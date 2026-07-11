"""
test_onboarding_session_service.py — 驗證 onboarding session 的連結/完成/查詢邏輯。

全部用 tmp_path 隔離檔案系統，不需要真的呼叫聲音克隆/LLM。
"""

import pytest

from models.schemas import AgentConfig, BigFiveScores, OnboardingResult
from services.onboarding_session_service import (
    OnboardingSessionAlreadyLinkedError,
    OnboardingSessionNotLinkedError,
    OnboardingSessionService,
)


@pytest.fixture
def session_service(tmp_path):
    return OnboardingSessionService(base_dir=str(tmp_path / "onboarding_sessions"))


@pytest.fixture
def sample_scores():
    return BigFiveScores(
        openness=70, conscientiousness=40, extraversion=60, agreeableness=55, neuroticism=30
    )


@pytest.fixture
def sample_agents():
    return [
        AgentConfig(agent_id="self-openness", display_name="開放的自我", persona_prompt="..."),
        AgentConfig(agent_id="self-conscientiousness", display_name="自律的自我", persona_prompt="..."),
    ]


def test_get_session_before_link_returns_none(session_service):
    assert session_service.get_session("sess-1") is None


def test_link_session_creates_linked_session(session_service, sample_scores, sample_agents):
    session = session_service.link_session("sess-1", sample_scores, "profile-abc", sample_agents)

    assert session.status == "linked"
    assert session.session_id == "sess-1"
    assert session.voice_profile_id == "profile-abc"
    assert session.big_five_scores.openness == 70
    assert [a.agent_id for a in session.agents] == ["self-openness", "self-conscientiousness"]
    assert session.linked_at != ""
    assert session.result is None


def test_link_session_persists_and_is_retrievable(session_service, sample_scores, sample_agents):
    session_service.link_session("sess-1", sample_scores, "profile-abc", sample_agents)

    fetched = session_service.get_session("sess-1")
    assert fetched is not None
    assert fetched.status == "linked"
    assert fetched.voice_profile_id == "profile-abc"


def test_relink_without_flag_raises(session_service, sample_scores, sample_agents):
    session_service.link_session("sess-1", sample_scores, "profile-abc", sample_agents)
    with pytest.raises(OnboardingSessionAlreadyLinkedError):
        session_service.link_session("sess-1", sample_scores, "profile-xyz", sample_agents)


def test_relink_with_allow_flag_overwrites(session_service, sample_scores, sample_agents):
    session_service.link_session("sess-1", sample_scores, "profile-abc", sample_agents)
    updated = session_service.link_session(
        "sess-1", sample_scores, "profile-xyz", sample_agents, allow_relink=True
    )
    assert updated.voice_profile_id == "profile-xyz"


def test_complete_session_before_link_raises(session_service):
    result = OnboardingResult(summary_text="總結")
    with pytest.raises(OnboardingSessionNotLinkedError):
        session_service.complete_session("sess-not-linked", result)


def test_complete_session_after_link_sets_completed_status(
    session_service, sample_scores, sample_agents
):
    session_service.link_session("sess-1", sample_scores, "profile-abc", sample_agents)

    result = OnboardingResult(
        summary_text="這是一段美好的自我對話。",
        waveform_signature={"frequency": 1.2, "amplitude": 0.3, "hue": 200},
        participant_agents=[{"agent_id": "self-openness", "display_name": "開放的自我"}],
    )
    completed = session_service.complete_session("sess-1", result)

    assert completed.status == "completed"
    assert completed.result.summary_text == "這是一段美好的自我對話。"
    assert completed.completed_at != ""

    fetched = session_service.get_session("sess-1")
    assert fetched.status == "completed"
    assert fetched.result.waveform_signature["hue"] == 200


def test_delete_session_removes_it(session_service, sample_scores, sample_agents):
    session_service.link_session("sess-1", sample_scores, "profile-abc", sample_agents)
    assert session_service.delete_session("sess-1") is True
    assert session_service.get_session("sess-1") is None


def test_delete_nonexistent_session_returns_false(session_service):
    assert session_service.delete_session("does-not-exist") is False

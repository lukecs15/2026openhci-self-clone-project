"""
tests/test_debate_pipeline.py — pipeline/debate_pipeline.py 組裝邏輯測試
"""

import pytest

import pipeline.debate_pipeline as debate_pipeline_module
from agents.debate import DEFAULT_DEBATE_TOPICS
from config import Settings
from pipeline.debate_pipeline import build_debate_session, build_test_debate_session
from services.llm_service import MockLLMService
from services.tts_service import MockTTSService


def test_build_test_debate_session_seeds_topic_and_uses_mocks(sample_agents):
    session = build_test_debate_session(
        session_id="session-1",
        agent_a=sample_agents[0],
        agent_b=sample_agents[1],
        topic=DEFAULT_DEBATE_TOPICS["failure"],
    )

    assert session.session_id == "session-1"
    assert isinstance(session.orchestrator.llm_service, MockLLMService)
    assert isinstance(session.orchestrator.tts_service, MockTTSService)
    assert len(session.orchestrator.history) == 1  # open_debate() 已自動呼叫


@pytest.mark.asyncio
async def test_build_test_debate_session_runs_end_to_end(sample_agents):
    session = build_test_debate_session(
        session_id="session-2",
        agent_a=sample_agents[0],
        agent_b=sample_agents[1],
        topic=DEFAULT_DEBATE_TOPICS["procrastination"],
    )

    events = [e async for e in session.orchestrator.run_next_turn()]
    event_types = [e["type"] for e in events]

    assert event_types[0] == "agent_speaking_start"
    assert "agent_speaking_chunk" in event_types
    assert event_types[-1] == "agent_speaking_end"


def test_build_debate_session_reads_max_turns_from_settings(monkeypatch, sample_agents):
    custom_settings = Settings(debate_max_turns=3)
    monkeypatch.setattr(debate_pipeline_module, "get_settings", lambda: custom_settings)

    session = build_debate_session(
        session_id="session-3",
        agent_a=sample_agents[0],
        agent_b=sample_agents[1],
        topic=DEFAULT_DEBATE_TOPICS["boundaries"],
        llm_service=MockLLMService(),
        tts_service=MockTTSService(),
    )

    assert session.orchestrator.max_turns == 3


def test_build_debate_session_reads_max_pacing_seconds_from_settings(monkeypatch, sample_agents):
    custom_settings = Settings(debate_max_pacing_seconds=3.5)
    monkeypatch.setattr(debate_pipeline_module, "get_settings", lambda: custom_settings)

    session = build_debate_session(
        session_id="session-4",
        agent_a=sample_agents[0],
        agent_b=sample_agents[1],
        topic=DEFAULT_DEBATE_TOPICS["boundaries"],
        llm_service=MockLLMService(),
        tts_service=MockTTSService(),
    )

    assert session.orchestrator.max_pacing_seconds == 3.5

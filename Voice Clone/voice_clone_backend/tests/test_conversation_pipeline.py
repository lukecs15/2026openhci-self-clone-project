"""test_conversation_pipeline.py — 驗證 pipeline 組裝層。"""

import pytest

import pipeline.conversation_pipeline as conversation_pipeline_module
from config import Settings
from pipeline.conversation_pipeline import (
    _resolve_default_llm_service,
    build_conversation_session,
    build_test_conversation_session,
)
from services.llm_service import LLMService, MockLLMService
from services.stt_service import MockSTTEngine, STTService
from services.tts_service import MockTTSService


@pytest.mark.asyncio
async def test_build_test_session_end_to_end_text_flow(sample_agents):
    session = build_test_conversation_session(session_id="test-session-1", agents=sample_agents)

    events = [e async for e in session.handle_user_text("大家好，介紹一下自己")]
    event_types = {e["type"] for e in events}

    assert "routing_decision" in event_types
    assert "agent_speaking_chunk" in event_types


@pytest.mark.asyncio
async def test_build_test_session_end_to_end_audio_flow(sample_agents):
    session = build_test_conversation_session(session_id="test-session-2", agents=sample_agents)

    events = [e async for e in session.handle_user_audio(b"fake-audio-bytes")]

    assert events[0]["type"] == "user_transcript"
    assert events[0]["text"]  # mock STT 應回傳非空字串
    assert any(e["type"] == "agent_speaking_start" for e in events)


# ─────────────────────────────────────────────────────────────────────────────
# _resolve_default_llm_service — 修過的耦合問題：LLM 的 mock 與否現在只看
# 是否已填 API key，不再被 TTS_ENGINE=mock 連帶影響。
# ─────────────────────────────────────────────────────────────────────────────

def test_resolve_default_llm_service_uses_mock_when_no_api_key():
    settings = Settings(
        gemini_api_key="", openai_api_key="", llm_provider="gemini", force_mock_llm=False
    )
    service = _resolve_default_llm_service(settings)
    assert isinstance(service, MockLLMService)


def test_resolve_default_llm_service_uses_real_llm_when_api_key_present():
    settings = Settings(
        gemini_api_key="fake-real-key", llm_provider="gemini", force_mock_llm=False
    )
    service = _resolve_default_llm_service(settings)
    assert isinstance(service, LLMService)
    assert not isinstance(service, MockLLMService)


def test_resolve_default_llm_service_force_mock_overrides_api_key():
    settings = Settings(
        gemini_api_key="fake-real-key", llm_provider="gemini", force_mock_llm=True
    )
    service = _resolve_default_llm_service(settings)
    assert isinstance(service, MockLLMService)


def test_resolve_default_llm_service_respects_openai_provider_key():
    settings = Settings(
        llm_provider="openai", openai_api_key="fake-openai-key", gemini_api_key="", force_mock_llm=False
    )
    service = _resolve_default_llm_service(settings)
    assert isinstance(service, LLMService)
    assert not isinstance(service, MockLLMService)


# ─────────────────────────────────────────────────────────────────────────────
# build_conversation_session — routing_strategy fallback（修過的 bug，見
# routers/ws_voice_agents.py 的說明：過去前端沒有明確指定 routing_strategy
# 時，WebSocket 路由會用 `msg.routing_strategy or "heuristic"` 寫死蓋掉
# 後端 .env 的 AGENT_ROUTING_STRATEGY，導致就算後端設定 llm_decision，
# 前端沒有主動指定策略時實際生效的永遠是 heuristic）。
# ─────────────────────────────────────────────────────────────────────────────

def _mock_dependencies():
    return dict(
        stt_service=STTService(primary_engine=MockSTTEngine(), fallback_engine=MockSTTEngine()),
        llm_service=MockLLMService(),
        tts_service=MockTTSService(),
    )


def test_build_conversation_session_falls_back_to_backend_setting_when_none(
    monkeypatch, sample_agents
):
    """
    routing_strategy=None（模擬前端 init_session 完全沒帶這個欄位）時，
    應該採用後端 settings.agent_routing_strategy，不是被硬編碼成 "heuristic"。
    """
    custom_settings = Settings(agent_routing_strategy="llm_decision")
    monkeypatch.setattr(conversation_pipeline_module, "get_settings", lambda: custom_settings)

    session = build_conversation_session(
        session_id="test-session-none",
        agents=sample_agents,
        routing_strategy=None,
        **_mock_dependencies(),
    )

    assert session.orchestrator.handoff.strategy == "llm_decision"


def test_build_conversation_session_client_explicit_strategy_overrides_backend_setting(
    monkeypatch, sample_agents
):
    """對照組：前端明確指定 routing_strategy 時，應該優先採用前端指定的值，覆蓋後端預設。"""
    custom_settings = Settings(agent_routing_strategy="llm_decision")
    monkeypatch.setattr(conversation_pipeline_module, "get_settings", lambda: custom_settings)

    session = build_conversation_session(
        session_id="test-session-explicit",
        agents=sample_agents,
        routing_strategy="heuristic",
        **_mock_dependencies(),
    )

    assert session.orchestrator.handoff.strategy == "heuristic"

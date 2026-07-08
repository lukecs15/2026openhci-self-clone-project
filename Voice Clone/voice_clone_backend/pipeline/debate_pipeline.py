"""
pipeline/debate_pipeline.py — 辯論模式管線組裝

跟 pipeline/conversation_pipeline.py 同樣屬於「膠水層」：把 services/
（LLM、TTS；辯論模式不需要 STT，使用者只用文字插話）與
agents/debate.py 的 DebateOrchestrator 依 config.py 的設定組裝成一個
可直接被 routers/ws_debate.py 呼叫的 DebateSession。

LLM 是否使用真正的雲端服務（而非 MockLLMService）沿用跟一般多 Agent
對話「完全相同」的判斷邏輯（_resolve_default_llm_service，直接從
conversation_pipeline 匯入複用，避免兩處各自維護一份容易產生分歧）：
只要目前 llm_provider 對應的 API key 有填就會自動使用真正的雲端 LLM。
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, Optional

from agents.debate import DebateOrchestrator, DebateTopic
from config import get_settings
from pipeline.conversation_pipeline import _resolve_default_llm_service
from models.schemas import AgentConfig
from services.llm_service import LLMService, MockLLMService
from services.tts_service import MockTTSService, TTSService, get_tts_service

logger = logging.getLogger(__name__)


class DebateSession:
    """單一 WebSocket 連線對應的辯論 session，包住一個 DebateOrchestrator。"""

    def __init__(self, session_id: str, orchestrator: DebateOrchestrator):
        self.session_id = session_id
        self.orchestrator = orchestrator


async def _instant_pacing_sleep(seconds: float) -> None:
    """測試／CI 用的立即完成版 pacing sleep，見 build_test_debate_session()。"""
    return None


def build_debate_session(
    session_id: str,
    agent_a: AgentConfig,
    agent_b: AgentConfig,
    topic: DebateTopic,
    llm_service: Optional[LLMService] = None,
    tts_service: Optional[TTSService] = None,
    pacing_sleep_fn: Optional[Callable[[float], Awaitable[Any]]] = None,
) -> DebateSession:
    """
    依 config.py 目前的設定組裝一個 DebateSession，並呼叫 open_debate()
    把主題塞進歷史（呼叫端不需要另外記得要呼叫這一步）。

    pacing_sleep_fn 不傳時，DebateOrchestrator 會用真正的 asyncio.sleep
    做節奏控制（見 agents/debate.py 檔案開頭「節奏控制」說明）；
    build_test_debate_session() 會傳入立即完成的版本，讓測試套件不會被
    真的拖慢。
    """
    settings = get_settings()
    orchestrator = DebateOrchestrator(
        agent_a=agent_a,
        agent_b=agent_b,
        topic=topic,
        llm_service=llm_service or _resolve_default_llm_service(settings),
        tts_service=tts_service or get_tts_service(),
        max_turns=settings.debate_max_turns,
        max_pacing_seconds=settings.debate_max_pacing_seconds,
        pacing_sleep_fn=pacing_sleep_fn,
    )
    orchestrator.open_debate()
    return DebateSession(session_id=session_id, orchestrator=orchestrator)


def build_test_debate_session(
    session_id: str, agent_a: AgentConfig, agent_b: AgentConfig, topic: DebateTopic
) -> DebateSession:
    """
    測試用：完全不依賴外部 API 的 session（mock LLM/TTS），供 pytest 使用。
    節奏控制 sleep 也換成立即完成版本，避免測試因為節奏控制而變慢。
    """
    return build_debate_session(
        session_id=session_id,
        agent_a=agent_a,
        agent_b=agent_b,
        topic=topic,
        llm_service=MockLLMService(),
        tts_service=MockTTSService(),
        pacing_sleep_fn=_instant_pacing_sleep,
    )

"""
pipeline/debate_pipeline.py — 辯論模式管線組裝

跟 pipeline/conversation_pipeline.py 同樣屬於「膠水層」：把 services/
（LLM、TTS、STT）與 agents/debate.py 的 DebateOrchestrator 依 config.py
的設定組裝成一個可直接被 routers/ws_debate.py 呼叫的 DebateSession。

LLM 是否使用真正的雲端服務（而非 MockLLMService）沿用跟一般多 Agent
對話「完全相同」的判斷邏輯（_resolve_default_llm_service，直接從
conversation_pipeline 匯入複用，避免兩處各自維護一份容易產生分歧）：
只要目前 llm_provider 對應的 API key 有填就會自動使用真正的雲端 LLM。

── STT（VR 版新增，見 voice_clone_unity 系統設計文件）─────────────────────
網頁版辯論模式原本刻意不需要 STT（使用者只用文字/瀏覽器端 Web Speech API
插話，見 agents/debate.py 檔案開頭說明）。VR 版的法官敲法槌插話改用語音，
沒有瀏覽器可以本地辨識，因此這裡補上 stt_service，供
`DebateSession.transcribe_intervention_audio()` 使用——跟一般多 Agent
對話（`MultiAgentOrchestrator.transcribe_user_audio()`）共用同一顆
`get_stt_service()` 單例，不是另外接一套辨識邏輯。網頁版前端目前仍然只走
純文字插話，不受影響。
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, Optional

from agents.debate import DebateOrchestrator, DebateTopic
from config import get_settings
from pipeline.conversation_pipeline import _resolve_default_llm_service
from models.schemas import AgentConfig
from services.llm_service import LLMService, MockLLMService
from services.stt_service import STTService, get_stt_service
from services.tts_service import MockTTSService, TTSService, get_tts_service

logger = logging.getLogger(__name__)


class DebateSession:
    """單一 WebSocket 連線對應的辯論 session，包住一個 DebateOrchestrator。"""

    def __init__(
        self,
        session_id: str,
        orchestrator: DebateOrchestrator,
        stt_service: Optional[STTService] = None,
    ):
        self.session_id = session_id
        self.orchestrator = orchestrator
        # 留空也不會壞：只有呼叫 transcribe_intervention_audio() 時才會用到，
        # 網頁版純文字插話流程完全不會碰到這個欄位。
        self.stt_service = stt_service

    async def generate_summary(self) -> str:
        """薄封裝，委派給 orchestrator.generate_summary()（見
        routers/ws_debate.py 的 end_session 處理）。"""
        return await self.orchestrator.generate_summary()

    async def generate_verdict(self) -> dict:
        """薄封裝，委派給 orchestrator.generate_verdict()（內在法庭判決書，
        見 routers/ws_debate.py 的 end_session 處理）。"""
        return await self.orchestrator.generate_verdict()

    async def transcribe_intervention_audio(self, audio_bytes: bytes) -> dict:
        """
        VR 語音插話用：把錄音轉成文字，回傳格式比照
        MultiAgentOrchestrator.transcribe_user_audio()，方便
        routers/ws_debate.py 直接組成 `user_transcript` 事件送給前端。
        不在這裡順便呼叫 orchestrator.inject_user_message()——轉錄跟「是否
        要當作插話送出」是兩個步驟，交給呼叫端（ws_debate.py）決定，跟
        `user_intervene`（純文字）的處理路徑保持一致，也方便呼叫端在轉錄
        結果是空字串時可以選擇不送出插話。
        """
        service = self.stt_service or get_stt_service()
        result = await service.transcribe(audio_bytes)
        return {
            "type": "user_transcript",
            "text": result.text,
            "engine_used": result.engine_used.value,
            "used_fallback": result.used_fallback,
        }


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
    stt_service: Optional[STTService] = None,
    pacing_sleep_fn: Optional[Callable[[float], Awaitable[Any]]] = None,
) -> DebateSession:
    """
    依 config.py 目前的設定組裝一個 DebateSession，並呼叫 open_debate()
    把主題塞進歷史（呼叫端不需要另外記得要呼叫這一步）。

    pacing_sleep_fn 不傳時，DebateOrchestrator 會用真正的 asyncio.sleep
    做節奏控制（見 agents/debate.py 檔案開頭「節奏控制」說明）；
    build_test_debate_session() 會傳入立即完成的版本，讓測試套件不會被
    真的拖慢。

    stt_service 不傳時延遲用 get_stt_service() 單例（真的需要時才建立，
    避免只走純文字插話的網頁版流程也要付出建立 STT 引擎的成本）——見
    DebateSession.transcribe_intervention_audio()。
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
    return DebateSession(session_id=session_id, orchestrator=orchestrator, stt_service=stt_service)


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

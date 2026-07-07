"""
pipeline/conversation_pipeline.py — 多 Agent 語音對話管線組裝

對照架構文件 2.1 節整體管線：
    使用者聲音 → VAD/斷句 → STT（本地）→ LLM 回覆生成（雲端串流）
    → Pipecat pipeline 逐句斷句轉發 → CosyVoice 2 TTS（本地串流合成）→ 音訊播放

本檔案負責把 services/（STT、LLM、TTS）與 agents/（Handoff、Job Group、
Orchestrator）依 config.py 的設定組裝成一個可直接被 WebSocket 路由呼叫的
ConversationSession，屬於「膠水層」，不包含任何業務邏輯本身。

STT / LLM / TTS 的 mock 與否是各自獨立判斷的（修過的耦合問題，見 config.py
開頭說明）：
    - STT：一律走 services.stt_service 的雙引擎邏輯。
    - LLM：_resolve_default_llm_service() 偵測目前 provider 是否已填 API key，
      有填就用真正的雲端 LLMService；沒填就自動 fallback 成 MockLLMService，
      讓「沒設定任何金鑰的全新環境」也能直接跑起來，同時「填了金鑰」的環境
      會自動變成真的呼叫 Gemini/OpenAI，不需要額外切換任何 TTS 相關設定。
    - TTS：由 get_tts_service() 依 tts_engine 決定。

VAD（語音活動偵測）/ 斷句：
    本骨架假設前端已經做好「一段完整語音」的切分再送出 user_audio 事件
    （最簡單的作法）；正式導入 Pipecat 後，VAD 應該用 Pipecat 內建的
    turn-detection processor 取代，由後端即時串流偵測語音起訖，
    見架構文件待辦事項 5（前端與傳輸層選型）。
"""

from __future__ import annotations

import logging
from typing import AsyncIterator, Optional

from agents.orchestrator import MultiAgentOrchestrator
from config import Settings, get_settings
from models.schemas import AgentConfig
from services.llm_service import LLMService, MockLLMService
from services.stt_service import STTService, get_stt_service
from services.tts_service import MockTTSService, TTSService, get_tts_service

logger = logging.getLogger(__name__)


class ConversationSession:
    """
    單一 WebSocket 連線對應的對話 session，包住一個 MultiAgentOrchestrator。
    """

    def __init__(self, session_id: str, orchestrator: MultiAgentOrchestrator):
        self.session_id = session_id
        self.orchestrator = orchestrator

    async def handle_user_audio(self, audio_bytes: bytes) -> AsyncIterator[dict]:
        transcript_event = await self.orchestrator.transcribe_user_audio(audio_bytes)
        yield transcript_event
        async for event in self.orchestrator.handle_user_text(transcript_event["text"]):
            yield event

    async def handle_user_text(self, text: str) -> AsyncIterator[dict]:
        async for event in self.orchestrator.handle_user_text(text):
            yield event


def _resolve_default_llm_service(settings: Settings) -> LLMService:
    """
    決定沒有手動注入 llm_service 時該用真正的雲端 LLM 還是 MockLLMService。

    修過的耦合問題：過去 WebSocket 路由是「TTS_ENGINE=mock 就連 LLM 也一起
    用 MockLLMService」，導致就算 .env 填了真正的 GEMINI_API_KEY，在 dev
    （TTS 用 mock）環境下也永遠不會真的呼叫 Gemini。現在 LLM 只看「目前
    provider 是否已經填了 API key」（settings.has_llm_api_key），跟 TTS
    要不要 mock 完全無關；force_mock_llm=true 可以強制一律使用 mock。
    """
    if settings.force_mock_llm:
        logger.info("force_mock_llm=true，LLM 使用 MockLLMService")
        return MockLLMService()

    if settings.has_llm_api_key:
        return LLMService()

    logger.warning(
        "尚未設定 %s 的 API key，LLM 自動改用 MockLLMService（只會回覆固定測試文字）。"
        "填入 .env 對應的 API key 後會自動改用真正的雲端 LLM。",
        settings.llm_provider,
    )
    return MockLLMService()


def build_conversation_session(
    session_id: str,
    agents: list[AgentConfig],
    routing_strategy: Optional[str] = None,
    stt_service: Optional[STTService] = None,
    llm_service: Optional[LLMService] = None,
    tts_service: Optional[TTSService] = None,
) -> ConversationSession:
    """
    依 config.py 目前的設定組裝一個 ConversationSession。

    未特別注入依賴時：
        - STT 使用 services.stt_service 的雙引擎單例（依 profile 決定 primary/fallback）
        - LLM 依 _resolve_default_llm_service()：有填 API key 用真正的雲端 LLM，沒填用 mock
        - TTS 依 tts_engine 設定選擇 CosyVoiceTTSService 或 MockTTSService

    這個函式現在是 WebSocket 路由的唯一組裝入口（不再區分「完全真實」跟
    「完全 mock」兩條路，三個依賴各自獨立決定要不要 mock）。
    """
    settings = get_settings()
    orchestrator = MultiAgentOrchestrator(
        agents=agents,
        stt_service=stt_service or get_stt_service(),
        llm_service=llm_service or _resolve_default_llm_service(settings),
        tts_service=tts_service or get_tts_service(),
        routing_strategy=routing_strategy or settings.agent_routing_strategy,
        max_concurrent_agents=settings.max_concurrent_agents,
    )
    return ConversationSession(session_id=session_id, orchestrator=orchestrator)


def build_test_conversation_session(
    session_id: str, agents: list[AgentConfig], routing_strategy: str = "heuristic"
) -> ConversationSession:
    """
    組裝一個完全不依賴外部模型/API 的 session（mock STT/LLM/TTS）。

    保留給測試（tests/test_conversation_pipeline.py 等）與想要「完全離線
    demo，不管有沒有填 API key 都不打真的網路」情境使用；一般執行時
    （routers/ws_voice_agents.py）改用 build_conversation_session()，
    讓 STT/LLM/TTS 各自依設定決定要不要 mock。
    """
    from services.stt_service import MockSTTEngine

    mock_stt = STTService(
        primary_engine=MockSTTEngine(), fallback_engine=MockSTTEngine(), primary_timeout_ms=1000
    )
    return build_conversation_session(
        session_id=session_id,
        agents=agents,
        routing_strategy=routing_strategy,
        stt_service=mock_stt,
        llm_service=MockLLMService(),
        tts_service=MockTTSService(),
    )

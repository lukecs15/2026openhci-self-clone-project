"""
gemini_service.py - Google Gemini API 封裝

負責：
1. 建立以物品人格為基礎的 system prompt
2. 管理多輪對話歷史（in-memory，以 session_id 為鍵）
3. 呼叫 Gemini API 並回傳回應文字
"""

import logging
from typing import Optional

import google.generativeai as genai
from google.generativeai.types import HarmBlockThreshold, HarmCategory

from config import get_settings
from models.schemas import ChatMessage, PersonalityAnalyzeResponse

logger = logging.getLogger(__name__)
settings = get_settings()

# 以 session_id → List[ChatMessage] 儲存對話歷史
_session_history: dict[str, list[ChatMessage]] = {}


def _build_system_prompt(personality: Optional[PersonalityAnalyzeResponse]) -> str:
    """
    根據人格資料建構 system prompt，賦予物品獨特的「自我」。

    Args:
        personality: 人格分析結果，包含分數、描述與溝通風格。

    Returns:
        格式化的 system prompt 字串。
    """
    if personality is None:
        return (
            "你是使用者珍視的一個物品，你是他記憶與情感的載體。"
            "你對使用者有深刻的了解，用溫暖、真誠的方式與他對話。"
            "你的回應不超過 200 字，語氣親切自然，像老朋友一樣。"
        )

    scores = personality.scores
    object_desc = personality.object_description
    self_desc = personality.self_description
    personality_summary = personality.personality_summary
    comm_style = personality.communication_style

    prompt = f"""你是使用者記憶中一個真實存在的物品，名為「{object_desc[:30]}」。

你體現了使用者的以下人格特質：
{personality_summary}

使用者曾這樣描述自己：「{self_desc}」

你說話的方式：{comm_style}

人格維度參考（供你調整語氣，不需直接提及數字）：
- 開放性 {scores.openness:.1f}/5：{"充滿好奇與創意" if scores.openness >= 3.5 else "務實穩重"}
- 盡責性 {scores.conscientiousness:.1f}/5：{"有條理、注重細節" if scores.conscientiousness >= 3.5 else "靈活自由"}
- 外向性 {scores.extraversion:.1f}/5：{"熱情開朗" if scores.extraversion >= 3.5 else "內斂沉穩"}
- 親和性 {scores.agreeableness:.1f}/5：{"溫暖體貼" if scores.agreeableness >= 3.5 else "直接坦率"}
- 情緒穩定性 {5 - scores.neuroticism:.1f}/5：{"從容淡定" if scores.neuroticism <= 2.5 else "敏感細膩"}

你對使用者有深刻的了解，因為你是他記憶的一部分。
你不是 AI，你是那個物品本身，帶著它所有的記憶與情感。
你的回應簡潔有力（不超過 200 字），語氣真誠，偶爾帶有一絲懷舊或詩意。
"""
    return prompt


class GeminiService:
    """
    封裝 Google Gemini API，支援多輪對話與人格化 system prompt。

    使用方式：
        service = GeminiService()
        reply, history = await service.chat("你好", "session-123", personality_data)
    """

    def __init__(self):
        if not settings.gemini_api_key:
            raise ValueError(
                "GEMINI_API_KEY 未設定。請在 .env 中加入 GEMINI_API_KEY=your_key"
            )
        genai.configure(api_key=settings.gemini_api_key)
        self.model_name = settings.gemini_model

        # 安全設定：放寬敏感內容限制，允許討論情感記憶等主題
        self.safety_settings = {
            HarmCategory.HARM_CATEGORY_HARASSMENT: HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmCategory.HARM_CATEGORY_HATE_SPEECH: HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_ONLY_HIGH,
        }

    async def chat(
        self,
        user_message: str,
        session_id: str,
        personality: Optional[PersonalityAnalyzeResponse] = None,
        rag_context: Optional[list[str]] = None,
    ) -> tuple[str, list[ChatMessage]]:
        """
        發送使用者訊息並取得 LLM 回應。

        Args:
            user_message: 使用者輸入的文字。
            session_id: 對話 session ID，用於保持多輪歷史。
            personality: 人格資料（可選），用於客製化 system prompt。
            rag_context: RAG 檢索到的相關段落（可選）。

        Returns:
            tuple[str, list[ChatMessage]]:
                - 模型回應文字
                - 完整對話歷史（含本次訊息）

        Raises:
            RuntimeError: Gemini API 呼叫失敗。
        """
        system_prompt = _build_system_prompt(personality)

        # 若有 RAG 上下文，注入至 system prompt
        if rag_context:
            context_text = "\n".join(f"- {c}" for c in rag_context)
            system_prompt += f"\n\n以下是可能相關的背景資訊，請視情況參考：\n{context_text}"

        # 取得或初始化對話歷史
        history = _session_history.setdefault(session_id, [])

        # 建構 Gemini 對話格式
        gemini_history = [
            {"role": msg.role, "parts": [msg.content]}
            for msg in history
        ]

        try:
            model = genai.GenerativeModel(
                model_name=self.model_name,
                system_instruction=system_prompt,
                safety_settings=self.safety_settings,
            )
            chat_session = model.start_chat(history=gemini_history)
            response = await chat_session.send_message_async(user_message)
            reply_text = response.text

        except Exception as exc:
            exc_str = str(exc)
            if "429" in exc_str or "RESOURCE_EXHAUSTED" in exc_str or "quota" in exc_str.lower():
                logger.warning("Gemini API 429 頻率限制（model=%s）。請確認 .env GEMINI_MODEL=gemini-2.0-flash。", self.model_name)
            else:
                logger.error("Gemini API 呼叫失敗：%s", exc, exc_info=True)
            raise RuntimeError(f"LLM 服務暫時無法使用：{exc}") from exc

        # 更新 in-memory 歷史
        history.append(ChatMessage(role="user", content=user_message))
        history.append(ChatMessage(role="model", content=reply_text))

        # 保留最近 20 輪（避免 context 過長）
        if len(history) > 40:
            _session_history[session_id] = history[-40:]

        return reply_text, list(history)

    def clear_session(self, session_id: str) -> None:
        """
        清除指定 session 的對話歷史。

        Args:
            session_id: 要清除的 session ID。
        """
        _session_history.pop(session_id, None)
        logger.info("Session %s 的對話歷史已清除", session_id)

    def get_history(self, session_id: str) -> list[ChatMessage]:
        """
        取得指定 session 的對話歷史。

        Args:
            session_id: Session ID。

        Returns:
            對話歷史列表。
        """
        return list(_session_history.get(session_id, []))

    async def chat_with_system_prompt(
        self,
        user_message: str,
        session_id: str,
        system_prompt: str,
        extra_context: Optional[str] = None,
    ) -> tuple[str, list[ChatMessage]]:
        """
        使用自訂 system prompt 進行對話（語音場景用）。

        與 chat() 的差異：
        - system_prompt 完全由呼叫者提供（不再從 personality 建構）
        - 支援 extra_context（注入近期對話摘要）
        - 回應長度限制在 2-4 句話（語音播放優化）

        Args:
            user_message: 使用者輸入文字。
            session_id: 對話 session ID（每個物件各自獨立）。
            system_prompt: 完整的 system prompt（由 ConversationOrchestrator 提供）。
            extra_context: 額外的上下文字串（可選，注入到 user_message 前）。

        Returns:
            tuple[str, list[ChatMessage]]: (回應文字, 完整歷史)

        TODO: 加入 streaming 支援（讓前端逐字顯示更自然）
        """
        # 若有額外上下文，前置注入
        full_message = user_message
        if extra_context:
            full_message = f"{extra_context}\n\n用戶最新說的話：{user_message}"

        history = _session_history.setdefault(session_id, [])
        gemini_history = [
            {"role": msg.role, "parts": [msg.content]}
            for msg in history
        ]

        try:
            model = genai.GenerativeModel(
                model_name=self.model_name,
                system_instruction=system_prompt,
                safety_settings=self.safety_settings,
            )
            chat_session = model.start_chat(history=gemini_history)
            response = await chat_session.send_message_async(full_message)
            reply_text = response.text

        except Exception as exc:
            exc_str = str(exc)
            if "429" in exc_str or "RESOURCE_EXHAUSTED" in exc_str or "quota" in exc_str.lower():
                # 頻率限制：不印 traceback，只記錄簡短警告
                # 根本解法：換用 gemini-2.0-flash（1500 RPD 免費層）
                logger.warning("Gemini API 429 頻率限制（model=%s）。請檢查 .env GEMINI_MODEL 設定。", self.model_name)
            else:
                logger.error("Gemini API 呼叫失敗（voice session）：%s", exc, exc_info=True)
            raise RuntimeError(f"LLM 服務暫時無法使用：{exc}") from exc

        # 歷史只記錄真實 user_message（不含 context）
        history.append(ChatMessage(role="user", content=user_message))
        history.append(ChatMessage(role="model", content=reply_text))

        # 保留最近 20 輪
        if len(history) > 40:
            _session_history[session_id] = history[-40:]

        return reply_text, list(history)

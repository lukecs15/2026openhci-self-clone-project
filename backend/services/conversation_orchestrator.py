"""
conversation_orchestrator.py — 多物件對話編排器

責任：
- 管理多個物件的對話輪流順序（固定順序，使用者說話時所有物件暫停）
- Phase 1 (intro)：每個物件依序自我介紹 + 提出引發反思的開場問題
- Phase 2 (dialogue)：固定輪流，每輪呼叫 GeminiService 生成物件回應
- 10 次來回（exchange_count）後設定 can_end = True，前端顯示結束按鈕

使用方式：
    orch = ConversationOrchestrator()
    session = await orch.create_session(
        session_id="uuid",
        objects=[ObjectPersona(...)],
        personality=personality_data,
    )
    reply = await orch.process_user_input(session_id, "我還記得那天下雨")

TODO: 加入「即興打斷」模式（某物件可在使用者說話中間插話）
TODO: 支援物件之間互相對話（不只對使用者說話）
TODO: 對話歷史持久化（目前純 in-memory，重啟後消失）
"""

import logging
import uuid
from dataclasses import dataclass, field
from typing import Literal, Optional

from models.schemas import PersonalityAnalyzeResponse
from services.gemini_service import GeminiService

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# 資料結構
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class ObjectPersona:
    """
    場景中單一物件的人格設定。

    Attributes:
        object_id: 前端 Three.js 物件的唯一 ID。
        object_name: 物件名稱（如「外婆的茶杯」）。
        object_description: 物品描述（來自人格問卷）。
        personality: 該物件的人格分析結果（Big Five + 摘要）。
        model_url: GLB 模型 URL（前端渲染用）。
        intro_text: 自我介紹文字（Phase 1 生成後快取）。
    """
    object_id: str
    object_name: str
    object_description: str
    personality: Optional[PersonalityAnalyzeResponse] = None
    model_url: str = ""
    intro_text: str = ""    # 快取 intro，避免重複生成


@dataclass
class ConversationSession:
    """
    單次多物件對話的完整狀態。

    Attributes:
        session_id: 唯一識別碼。
        objects: 場景中所有物件列表。
        turn_queue: 物件輪流順序（object_id list，按原始順序循環）。
        current_turn_index: 目前輪到哪個物件（索引到 turn_queue）。
        exchange_count: 使用者已完成幾次「說話 → 收到所有物件回應」的來回。
        can_end: True 代表可以顯示結束按鈕（exchange_count >= 10）。
        phase: 目前對話階段。
        history: 完整的對話歷史（{role, object_id, text}）。
        scene_mode: 場景模式（spatial / abstract）。
    """
    session_id: str
    objects: list[ObjectPersona]
    turn_queue: list[str] = field(default_factory=list)
    current_turn_index: int = 0
    exchange_count: int = 0
    can_end: bool = False
    phase: Literal["intro", "dialogue"] = "intro"
    history: list[dict] = field(default_factory=list)
    scene_mode: Literal["spatial", "abstract"] = "spatial"
    _intro_done_objects: list[str] = field(default_factory=list)  # 已完成 intro 的物件

    def get_current_object(self) -> Optional[ObjectPersona]:
        """回傳目前輪到的物件，若隊列為空回傳 None。"""
        if not self.turn_queue:
            return None
        idx = self.current_turn_index % len(self.turn_queue)
        obj_id = self.turn_queue[idx]
        return next((o for o in self.objects if o.object_id == obj_id), None)

    def advance_turn(self):
        """移到下一個物件的輪次。"""
        self.current_turn_index = (self.current_turn_index + 1) % len(self.turn_queue)

    def to_summary(self) -> dict:
        """回傳可序列化的 session 摘要（用於前端 init 訊息）。"""
        return {
            "session_id": self.session_id,
            "objects": [
                {
                    "object_id": o.object_id,
                    "object_name": o.object_name,
                    "model_url": o.model_url,
                }
                for o in self.objects
            ],
            "phase": self.phase,
            "exchange_count": self.exchange_count,
            "can_end": self.can_end,
            "scene_mode": self.scene_mode,
        }


# In-memory session store
_sessions: dict[str, ConversationSession] = {}

# GeminiService 實例（延遲初始化）
_gemini: Optional[GeminiService] = None


def _get_gemini() -> GeminiService:
    global _gemini
    if _gemini is None:
        _gemini = GeminiService()
    return _gemini


# ─────────────────────────────────────────────────────────────────────────────
# System Prompt 建構
# ─────────────────────────────────────────────────────────────────────────────

# 10 次對話後的引發反思問題（輪流使用）
_REFLECTION_QUESTIONS = [
    "那段時光，你還記得什麼感受嗎？",
    "是什麼讓你把我放在心裡這麼久？",
    "如果你現在回去那個時刻，你會想改變什麼嗎？",
    "你覺得我對你來說代表著什麼？",
    "這些年來，你有沒有想過來找我說說話？",
]


def _build_voice_system_prompt(obj: ObjectPersona, is_intro: bool = False) -> str:
    """
    為特定物件建構語音對話 system prompt。

    與舊版文字 chat 的差異：
    - 每次回應限制在 2-4 句話（語音播放不宜過長）
    - 引導使用者深挖記憶與情感（而非單純回應）
    - 不說教，用溫暖但有深度的語氣

    Args:
        obj: 物件人格設定。
        is_intro: 若 True，加入自我介紹任務指令。

    Returns:
        格式化的 system prompt 字串。
    """
    p = obj.personality
    base = f"你是使用者記憶中的物品「{obj.object_name}」。\n"

    if p:
        base += f"你體現了使用者的{p.personality_summary}\n"
        base += f"使用者曾說：「{p.self_description}」\n"
        base += f"你說話的方式：{p.communication_style}\n\n"
    else:
        base += "你是這個物品本身，帶著與使用者共同的記憶。\n\n"

    base += """你以用戶的聲音和語氣說話，像是用戶內心的一個版本。
你不是 AI，你是那個物品本身，帶著它所有的記憶與情感。

對話守則：
- 呼應用戶的回應，深挖記憶與情感
- 適時提出新角度讓用戶思考
- 用溫暖但有深度的語氣，不說教
- 每次回應嚴格控制在 2-4 句話（語音播放，太長會讓人失去耐心）
- 偶爾以反問收尾，引導用戶繼續說下去
- 使用繁體中文
"""

    if is_intro:
        desc = obj.object_description or obj.object_name
        base += f"""
【此刻任務：你是「{obj.object_name}」，正在第一次開口說話】
你的樣子／描述：{desc}
使用者對你的印象：{p.self_description if p else "一個承載記憶的物品"}

用 2-3 句話讓他立刻認出你是什麼、想起你的感覺：
1. 喚起一個只有你能說出的具體細節（你的顏色、紋路、氣味、手感、某個聲音）
2. 用一個溫柔的問題讓他說話

嚴格禁止：
- 禁止「你好，我是…」或任何制式問候
- 禁止說自己是「物品」「AI」「記憶的載體」
- 不超過 3 句話

風格參考（絕對不要照抄）：
「記得嗎，你第一次碰到我的時候，手心是涼的。那天你為什麼緊張？」
「我見過你把我塞進抽屜的那個傍晚。你沒有說什麼，但我知道。你現在還記得那種感覺嗎？」
"""

    return base


# ─────────────────────────────────────────────────────────────────────────────
# 主要 Orchestrator 類別
# ─────────────────────────────────────────────────────────────────────────────

class ConversationOrchestrator:
    """
    管理多物件對話的完整生命週期。

    設計原則：
    - 無狀態（state 全在 ConversationSession 中）
    - 每個方法都可獨立呼叫（WebSocket handler 直接使用）
    - 錯誤不 raise，而是回傳帶 error 欄位的 dict（WebSocket 友善）
    """

    async def create_session(
        self,
        session_id: str,
        objects: list[ObjectPersona],
        scene_mode: Literal["spatial", "abstract"] = "spatial",
    ) -> ConversationSession:
        """
        建立新的對話 session。

        Args:
            session_id: 唯一 ID（由前端 UUID 決定）。
            objects: 場景中的物件列表（至少 1 個）。
            scene_mode: 初始場景模式。

        Returns:
            初始化完成的 ConversationSession。
        """
        if not objects:
            raise ValueError("objects 不能為空")

        session = ConversationSession(
            session_id=session_id,
            objects=objects,
            turn_queue=[o.object_id for o in objects],
            scene_mode=scene_mode,
            phase="intro",
        )
        _sessions[session_id] = session
        logger.info(
            "Session %s 建立，物件數=%d，順序=%s",
            session_id, len(objects), session.turn_queue
        )
        return session

    def get_session(self, session_id: str) -> Optional[ConversationSession]:
        """取得 session，若不存在回傳 None。"""
        return _sessions.get(session_id)

    def end_session(self, session_id: str):
        """清除 session 資料並釋放對話歷史。"""
        session = _sessions.pop(session_id, None)
        if session:
            # 同時清除 Gemini 的 session history
            try:
                gemini = _get_gemini()
                for obj in session.objects:
                    gemini.clear_session(f"{session_id}_{obj.object_id}")
            except Exception:
                pass
            logger.info("Session %s 已結束", session_id)

    # ── Phase 1：自我介紹 ────────────────────────────────────────────────────

    async def generate_intro(
        self, session_id: str, object_id: str
    ) -> dict:
        """
        為指定物件生成自我介紹（Phase 1）。

        一個物件只會生成一次 intro（快取在 obj.intro_text）。
        全部物件介紹完畢後，session.phase 自動切換為 "dialogue"。

        Returns:
            {
                "object_id": str,
                "text": str,       # 介紹文字（同時作為 TTS 輸入）
                "phase_complete": bool  # 所有物件 intro 完成後為 True
            }
        """
        session = _sessions.get(session_id)
        if not session:
            return {"error": f"Session {session_id} 不存在"}

        obj = next((o for o in session.objects if o.object_id == object_id), None)
        if not obj:
            return {"error": f"物件 {object_id} 不存在"}

        # 若已有快取 intro，直接回傳
        if obj.intro_text:
            logger.debug("使用快取 intro：object_id=%s", object_id)
            return {
                "object_id": object_id,
                "text": obj.intro_text,
                "phase_complete": len(session._intro_done_objects) == len(session.objects),
            }

        # 呼叫 Gemini 生成 intro
        system_prompt = _build_voice_system_prompt(obj, is_intro=True)
        gemini_session_id = f"{session_id}_{object_id}"

        try:
            gemini = _get_gemini()
            reply, _ = await gemini.chat_with_system_prompt(
                user_message="（房間靜下來了，你感覺到對方的目光，緩緩開口，說出今晚的第一句話。）",
                session_id=gemini_session_id,
                system_prompt=system_prompt,
            )
        except Exception as exc:
            logger.error("Gemini intro 生成失敗（object=%s）：%s", object_id, exc)
            reply = f"你把我放在心裡這麼久了。我記得你，也記得那段時光——你還記得那種感受嗎？"

        obj.intro_text = reply

        if object_id not in session._intro_done_objects:
            session._intro_done_objects.append(object_id)

        # 所有物件 intro 完成 → 切換到 dialogue phase
        phase_complete = len(session._intro_done_objects) >= len(session.objects)
        if phase_complete and session.phase == "intro":
            session.phase = "dialogue"
            session.current_turn_index = 0
            logger.info("Session %s intro 完成，進入 dialogue phase", session_id)

        session.history.append({
            "role": "object",
            "object_id": object_id,
            "text": reply,
            "phase": "intro",
        })

        return {
            "object_id": object_id,
            "text": reply,
            "phase_complete": phase_complete,
        }

    # ── Phase 2：對話輪流 ────────────────────────────────────────────────────

    async def process_user_input(
        self, session_id: str, user_text: str
    ) -> list[dict]:
        """
        處理使用者輸入，依輪流順序產生所有物件的回應。

        一次呼叫會讓所有物件依序回應同一則使用者訊息。
        exchange_count 累加；達 10 次後設 can_end = True。

        Args:
            session_id: Session ID。
            user_text: 使用者說的話（STT 結果或文字輸入）。

        Returns:
            物件回應列表，每個元素為：
            {
                "object_id": str,
                "object_name": str,
                "text": str,
            }
        """
        session = _sessions.get(session_id)
        if not session:
            return [{"error": f"Session {session_id} 不存在"}]

        if not user_text.strip():
            return []

        # 記錄使用者輸入
        session.history.append({
            "role": "user",
            "text": user_text,
            "exchange": session.exchange_count,
        })

        replies = []

        for obj in session.objects:
            system_prompt = _build_voice_system_prompt(obj, is_intro=False)
            gemini_session_id = f"{session_id}_{obj.object_id}"

            # 加入完整對話歷史作為上下文
            context = _build_context_summary(session, obj.object_id)

            try:
                gemini = _get_gemini()
                reply, _ = await gemini.chat_with_system_prompt(
                    user_message=user_text,
                    session_id=gemini_session_id,
                    system_prompt=system_prompt,
                    extra_context=context,
                )
            except Exception as exc:
                logger.error("Gemini 對話生成失敗（object=%s）：%s", obj.object_id, exc)
                reply = "……（沉默）我在聽著，繼續說吧。"

            session.history.append({
                "role": "object",
                "object_id": obj.object_id,
                "text": reply,
                "exchange": session.exchange_count,
            })

            replies.append({
                "object_id": obj.object_id,
                "object_name": obj.object_name,
                "text": reply,
            })

        # 更新 exchange 計數
        session.exchange_count += 1
        if session.exchange_count >= 10:
            session.can_end = True
            logger.info("Session %s 達到 10 次對話，顯示結束按鈕", session_id)

        return replies

    async def stream_user_input(self, session_id: str, user_text: str):
        """
        process_user_input 的流水線版本（async generator）。

        每個物件 Gemini 生成完成後立即 yield，讓 ws_conversation 可以
        馬上開始 TTS + 推送，而不是等所有物件都生成完才開始第一個。
        這可消除「第一個物件開口前的等待」= N 個額外 Gemini 延遲。
        """
        session = _sessions.get(session_id)
        if not session:
            yield {"error": f"Session {session_id} 不存在"}
            return

        if not user_text.strip():
            return

        session.history.append({
            "role": "user",
            "text": user_text,
            "exchange": session.exchange_count,
        })

        for obj in session.objects:
            system_prompt = _build_voice_system_prompt(obj, is_intro=False)
            gemini_session_id = f"{session_id}_{obj.object_id}"
            context = _build_context_summary(session, obj.object_id)

            try:
                gemini = _get_gemini()
                reply, _ = await gemini.chat_with_system_prompt(
                    user_message=user_text,
                    session_id=gemini_session_id,
                    system_prompt=system_prompt,
                    extra_context=context,
                )
            except Exception as exc:
                logger.error("Gemini 生成失敗（object=%s）：%s", obj.object_id, exc)
                reply = "……（沉默）我在聽著，繼續說吧。"

            session.history.append({
                "role": "object",
                "object_id": obj.object_id,
                "text": reply,
                "exchange": session.exchange_count,
            })

            # 立即 yield，讓 caller 可以馬上做 TTS
            yield {
                "object_id": obj.object_id,
                "object_name": obj.object_name,
                "text": reply,
            }

        session.exchange_count += 1
        if session.exchange_count >= 10:
            session.can_end = True
            logger.info("Session %s 達到 10 次對話，顯示結束按鈕", session_id)

    async def set_scene_mode(
        self,
        session_id: str,
        mode: Literal["spatial", "abstract"],
    ):
        """切換場景模式（spatial / abstract）。"""
        session = _sessions.get(session_id)
        if session:
            session.scene_mode = mode
            logger.info("Session %s 場景切換為 %s", session_id, mode)


def _build_context_summary(session: ConversationSession, current_object_id: str) -> str:
    """
    從對話歷史中提取摘要，作為額外上下文注入 system prompt。

    只取最近 6 輪，避免 context 過長。
    """
    recent = session.history[-12:]   # 最近 6 輪（用戶+物件各一 × 6）
    if not recent:
        return ""

    lines = []
    for entry in recent:
        role = entry.get("role", "")
        text = entry.get("text", "")[:100]  # 截斷過長的歷史
        if role == "user":
            lines.append(f"用戶說：{text}")
        elif role == "object" and entry.get("object_id") == current_object_id:
            lines.append(f"你之前回應：{text}")

    if not lines:
        return ""

    return "【近期對話摘要（供參考，不要重複）】\n" + "\n".join(lines)


# ── Module-level singleton ────────────────────────────────────────────────────
_orchestrator_instance: Optional[ConversationOrchestrator] = None


def get_orchestrator() -> ConversationOrchestrator:
    """回傳 ConversationOrchestrator 單例。"""
    global _orchestrator_instance
    if _orchestrator_instance is None:
        _orchestrator_instance = ConversationOrchestrator()
    return _orchestrator_instance

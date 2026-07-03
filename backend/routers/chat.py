"""
chat.py - LLM 對話路由

端點：
    POST /api/chat          - 發送訊息，取得物品（自我延伸）的回應
    DELETE /api/chat/{sid}  - 清除指定 session 的對話歷史
    GET  /api/chat/{sid}/history - 取得對話歷史
"""

import logging

from fastapi import APIRouter, HTTPException

from models.schemas import ChatRequest, ChatResponse, ChatMessage
from services.gemini_service import GeminiService
from services.rag_service import rag_service

logger = logging.getLogger(__name__)
router = APIRouter()

# 模組級服務實例（延遲初始化，避免啟動時即驗證 API Key）
_gemini_service: GeminiService | None = None


def _get_gemini_service() -> GeminiService:
    """
    取得 GeminiService 單例（延遲初始化）。

    Returns:
        GeminiService 實例。

    Raises:
        ValueError: GEMINI_API_KEY 未設定。
    """
    global _gemini_service
    if _gemini_service is None:
        _gemini_service = GeminiService()
    return _gemini_service


@router.post(
    "/chat",
    response_model=ChatResponse,
    summary="與物品（自我延伸）對話",
    description=(
        "使用者發送訊息，系統根據人格資料建構物品的角色設定，"
        "透過 Gemini API 生成回應。支援多輪對話，以 session_id 管理歷史。"
    ),
)
async def chat(request: ChatRequest) -> ChatResponse:
    """
    處理使用者與物品之間的對話。

    Args:
        request: 包含訊息、session_id 與人格資料的請求。

    Returns:
        ChatResponse，含 LLM 回應與完整對話歷史。

    Raises:
        HTTPException 503: API Key 未設定。
        HTTPException 500: LLM 服務錯誤。
    """
    logger.info(
        "收到對話請求：session=%s，訊息長度=%d 字元",
        request.session_id,
        len(request.message),
    )

    try:
        service = _get_gemini_service()
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    # RAG 檢索（目前為 Stub，回傳空列表）
    # TODO: 當 RAG 實作完成後，此處會自動帶入相關上下文
    rag_context = await rag_service.retrieve(
        query=request.message,
        session_id=request.session_id,
    )

    try:
        reply_text, history = await service.chat(
            user_message=request.message,
            session_id=request.session_id,
            personality=request.personality,
            rag_context=rag_context if rag_context else None,
        )

        return ChatResponse(
            reply=reply_text,
            session_id=request.session_id,
            history=history,
        )

    except RuntimeError as exc:
        logger.error("LLM 對話失敗：%s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    except Exception as exc:
        logger.error("未預期的對話錯誤：%s", exc, exc_info=True)
        raise HTTPException(
            status_code=500, detail=f"對話服務發生未預期的錯誤：{exc}"
        ) from exc


@router.get(
    "/chat/{session_id}/history",
    response_model=list[ChatMessage],
    summary="取得對話歷史",
    description="回傳指定 session 的完整對話歷史（包含 user 與 model 的所有訊息）。",
)
async def get_history(session_id: str) -> list[ChatMessage]:
    """
    取得指定 session 的對話歷史。

    Args:
        session_id: Session ID。

    Returns:
        ChatMessage 列表。
    """
    try:
        service = _get_gemini_service()
        return service.get_history(session_id)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.delete(
    "/chat/{session_id}",
    summary="清除對話歷史",
    description="刪除指定 session 的所有對話歷史，讓對話從頭開始。",
)
async def clear_session(session_id: str) -> dict:
    """
    清除指定 session 的對話歷史。

    Args:
        session_id: 要清除的 Session ID。

    Returns:
        確認訊息。
    """
    try:
        service = _get_gemini_service()
        service.clear_session(session_id)
        return {"message": f"Session {session_id} 的對話歷史已清除。"}
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

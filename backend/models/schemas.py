"""
schemas.py - Pydantic 資料模型定義

所有 API 的 request / response schema 集中在此。
"""

from typing import Any, Optional
from pydantic import BaseModel, Field


# ──────────────────────────────────────────────
# Image-to-3D
# ──────────────────────────────────────────────

class Generate3DResponse(BaseModel):
    """POST /api/generate-3d 的回應。"""
    task_id: str = Field(..., description="Meshy.ai 任務 ID")
    status: str = Field(..., description="任務狀態：pending / in_progress / succeeded / failed")
    model_url: Optional[str] = Field(None, description="GLB 模型下載 URL（succeeded 後才有值）")
    thumbnail_url: Optional[str] = Field(None, description="材質預覽圖 URL")
    progress: int = Field(0, description="進度百分比 0–100")


# ──────────────────────────────────────────────
# Personality
# ──────────────────────────────────────────────

class BigFiveAnswers(BaseModel):
    """Big Five 簡版問卷答案（OCEAN，各維度 2 題，1–5 分）。"""
    # Openness（開放性）
    openness_1: int = Field(..., ge=1, le=5, description="我喜歡嘗試新事物與新體驗")
    openness_2: int = Field(..., ge=1, le=5, description="我對藝術、音樂或文學有強烈的興趣")

    # Conscientiousness（盡責性）
    conscientiousness_1: int = Field(..., ge=1, le=5, description="我做事有條理、計畫周詳")
    conscientiousness_2: int = Field(..., ge=1, le=5, description="我能堅持完成困難的任務")

    # Extraversion（外向性）
    extraversion_1: int = Field(..., ge=1, le=5, description="我喜歡與人交流、參加社交活動")
    extraversion_2: int = Field(..., ge=1, le=5, description="我在人群中能感到充滿活力")

    # Agreeableness（親和性）
    agreeableness_1: int = Field(..., ge=1, le=5, description="我容易同情他人的感受")
    agreeableness_2: int = Field(..., ge=1, le=5, description="我傾向於相信他人的善意")

    # Neuroticism（神經質）
    neuroticism_1: int = Field(..., ge=1, le=5, description="我容易感到焦慮或擔憂")
    neuroticism_2: int = Field(..., ge=1, le=5, description="我的情緒容易受到外界影響")


class PersonalityAnalyzeRequest(BaseModel):
    """POST /api/personality/analyze 的請求。"""
    big_five: BigFiveAnswers
    object_description: str = Field(..., min_length=1, description="這個物品對你的意義")
    self_description: str = Field(..., min_length=1, description="請簡短描述你自己")


class BigFiveScores(BaseModel):
    """Big Five 各維度的平均分（1.0–5.0）。"""
    openness: float
    conscientiousness: float
    extraversion: float
    agreeableness: float
    neuroticism: float


class PersonalityAnalyzeResponse(BaseModel):
    """POST /api/personality/analyze 的回應。"""
    scores: BigFiveScores
    personality_summary: str = Field(..., description="自然語言人格摘要")
    communication_style: str = Field(..., description="建議的溝通風格描述")
    object_description: str
    self_description: str


# ──────────────────────────────────────────────
# Chat
# ──────────────────────────────────────────────

class ChatMessage(BaseModel):
    """單筆對話訊息。"""
    role: str = Field(..., description="'user' 或 'model'")
    content: str


class ChatRequest(BaseModel):
    """POST /api/chat 的請求。"""
    message: str = Field(..., min_length=1, description="使用者輸入的訊息")
    session_id: str = Field(..., description="對話 session 識別碼")
    personality: Optional[PersonalityAnalyzeResponse] = Field(
        None, description="人格資料（用於建構 system prompt）"
    )


class ChatResponse(BaseModel):
    """POST /api/chat 的回應。"""
    reply: str = Field(..., description="LLM 回應文字")
    session_id: str
    history: list[ChatMessage] = Field(default_factory=list, description="完整對話歷史")


# ──────────────────────────────────────────────
# 通用
# ──────────────────────────────────────────────

class ErrorResponse(BaseModel):
    """標準錯誤回應格式。"""
    detail: str
    code: Optional[str] = None
    extra: Optional[dict[str, Any]] = None

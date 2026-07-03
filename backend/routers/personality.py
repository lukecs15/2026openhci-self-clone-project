"""
personality.py - 人格分析路由（Stub 實作）

端點：
    POST /api/personality/analyze - 接收 Big Five 問卷 + 文字描述，回傳人格摘要

TODO: 接入真實人格 AI 分析的步驟：
1. 替換 _compute_personality_summary() 為 LLM 分析：
       prompt = f"根據以下 Big Five 分數和描述，生成一段自然語言人格描述：..."
       result = await gemini_service.generate(prompt)
2. 接入心理測量學模型：
       pip install personality-insights  # 或使用 IBM Personality Insights API
3. 接入情感分析：
       from transformers import pipeline
       sentiment = pipeline("sentiment-analysis")
4. 多模態分析：
       結合圖像（畫作）的視覺特徵分析使用者風格偏好
"""

import logging

from fastapi import APIRouter, HTTPException

from models.schemas import (
    BigFiveScores,
    PersonalityAnalyzeRequest,
    PersonalityAnalyzeResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _compute_big_five_scores(answers) -> BigFiveScores:
    """
    從問卷答案計算 Big Five 各維度的平均分。

    每個維度有 2 題，取平均值（1.0–5.0）。

    Args:
        answers: BigFiveAnswers 物件，含各題分數。

    Returns:
        BigFiveScores，各維度平均分。
    """
    return BigFiveScores(
        openness=(answers.openness_1 + answers.openness_2) / 2,
        conscientiousness=(answers.conscientiousness_1 + answers.conscientiousness_2) / 2,
        extraversion=(answers.extraversion_1 + answers.extraversion_2) / 2,
        agreeableness=(answers.agreeableness_1 + answers.agreeableness_2) / 2,
        neuroticism=(answers.neuroticism_1 + answers.neuroticism_2) / 2,
    )


def _compute_personality_summary(scores: BigFiveScores, self_description: str) -> str:
    """
    根據 Big Five 分數生成自然語言人格摘要（規則式 Stub）。

    TODO: 替換為 LLM 生成，可使用 Gemini 分析更細緻的人格特質。

    Args:
        scores: Big Five 各維度分數。
        self_description: 使用者的自由描述文字。

    Returns:
        人格摘要字串。
    """
    traits = []

    if scores.openness >= 3.5:
        traits.append("富有創意、好奇心強，喜歡探索新想法")
    else:
        traits.append("務實穩重，重視傳統與可靠性")

    if scores.conscientiousness >= 3.5:
        traits.append("做事有條理、自律性高，能堅持完成目標")
    else:
        traits.append("靈活自由，享受當下而非嚴格計畫")

    if scores.extraversion >= 3.5:
        traits.append("外向開朗，從人際互動中獲得能量")
    else:
        traits.append("內向沉穩，享受獨處與深度思考")

    if scores.agreeableness >= 3.5:
        traits.append("溫暖體貼，關心他人感受")
    else:
        traits.append("直接坦率，重視個人原則")

    emotional_stability = 5 - scores.neuroticism
    if emotional_stability >= 3.5:
        traits.append("情緒穩定、從容面對壓力")
    else:
        traits.append("情感豐富細膩，對環境變化敏感")

    summary = "、".join(traits[:3]) + "。" + "、".join(traits[3:]) + "。"
    return summary


def _compute_communication_style(scores: BigFiveScores) -> str:
    """
    根據 Big Five 分數推導溝通風格描述。

    TODO: 可接入更精細的人格理論（如 MBTI 對應、依附風格分析）。

    Args:
        scores: Big Five 各維度分數。

    Returns:
        溝通風格描述字串。
    """
    style_parts = []

    # 語調
    if scores.extraversion >= 3.5:
        style_parts.append("熱情、主動，話語充滿活力")
    else:
        style_parts.append("沉靜、深思熟慮，言簡意賅")

    # 表達方式
    if scores.openness >= 3.5:
        style_parts.append("善用比喻與意象，語言富有詩意")
    else:
        style_parts.append("直接清晰，重視實際與具體")

    # 情感溫度
    if scores.agreeableness >= 3.5:
        style_parts.append("充滿同理心，會主動表達關懷")
    else:
        style_parts.append("理性客觀，以事實為基礎")

    return "；".join(style_parts)


@router.post(
    "/personality/analyze",
    response_model=PersonalityAnalyzeResponse,
    summary="分析使用者人格（Stub）",
    description=(
        "接收 Big Five 簡版問卷（各維度 2 題）與自由描述文字，"
        "計算人格分數並生成摘要。目前為規則式 Stub，"
        "TODO 標記處說明如何替換為真實 AI 分析。"
    ),
)
async def analyze_personality(request: PersonalityAnalyzeRequest) -> PersonalityAnalyzeResponse:
    """
    分析使用者人格並生成物品角色設定。

    Args:
        request: 包含 Big Five 答案、物品描述與自我描述的請求。

    Returns:
        PersonalityAnalyzeResponse，含分數、摘要與溝通風格。

    Raises:
        HTTPException 422: 資料驗證失敗（由 FastAPI 自動處理）。
        HTTPException 500: 分析過程發生錯誤。
    """
    logger.info(
        "收到人格分析請求：物品描述='%s...'，自我描述='%s...'",
        request.object_description[:20],
        request.self_description[:20],
    )

    try:
        # Step 1：計算 Big Five 分數
        scores = _compute_big_five_scores(request.big_five)
        logger.debug("Big Five 分數：%s", scores.model_dump())

        # Step 2：生成人格摘要
        # TODO: 替換為 LLM 生成（見 module docstring）
        personality_summary = _compute_personality_summary(scores, request.self_description)

        # Step 3：推導溝通風格
        # TODO: 可接入 MBTI、依附風格等更豐富的模型
        communication_style = _compute_communication_style(scores)

        return PersonalityAnalyzeResponse(
            scores=scores,
            personality_summary=personality_summary,
            communication_style=communication_style,
            object_description=request.object_description,
            self_description=request.self_description,
        )

    except Exception as exc:
        logger.error("人格分析失敗：%s", exc, exc_info=True)
        raise HTTPException(
            status_code=500, detail=f"人格分析發生錯誤：{exc}"
        ) from exc

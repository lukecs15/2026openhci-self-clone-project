"""
routers/onboarding.py — Mobile Onboarding REST 端點

對應手機端「問卷 → 掃 QR 上傳 → 主系統體驗 → 掃 QR 取回紀念品」流程：

    1. 主系統（展示端）用自己既有的 WebSocket session_id 產生 QR，QR 內容是
       手機連結頁網址（帶這個 session_id），不需要另外呼叫後端建立 session。
    2. 手機掃碼後，把 Big Five 分數 + 錄好的聲音樣本一次性 POST 到
       /api/onboarding-sessions/{session_id}/link，後端建立聲音克隆 profile
       + 生成 5 位「自我」agent（services/personality_mapping.py）。
    3. 主系統輪詢 GET /api/onboarding-sessions/{session_id}，收到
       status="linked" 後載入這 5 位 agent，讓使用者選 2 位進辯論模式
       （沿用既有 /ws/voice-debate/{session_id} 的一切邏輯，不需要改）。
    4. 辯論結束，主系統把總結句子 + 融合波形 POST 到
       /api/onboarding-sessions/{session_id}/result。
    5. 主系統顯示第二個 QR，手機掃碼呼叫 GET .../result 取得紀念畫面資料。

端點：
    GET    /api/onboarding-sessions/{session_id}          查詢狀態（404 = 還沒連結）
    POST   /api/onboarding-sessions/{session_id}/link      手機上傳問卷+聲音樣本
    POST   /api/onboarding-sessions/{session_id}/result     主系統回寫結束結果
    GET    /api/onboarding-sessions/{session_id}/result     手機取回結束結果

TODO: 目前沒有 session 過期/清理機制，長期執行需要定期清掉舊的
      onboarding_sessions/sessions.json 紀錄與對應的聲音樣本檔案。
"""

import json
import logging

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from pydantic import ValidationError

from config import get_settings
from models.schemas import BigFiveScores, OnboardingResult, OnboardingSession
from services.onboarding_session_service import (
    OnboardingSessionAlreadyLinkedError,
    OnboardingSessionNotLinkedError,
    get_onboarding_session_service,
)
from services.personality_mapping import build_self_agents
from services.voice_profile_service import ALLOWED_AUDIO_EXTS, get_voice_profile_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/onboarding-sessions", tags=["Mobile Onboarding"])


@router.get("/{session_id}", response_model=OnboardingSession, summary="查詢 onboarding session 狀態")
async def get_onboarding_session(session_id: str):
    """
    主系統（展示端）輪詢用：session 還沒被手機連結時回 404，呼叫端應該把
    404 解讀成「還在等待使用者掃碼上傳」，不是真正的錯誤。
    """
    session = get_onboarding_session_service().get_session(session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="尚未連結，請掃描 QR code 上傳問卷與聲音樣本"
        )
    return session


@router.post("/{session_id}/link", response_model=OnboardingSession, summary="手機上傳問卷+聲音樣本，建立 5 位自我 agent")
async def link_onboarding_session(
    session_id: str,
    big_five: str = Form(..., description="BigFiveScores 的 JSON 字串"),
    label: str = Form("我的聲音", description="聲音克隆 profile 顯示名稱"),
    file: UploadFile = File(..., description="Big Five 問卷開始前錄的聲音樣本，WAV/WebM 等音訊檔"),
):
    settings = get_settings()

    try:
        scores = BigFiveScores(**json.loads(big_five))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=f"big_five 格式錯誤：{exc}"
        )

    fname_lower = (file.filename or "").lower()
    ext = next((e for e in ALLOWED_AUDIO_EXTS if fname_lower.endswith(e)), ".wav")
    audio_bytes = await file.read()
    if len(audio_bytes) == 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="聲音樣本檔案是空的")
    if len(audio_bytes) > settings.voice_sample_max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"聲音樣本過大，上限 {settings.voice_sample_max_bytes // (1024 * 1024)}MB",
        )

    voice_profile_svc = get_voice_profile_service()
    tmp_filename = voice_profile_svc.save_uploaded_sample(audio_bytes, ext=ext)
    voice_profile = await voice_profile_svc.create_profile(sample_filename=tmp_filename, label=label)

    agents = build_self_agents(
        {
            "openness": scores.openness,
            "conscientiousness": scores.conscientiousness,
            "extraversion": scores.extraversion,
            "agreeableness": scores.agreeableness,
            "neuroticism": scores.neuroticism,
        },
        voice_profile_id=voice_profile.profile_id,
    )

    try:
        session = get_onboarding_session_service().link_session(
            session_id=session_id,
            big_five_scores=scores,
            voice_profile_id=voice_profile.profile_id,
            agents=agents,
        )
    except OnboardingSessionAlreadyLinkedError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))

    return session


@router.post("/{session_id}/result", response_model=OnboardingSession, summary="主系統回寫體驗結束結果")
async def complete_onboarding_session(session_id: str, result: OnboardingResult):
    """
    主系統（展示端）在辯論/對話結束、收到 session_summary 並算出融合波形
    （mergeWaveformSignatures()）之後呼叫，把「紀念品」內容寫回，供手機
    掃第二個 QR 取回。
    """
    try:
        session = get_onboarding_session_service().complete_session(session_id, result)
    except OnboardingSessionNotLinkedError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    return session


@router.get("/{session_id}/result", response_model=OnboardingResult, summary="手機取回體驗結束結果")
async def get_onboarding_result(session_id: str):
    session = get_onboarding_session_service().get_session(session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="找不到這場對話")
    if session.status != "completed" or session.result is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="體驗尚未結束，結果還沒準備好，請稍後再試"
        )
    return session.result

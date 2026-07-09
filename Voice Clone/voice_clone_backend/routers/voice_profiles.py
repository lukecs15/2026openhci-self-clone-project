"""
routers/voice_profiles.py — 使用者聲音克隆 Profile REST 端點

端點：
    POST   /api/voice-profiles/upload-sample   上傳錄音樣本
    POST   /api/voice-profiles/clone           建立 VoiceProfile（含自動轉錄逐字稿）
    GET    /api/voice-profiles                 列出所有 profile
    DELETE /api/voice-profiles/{profile_id}    刪除 profile

使用流程（對應前端 VoiceProfileUploader.jsx）：
    1. 使用者錄音或選擇檔案 → POST upload-sample → 拿到 tmp filename
    2. POST clone { sample_filename, label } → 拿到 profile_id
    3. 前端把 profile_id 填進某個（或全部）AgentConfig.voice_profile_id，
       再送出 WebSocket 的 init_session

音訊規格建議：3-30 秒、16kHz mono、安靜環境（CosyVoice 2 zero-shot 克隆
只需要幾秒鐘參考音訊，不需要像傳統聲音克隆一樣要 15-30 分鐘語料）。

TODO: 加入音訊品質驗證（SNR、時長檢查，過短/過長給予明確錯誤訊息）
TODO: clone 端點目前是同步等待 STT 自動轉錄完成才回傳，之後可以改成非同步
      工作佇列 + WebSocket 通知，避免前端長時間等待
"""

import logging

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from config import get_settings
from models.schemas import VoiceProfile
from services.voice_profile_service import ALLOWED_AUDIO_EXTS, get_voice_profile_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/voice-profiles", tags=["Voice Profiles"])


class CloneRequest(BaseModel):
    sample_filename: str = Field(..., description="upload-sample 回傳的暫存檔名")
    label: str = Field("", description="顯示用名稱，例如「我的聲音」")
    reference_text: str = Field(
        "", description="參考音訊逐字稿（留空則自動用 STT 轉錄）"
    )


class UpdateProfileRequest(BaseModel):
    reference_text: str | None = Field(
        None, description="修正後的參考音訊逐字稿（例如自動轉錄結果有誤/幻覺時手動修正）"
    )
    label: str | None = Field(None, description="修正後的顯示名稱")


@router.post("/upload-sample", summary="上傳聲音克隆用的錄音樣本")
async def upload_sample(file: UploadFile = File(..., description="WAV/WebM 等音訊檔")):
    settings = get_settings()
    fname_lower = (file.filename or "").lower()
    ext = next((e for e in ALLOWED_AUDIO_EXTS if fname_lower.endswith(e)), ".wav")

    audio_bytes = await file.read()
    if len(audio_bytes) > settings.voice_sample_max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"檔案過大，上限 {settings.voice_sample_max_bytes // (1024 * 1024)}MB",
        )
    if len(audio_bytes) == 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="檔案是空的")

    svc = get_voice_profile_service()
    tmp_filename = svc.save_uploaded_sample(audio_bytes, ext=ext)

    return {
        "sample_filename": tmp_filename,
        "size_bytes": len(audio_bytes),
        "message": "樣本上傳成功，請呼叫 /api/voice-profiles/clone 建立聲音克隆 profile",
    }


@router.post("/clone", response_model=VoiceProfile, summary="建立聲音克隆 Profile")
async def clone_voice_profile(req: CloneRequest):
    svc = get_voice_profile_service()
    try:
        profile = await svc.create_profile(
            sample_filename=req.sample_filename,
            label=req.label,
            reference_text=req.reference_text,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    return profile


@router.get("", response_model=list[VoiceProfile], summary="列出所有聲音克隆 Profile")
async def list_voice_profiles():
    return get_voice_profile_service().list_profiles()


@router.patch("/{profile_id}", response_model=VoiceProfile, summary="修正聲音克隆 Profile 的逐字稿/名稱")
async def update_voice_profile(profile_id: str, req: UpdateProfileRequest):
    updated = get_voice_profile_service().update_profile(
        profile_id, reference_text=req.reference_text, label=req.label
    )
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="找不到該 profile")
    return updated


@router.delete("/{profile_id}", summary="刪除聲音克隆 Profile")
async def delete_voice_profile(profile_id: str):
    deleted = get_voice_profile_service().delete_profile(profile_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="找不到該 profile")
    return {"message": "已刪除", "profile_id": profile_id}

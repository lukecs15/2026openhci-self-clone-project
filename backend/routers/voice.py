"""
routers/voice.py — 語音 Profile REST 端點

端點：
    POST   /api/voice/upload-sample      上傳錄音樣本
    POST   /api/voice/clone              建立 VoiceProfile
    GET    /api/voice/profiles           列出所有 profile
    PATCH  /api/voice/profiles/{id}      即時調整 pitch/speed/energy

音訊規格（建議）：
    - 格式：WAV（16kHz, mono, 16bit）
    - 時長：15-30 秒（太短克隆效果差，太長浪費儲存）
    - 環境：安靜室內，無背景音樂

TODO: 加入音訊品質驗證（SNR、長度檢查）
TODO: 加入 ElevenLabs Voice Clone 端點（/api/voice/clone-elevenlabs）
TODO: 加入 profile 刪除端點（DELETE /api/voice/profiles/{id}）
"""

import logging
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from services.voice_service import get_voice_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/voice", tags=["Voice"])

# ─────────────────────────────────────────────────────────────────────────────
# Request / Response Schemas
# ─────────────────────────────────────────────────────────────────────────────

class CloneRequest(BaseModel):
    """POST /api/voice/clone 的請求。"""
    object_id: str = Field(..., description="對應 3D 物件 ID")
    object_name: str = Field("", description="物件名稱（顯示用）")
    pitch_shift: float = Field(0.0, ge=-3.0, le=3.0, description="音高偏移（半音）")
    speed: float = Field(1.0, ge=0.8, le=1.2, description="語速倍率")
    energy: float = Field(1.0, ge=0.5, le=1.5, description="音量倍率")
    sample_filename: str = Field(..., description="已上傳的樣本檔名（upload-sample 回傳的 filename）")


class UpdateProfileRequest(BaseModel):
    """PATCH /api/voice/profiles/{profile_id} 的請求（所有欄位可選）。"""
    pitch_shift: Optional[float] = Field(None, ge=-3.0, le=3.0)
    speed: Optional[float] = Field(None, ge=0.8, le=1.2)
    energy: Optional[float] = Field(None, ge=0.5, le=1.5)


# ─────────────────────────────────────────────────────────────────────────────
# 端點
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/upload-sample", summary="上傳錄音樣本")
async def upload_sample(
    file: UploadFile = File(..., description="WAV 音訊檔（建議 15-30 秒，16kHz mono）"),
    object_id: str = Form(..., description="對應的物件 ID"),
):
    """
    上傳用戶錄音樣本，儲存至 voice_samples/ 目錄。

    回傳儲存的檔名，供後續 /clone 端點使用。
    """
    # 接受 WAV / WebM / MP4 等常見音訊格式（瀏覽器 MediaRecorder 可能輸出 WebM）
    ALLOWED_AUDIO_EXTS = {".wav", ".webm", ".mp4", ".m4a", ".ogg", ".mp3"}
    fname_lower = (file.filename or "").lower()
    ext = next((e for e in ALLOWED_AUDIO_EXTS if fname_lower.endswith(e)), ".wav")

    max_size = 20 * 1024 * 1024  # 20MB
    audio_bytes = await file.read()
    if len(audio_bytes) > max_size:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="檔案過大，上限 20MB",
        )

    svc = get_voice_service()
    import uuid
    from pathlib import Path
    tmp_filename = f"tmp_{object_id}_{uuid.uuid4().hex[:8]}{ext}"
    tmp_path = Path(svc._samples_dir) / tmp_filename
    tmp_path.parent.mkdir(parents=True, exist_ok=True)
    with open(tmp_path, "wb") as f:
        f.write(audio_bytes)

    logger.info("樣本上傳完成：%s（%d bytes，格式=%s）", tmp_filename, len(audio_bytes), ext)
    return {
        "filename": tmp_filename,
        "size_bytes": len(audio_bytes),
        "message": "樣本上傳成功，請呼叫 /api/voice/clone 建立 VoiceProfile",
    }


@router.post("/clone", summary="建立聲音克隆 Profile")
async def clone_voice(req: CloneRequest):
    """
    從已上傳的樣本建立 VoiceProfile，並設定音高/語速/能量參數。

    建立後，ConversationOrchestrator 會在合成語音時使用此 profile。
    """
    from pathlib import Path

    svc = get_voice_service()
    sample_path = Path(svc._samples_dir) / req.sample_filename

    if not sample_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"樣本檔案不存在：{req.sample_filename}，請先呼叫 /upload-sample",
        )

    audio_bytes = sample_path.read_bytes()
    profile = await svc.clone_voice(
        audio_bytes=audio_bytes,
        object_id=req.object_id,
        object_name=req.object_name,
        pitch_shift=req.pitch_shift,
        speed=req.speed,
        energy=req.energy,
    )

    logger.info("VoiceProfile 建立：object_id=%s profile_id=%s", req.object_id, profile.profile_id)
    return {
        "profile": profile.to_dict(),
        "message": "VoiceProfile 建立成功",
    }


@router.delete("/samples/{filename}", summary="刪除暫存樣本")
async def delete_sample(filename: str):
    """
    前端完成所有物件的 clone 後呼叫，清理一次性上傳的暫存檔。
    僅允許刪除 tmp_ 開頭的檔案，防止誤刪 profile 音訊。
    """
    if not filename.startswith("tmp_"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="只允許刪除 tmp_ 開頭的暫存檔案",
        )
    from pathlib import Path
    svc = get_voice_service()
    path = Path(svc._samples_dir) / filename
    if path.exists():
        path.unlink(missing_ok=True)
        logger.info("暫存樣本已清理：%s", filename)
    return {"message": "已清理"}


@router.get("/profiles", summary="列出所有 VoiceProfile")
async def list_profiles():
    """回傳目前所有已建立的 VoiceProfile 列表。"""
    svc = get_voice_service()
    return {"profiles": svc.list_profiles()}


@router.patch("/profiles/{profile_id}", summary="即時調整聲音參數")
async def update_profile(profile_id: str, req: UpdateProfileRequest):
    """
    即時調整指定 profile 的 pitch / speed / energy。

    改動會立即生效，下次合成語音時使用新的參數。
    """
    svc = get_voice_service()
    updated = svc.update_profile(
        profile_id=profile_id,
        pitch_shift=req.pitch_shift,
        speed=req.speed,
        energy=req.energy,
    )
    if not updated:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Profile {profile_id} 不存在",
        )
    return {"profile": updated.to_dict(), "message": "參數更新成功"}

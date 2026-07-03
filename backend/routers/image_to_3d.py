"""
image_to_3d.py - 圖像轉 3D 模型路由

端點：
    POST /api/generate-3d  - 上傳圖像，回傳 GLB 模型 URL（含輪詢等待）
    GET  /api/task/{task_id} - 查詢單一任務狀態（前端可用於即時輪詢）
"""

import logging

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from config import get_settings
from models.schemas import Generate3DResponse
from services.meshy_service import LocalModel3DService, MeshyService

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter()

# ── 允許的圖像 MIME 類型 ──────────────────────────────
ALLOWED_CONTENT_TYPES = {"image/png", "image/jpeg", "image/webp"}
MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB


def _get_3d_service():
    """
    根據設定選擇使用 Meshy.ai 或本地備用服務。

    Returns:
        MeshyService 或 LocalModel3DService 的實例。
    """
    if settings.use_local_model_fallback:
        logger.info("使用本地備用模型（TripoSR Stub）")
        return LocalModel3DService()
    return MeshyService()


@router.post(
    "/generate-3d",
    response_model=Generate3DResponse,
    summary="上傳圖像並轉換為 3D 模型",
    description=(
        "接收圖像檔案（PNG/JPEG/WebP），呼叫 Meshy.ai Image-to-3D API，"
        "輪詢直到任務完成，回傳 GLB 格式的 3D 模型 URL。"
        "整體處理時間約 1–3 分鐘。"
    ),
)
async def generate_3d(
    file: UploadFile = File(..., description="要轉換的圖像檔案（PNG/JPEG/WebP，最大 10MB）"),
) -> Generate3DResponse:
    """
    將上傳的圖像轉換為 3D 模型。

    Args:
        file: 使用者上傳的圖像檔案。

    Returns:
        Generate3DResponse，包含 GLB 模型 URL 與預覽圖 URL。

    Raises:
        HTTPException 400: 不支援的檔案類型或檔案過大。
        HTTPException 500: 3D 生成服務發生錯誤。
        HTTPException 503: API Key 未設定。
    """
    # 驗證 Content-Type
    content_type = file.content_type or ""
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"不支援的檔案類型：{content_type}。請上傳 PNG、JPEG 或 WebP 圖像。",
        )

    # 讀取並驗證檔案大小
    image_bytes = await file.read()
    if len(image_bytes) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"檔案大小超過限制（最大 {MAX_FILE_SIZE_BYTES // 1024 // 1024} MB）。",
        )

    if not image_bytes:
        raise HTTPException(status_code=400, detail="上傳的檔案是空的。")

    logger.info(
        "收到圖像轉換請求：檔名=%s，類型=%s，大小=%d bytes",
        file.filename,
        content_type,
        len(image_bytes),
    )

    try:
        service = _get_3d_service()
        result = await service.image_to_3d(image_bytes, content_type)

        return Generate3DResponse(
            task_id=result["task_id"],
            status=result["status"],
            model_url=result.get("model_url"),
            thumbnail_url=result.get("thumbnail_url"),
            progress=result.get("progress", 100),
        )

    except ValueError as exc:
        # API Key 未設定
        logger.error("設定錯誤：%s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    except NotImplementedError as exc:
        # 本地模型尚未實作
        logger.warning("本地模型未實作：%s", exc)
        raise HTTPException(status_code=501, detail=str(exc)) from exc

    except RuntimeError as exc:
        # 任務失敗或逾時
        logger.error("3D 生成任務失敗：%s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    except Exception as exc:
        logger.error("未預期的錯誤：%s", exc, exc_info=True)
        raise HTTPException(
            status_code=500, detail=f"3D 生成服務發生未預期的錯誤：{exc}"
        ) from exc


@router.get(
    "/task/{task_id}",
    response_model=Generate3DResponse,
    summary="查詢 3D 生成任務狀態",
    description="輪詢指定任務的當前狀態，前端可每隔數秒呼叫一次以取得即時進度。",
)
async def get_task_status(task_id: str) -> Generate3DResponse:
    """
    查詢 Meshy.ai 任務的當前狀態。

    Args:
        task_id: Meshy.ai 任務 ID。

    Returns:
        Generate3DResponse，含當前狀態與進度。

    Raises:
        HTTPException 503: API Key 未設定。
        HTTPException 500: 查詢失敗。
    """
    try:
        service = MeshyService()
        data = await service.get_task_status(task_id)

        status_map = {
            "PENDING": "pending",
            "IN_PROGRESS": "in_progress",
            "SUCCEEDED": "succeeded",
            "FAILED": "failed",
            "EXPIRED": "failed",
        }
        normalized_status = status_map.get(data.get("status", "").upper(), "pending")
        model_urls = data.get("model_urls", {})

        return Generate3DResponse(
            task_id=task_id,
            status=normalized_status,
            model_url=model_urls.get("glb") if normalized_status == "succeeded" else None,
            thumbnail_url=data.get("thumbnail_url"),
            progress=data.get("progress", 0),
        )

    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("查詢任務 %s 失敗：%s", task_id, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"查詢任務失敗：{exc}") from exc

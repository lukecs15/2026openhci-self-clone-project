"""
meshy_service.py - Meshy.ai API 封裝

負責：
1. 上傳圖像至 Meshy.ai 的 Image-to-3D API（/v2/image-to-3d）
2. 輪詢任務狀態直到完成或逾時
3. 回傳 GLB 模型 URL 與縮圖 URL

Meshy.ai 文件：https://docs.meshy.ai/api-image-to-3d
"""

import asyncio
import base64
import logging
from typing import Optional

import httpx

from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


class MeshyTaskStatus:
    """Meshy.ai 任務狀態常數。"""
    PENDING = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    EXPIRED = "EXPIRED"


class MeshyService:
    """
    封裝 Meshy.ai Image-to-3D REST API。

    使用方式：
        service = MeshyService()
        result = await service.image_to_3d(image_bytes, "image/png")
    """

    def __init__(self):
        self.base_url = settings.meshy_base_url
        self.api_key = settings.meshy_api_key
        self.headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def image_to_3d(
        self,
        image_bytes: bytes,
        content_type: str = "image/png",
        enable_pbr: bool = True,
        ai_model: str = "meshy-4",
    ) -> dict:
        """
        將圖像轉換為 3D 模型（非同步，含輪詢）。

        Args:
            image_bytes: 圖像的原始位元組。
            content_type: MIME 類型，例如 "image/png" 或 "image/jpeg"。
            enable_pbr: 是否啟用 PBR 材質（預設開啟）。
            ai_model: 使用的 AI 模型版本（預設 meshy-4）。

        Returns:
            dict 包含以下欄位：
                - task_id (str)
                - status (str)
                - model_url (str | None): GLB 格式 URL
                - thumbnail_url (str | None)
                - progress (int): 0–100

        Raises:
            ValueError: API Key 未設定。
            RuntimeError: 任務失敗或逾時。
            httpx.HTTPStatusError: API 請求失敗。
        """
        if not self.api_key:
            raise ValueError(
                "MESHY_API_KEY 未設定。請在 .env 中加入 MESHY_API_KEY=your_key"
            )

        # 將圖像編碼為 base64 Data URI
        b64 = base64.b64encode(image_bytes).decode("utf-8")
        image_data_uri = f"data:{content_type};base64,{b64}"

        # Step 1：建立任務
        task_id = await self._create_task(image_data_uri, enable_pbr, ai_model)
        logger.info("Meshy 任務已建立：%s", task_id)

        # Step 2：輪詢狀態
        result = await self._poll_task(task_id)
        return result

    async def _create_task(
        self, image_data_uri: str, enable_pbr: bool, ai_model: str
    ) -> str:
        """
        呼叫 POST /v2/image-to-3d 建立轉換任務。

        Args:
            image_data_uri: base64 編碼的圖像 Data URI。
            enable_pbr: 是否啟用 PBR 材質。
            ai_model: AI 模型版本。

        Returns:
            任務 ID（字串）。
        """
        payload = {
            "image_url": image_data_uri,
            "enable_pbr": enable_pbr,
            "ai_model": ai_model,
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{self.base_url}/v2/image-to-3d",
                headers=self.headers,
                json=payload,
            )
            response.raise_for_status()
            data = response.json()

        task_id = data.get("result")
        if not task_id:
            raise RuntimeError(f"Meshy API 未回傳 task_id：{data}")
        return task_id

    async def get_task_status(self, task_id: str) -> dict:
        """
        查詢單一任務的當前狀態。

        Args:
            task_id: Meshy.ai 任務 ID。

        Returns:
            dict 包含任務狀態資訊。
        """
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                f"{self.base_url}/v2/image-to-3d/{task_id}",
                headers=self.headers,
            )
            response.raise_for_status()
            return response.json()

    async def _poll_task(self, task_id: str) -> dict:
        """
        輪詢任務直到完成、失敗或逾時。

        Args:
            task_id: Meshy.ai 任務 ID。

        Returns:
            格式化的結果 dict（含 model_url、thumbnail_url 等）。

        Raises:
            RuntimeError: 任務失敗、過期或輪詢逾時。
        """
        elapsed = 0.0
        poll_interval = settings.meshy_poll_interval
        timeout = settings.meshy_poll_timeout

        while elapsed < timeout:
            data = await self.get_task_status(task_id)
            status = data.get("status", "").upper()
            progress = data.get("progress", 0)

            logger.debug("任務 %s 狀態：%s，進度：%d%%", task_id, status, progress)

            if status == MeshyTaskStatus.SUCCEEDED:
                model_urls = data.get("model_urls", {})
                return {
                    "task_id": task_id,
                    "status": "succeeded",
                    "model_url": model_urls.get("glb"),
                    "thumbnail_url": data.get("thumbnail_url"),
                    "progress": 100,
                }

            if status in (MeshyTaskStatus.FAILED, MeshyTaskStatus.EXPIRED):
                error_msg = data.get("task_error", {}).get("message", "未知錯誤")
                raise RuntimeError(f"Meshy 任務 {task_id} 失敗：{error_msg}")

            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

        raise RuntimeError(
            f"Meshy 任務 {task_id} 輪詢逾時（{timeout} 秒）。"
            "請稍後再試或至 Meshy.ai 後台查看任務狀態。"
        )


# ──────────────────────────────────────────────
# 本地備用：TripoSR Stub
# ──────────────────────────────────────────────

class LocalModel3DService:
    """
    本地端 3D 生成服務（委派給 LocalGLBService）。

    目前實作：PIL + numpy 生成圖像浮雕 GLB（無需 GPU）。

    TODO: 升級為 TripoSR 真實 3D 重建：
    1. pip install git+https://github.com/VAST-AI-Research/TripoSR.git
    2. 在 local_3d_service.py 繼承 LocalGLBService，
       覆寫 generate() 方法呼叫 TripoSR
    3. 設定 .env：LOCAL_MODEL_WEIGHTS_PATH=/path/to/weights
    """

    def __init__(self, weights_path: Optional[str] = None):
        from services.local_3d_service import LocalGLBService
        self._delegate = LocalGLBService(
            output_dir=settings.local_output_dir
        )

    async def image_to_3d(self, image_bytes: bytes, content_type: str = "image/png") -> dict:
        """
        本地端圖像轉 3D（浮雕 GLB）。

        Args:
            image_bytes: 圖像原始位元組。
            content_type: MIME 類型（PIL 自動判斷，可忽略）。

        Returns:
            dict 含 task_id, status, model_url（/static/xxx.glb）。
        """
        return await self._delegate.image_to_3d(image_bytes, content_type)

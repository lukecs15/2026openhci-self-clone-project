"""
main.py - FastAPI 應用程式入口

啟動方式：
    uvicorn main:app --reload --host 0.0.0.0 --port 8000
"""

import asyncio
import logging
import os
from dotenv import load_dotenv
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from config import get_settings
from routers import image_to_3d, chat, personality
from routers import voice as voice_router
from routers import ws_conversation

logger = logging.getLogger(__name__)
settings = get_settings()

load_dotenv()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # TTS 模型（XTTS v2）採延遲載入，首次合成時才載入。
    # WebSocket heartbeat（每 20 秒 ping）確保載入期間連線不中斷。
    yield


app = FastAPI(
    lifespan=lifespan,
    title="Drawing to 3D — 與記憶對話",
    description=(
        "使用者上傳畫作 → 轉換成 3D 模型 → 透過語音與多個物品同時對話。"
        "物品是使用者自我的延伸，體現其人格特質。"
        "\n\n語音場景入口：WS /ws/conversation/{session_id}"
    ),
    version="0.2.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# ──────────────────────────────────────────────
# CORS 設定
# ──────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin, "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────
# REST 路由掛載
# ──────────────────────────────────────────────
app.include_router(image_to_3d.router, prefix="/api", tags=["Image to 3D"])
app.include_router(chat.router, prefix="/api", tags=["Chat"])
app.include_router(personality.router, prefix="/api", tags=["Personality"])
app.include_router(voice_router.router, prefix="/api", tags=["Voice"])

# ──────────────────────────────────────────────
# WebSocket 路由掛載（語音對話場景）
# ──────────────────────────────────────────────
app.include_router(ws_conversation.router)

# ──────────────────────────────────────────────
# 靜態檔案（本地生成的 GLB 模型）
# ──────────────────────────────────────────────
_static_dir = Path(settings.local_output_dir)
_static_dir.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")

# ──────────────────────────────────────────────
# 語音樣本靜態目錄
# ──────────────────────────────────────────────
_voice_samples_dir = Path(settings.voice_samples_dir)
_voice_samples_dir.mkdir(parents=True, exist_ok=True)


@app.get("/health", tags=["Health"])
async def health_check():
    """健康檢查端點，確認服務正常運行。"""
    return {"status": "ok", "version": app.version}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=settings.backend_host,
        port=settings.backend_port,
        reload=True,
    )

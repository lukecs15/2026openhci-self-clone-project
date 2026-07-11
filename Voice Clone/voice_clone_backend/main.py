"""
main.py — Voice Clone 多 Agent 對話系統 FastAPI 入口

啟動方式：
    uvicorn main:app --reload --host 0.0.0.0 --port 8200

與現有 backend/（Drawing to 3D 專案）為獨立服務，走不同 port（預設 8200），
可各自獨立部署，也可日後視需要合併路由。
"""

import logging

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import get_settings
from routers import onboarding, voice_profiles, ws_debate, ws_voice_agents

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
settings = get_settings()

app = FastAPI(
    title="Voice Clone — 台灣腔克隆語音多 Agent 對話系統",
    description=(
        "多 Agent 語音對話後端：STT（Breeze ASR + faster-whisper 雙引擎）"
        "→ LLM 串流（OpenAI/Gemini）→ 逐句斷句 → TTS（CosyVoice 2）。"
        f"\n\n目前硬體設定檔：{settings.device_profile}"
        "\n\nWebSocket 入口：/ws/voice-agents/{session_id}"
        "\n辯論模式 WebSocket 入口：/ws/voice-debate/{session_id}"
        "\n聲音克隆 Profile：POST /api/voice-profiles/upload-sample -> /api/voice-profiles/clone"
    ),
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    # 手機 onboarding 前端（mobile_frontend_origin）跟主系統展示端
    # （frontend_origin）是兩個不同的來源，各自直接打這台後端的 REST API，
    # 兩個都要放行。
    allow_origins=[settings.frontend_origin, settings.mobile_frontend_origin, "http://localhost:5174"],
    # 額外支援 regex（見 config.py 的 mobile_frontend_origin_regex 說明）：
    # 用 cloudflared quick tunnel 測試手機前端時，網域每次重啟都會變，設一
    # 次 regex（例如 *.trycloudflare.com）就不用每次重新設定/重啟後端。
    allow_origin_regex=settings.mobile_frontend_origin_regex or None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(voice_profiles.router, prefix="/api")
app.include_router(onboarding.router, prefix="/api")
app.include_router(ws_voice_agents.router)
app.include_router(ws_debate.router)


@app.get("/health", tags=["Health"])
async def health_check():
    """健康檢查端點，回傳目前硬體設定檔與關鍵引擎設定，方便確認部署環境是否正確。"""
    return {
        "status": "ok",
        "version": app.version,
        "device_profile": settings.device_profile,
        "stt_primary_engine": settings.stt_primary_engine,
        "stt_fallback_engine": settings.stt_fallback_engine,
        "tts_engine": settings.tts_engine,
        "llm_provider": settings.llm_provider,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=settings.backend_host,
        port=settings.backend_port,
        reload=True,
    )

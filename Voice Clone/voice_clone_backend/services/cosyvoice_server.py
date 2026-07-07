"""
services/cosyvoice_server.py — CosyVoice 2 常駐推理伺服器（獨立行程）

只在 RTX 5090（prod profile）機器上啟動。與主 FastAPI app（main.py）分開行程，
理由：
    - CosyVoice 2 權重載入需要數秒，獨立常駐才能避免每次合成都重新載入
    - 與 Pipecat worker 分離，讓「文字轉語音」永遠是 localhost 內部呼叫
    - 之後若要垂直擴充（多張 GPU 各跑一個 CosyVoice server）也比較容易

啟動方式（僅限已安裝 CosyVoice 2 依賴的 RTX 5090 環境）：
    python -m services.cosyvoice_server
    # 監聽 ws://COSYVOICE_SERVER_HOST:COSYVOICE_SERVER_PORT/synthesize

協定：
    Client → Server（單一 JSON text frame）：
        {"text": "要合成的句子", "voice_profile_id": "agent-1"}
    Server → Client（多個 binary frame，逐 chunk 串流 PCM 音訊）：
        <binary chunk 1> <binary chunk 2> ... 連線關閉代表該句合成完畢
"""

import asyncio
import json
import logging

from config import get_settings

logger = logging.getLogger(__name__)


async def _handle_connection(websocket):
    """處理單一合成請求連線：收到文字 → 逐 chunk 吐音訊 → 關閉連線。"""
    from services.tts_service import CosyVoiceModelServer

    server = _get_model_server()

    async for raw in websocket:
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("CosyVoice server 收到非 JSON 請求，忽略：%r", raw[:200])
            continue

        text = req.get("text", "")
        voice_profile_id = req.get("voice_profile_id", "")
        logger.info("合成請求：voice_profile_id=%s, text=%s", voice_profile_id, text[:50])

        async for chunk in server.synthesize_stream(text, voice_profile_id):
            await websocket.send(chunk)

        break  # 單次請求對應單一連線，合成完就結束


_model_server_singleton = None


def _get_model_server():
    global _model_server_singleton
    if _model_server_singleton is None:
        from services.tts_service import CosyVoiceModelServer

        _model_server_singleton = CosyVoiceModelServer()
    return _model_server_singleton


async def main():
    import websockets

    settings = get_settings()
    logger.info(
        "CosyVoice 2 常駐服務啟動中：ws://%s:%d/synthesize",
        settings.cosyvoice_server_host,
        settings.cosyvoice_server_port,
    )
    async with websockets.serve(
        _handle_connection, settings.cosyvoice_server_host, settings.cosyvoice_server_port
    ):
        await asyncio.Future()  # 永久執行


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())

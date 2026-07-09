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
    Server → Client（成功時）：
        多個 binary frame，逐 chunk 串流 PCM 音訊，連線關閉代表該句合成完畢
    Server → Client（合成失敗時，修過的真實問題——見下方 _handle_connection
    docstring）：
        單一 JSON text frame：{"error": "錯誤訊息"}，接著關閉連線
"""

import asyncio
import json
import logging

from config import get_settings

logger = logging.getLogger(__name__)


async def _handle_connection(websocket):
    """
    處理單一合成請求連線：收到文字 → 逐 chunk 吐音訊 → 關閉連線。

    修過的真實問題：以前 synthesize_stream() 失敗時只會在這裡的 server
    process log 一行錯誤，對 client 來說連線就是正常收到 0 個 chunk 後關閉，
    跟「這句話本來就是空白」完全無法區分。client 端（agents/debate.py 等）
    因此把失敗誤判成「成功合成了一句沒有聲音的話」，辯論模式的節奏控制
    （靠音訊資料長度估計播放時長）因此形同虛設，兩位 agent 完全沒有停頓地
    飛快輪流講下去——這是使用者實測回報過的真實問題。現在 synthesize_stream()
    失敗時會真的 raise，這裡接住後改送一個 JSON error text frame，讓
    client 能明確分辨「合成失敗」跟「這句話真的沒有聲音」。
    """
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

        try:
            async for chunk in server.synthesize_stream(text, voice_profile_id):
                await websocket.send(chunk)
        except Exception as exc:  # noqa: BLE001
            logger.exception("合成請求處理失敗，回傳 error frame 給 client")
            await websocket.send(json.dumps({"error": str(exc)}))

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

    # 啟動時就把權重載入（而不是等第一個請求才觸發延遲載入）：
    #   1. 讓「常駐服務避免每次呼叫重新載入權重」的設計真正生效——第一個
    #      使用者連進來時就是熱的，不用多等一次模型載入時間。
    #   2. 依賴/路徑設定錯誤（例如 CosyVoice repo 沒 vendor 好、缺套件）
    #      會直接在啟動時炸掉、log 清楚易懂，而不是躲到某次 WebSocket
    #      request handler 裡才發作。
    server = _get_model_server()
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, server._load)
        logger.info("CosyVoice 2 權重已於啟動時預先載入完成")
    except Exception:
        logger.exception(
            "CosyVoice 2 啟動時預先載入失敗，服務仍會啟動，"
            "但第一個合成請求會再次嘗試載入並可能重現同樣的錯誤"
        )

    async with websockets.serve(
        _handle_connection, settings.cosyvoice_server_host, settings.cosyvoice_server_port
    ):
        await asyncio.Future()  # 永久執行


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())

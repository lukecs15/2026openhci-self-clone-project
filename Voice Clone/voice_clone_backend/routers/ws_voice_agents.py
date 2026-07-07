"""
routers/ws_voice_agents.py — 多 Agent 語音對話 WebSocket 端點

WebSocket 位址：
    WS /ws/voice-agents/{session_id}

訊息協定詳見 models/schemas.py 底部的 ClientMessage / ServerMessage 說明，
簡述如下：

Client → Server：
    { "type": "init_session", "agents": [AgentConfig, ...],
      "routing_strategy": "llm_decision" | "heuristic" }
    { "type": "user_audio", "audio": "<base64 WAV/PCM>" }
    { "type": "user_text", "text": "..." }
    { "type": "end_session" }

Server → Client：
    { "type": "session_ready", "agents": [...] }
    { "type": "user_transcript", "text": "...", "engine_used": "...", "used_fallback": bool }
    { "type": "routing_decision", "mode": "handoff" | "job_group", "agent_ids": [...] }
    { "type": "agent_speaking_start", "agent_id": "..." }
    { "type": "agent_speaking_chunk", "agent_id": "...", "text": "...", "audio": "<base64>" }
    { "type": "agent_speaking_end", "agent_id": "..." }
    { "type": "error", "message": "..." }

init_session 一律走 build_conversation_session()（見 pipeline/conversation_pipeline.py），
STT/LLM/TTS 三者各自依 config.py 設定獨立決定要不要 mock：STT 一律走真正的
雙引擎邏輯、LLM 看是否已填 API key、TTS 看 tts_engine。不會再有「TTS 設 mock
就連 LLM 也一起被迫變成 mock」的情況（修過的耦合問題）。

修過的 bug：routing_strategy 過去在這裡是 `msg.routing_strategy or "heuristic"`，
只要前端 init_session 沒有明確帶 routing_strategy（或帶了 falsy 值），就一律
「寫死」用 "heuristic"，完全蓋掉 config.py 的 AGENT_ROUTING_STRATEGY 設定值
——也就是說就算後端 .env 設定 AGENT_ROUTING_STRATEGY=llm_decision，只要前端
沒有主動指定，實際生效的永遠是 heuristic，讓 llm_decision 設定形同虛設。
現在改成直接把 msg.routing_strategy 原封不動傳給 build_conversation_session()，
None 時交給該函式自己的 `routing_strategy or settings.agent_routing_strategy`
邏輯去 fallback 用後端設定值，只有前端「明確指定」時才會覆蓋後端設定。

TODO: 加入心跳檢查（ping/pong），防止 WebSocket 超時斷線（可參考既有
      backend/routers/ws_conversation.py 的 _heartbeat() 實作）
TODO: 支援串流音訊輸入（目前 user_audio 假設收到的是一段完整語音）
TODO: 加入 VAD / turn-detection，取代目前「前端自行斷句再送出」的簡化作法
"""

import base64
import json
import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from models.schemas import AgentConfig, ClientMessage
from pipeline.conversation_pipeline import ConversationSession, build_conversation_session

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Voice Agents WebSocket"])


async def _send(ws: WebSocket, payload: dict) -> None:
    try:
        await ws.send_text(json.dumps(payload, ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        logger.debug("WebSocket 送出失敗（連線可能已關閉）：%s", exc)


def _event_to_server_message(event: dict) -> dict:
    """把 orchestrator 吐出的內部事件字典轉成前端可解析的 JSON payload（audio 轉 base64）。"""
    out = dict(event)
    audio_bytes = out.pop("audio_bytes", None)
    if audio_bytes is not None:
        out["audio"] = base64.b64encode(audio_bytes).decode("ascii")
    return out


@router.websocket("/ws/voice-agents/{session_id}")
async def voice_agents_endpoint(ws: WebSocket, session_id: str):
    await ws.accept()
    session: Optional[ConversationSession] = None
    logger.info("WebSocket 連線建立：session_id=%s", session_id)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
                msg = ClientMessage(**data)
            except Exception as exc:  # noqa: BLE001
                await _send(ws, {"type": "error", "message": f"訊息格式錯誤：{exc}"})
                continue

            if msg.type == "init_session":
                agents: list[AgentConfig] = msg.agents or []
                if not agents:
                    await _send(ws, {"type": "error", "message": "init_session 需要至少一個 agent"})
                    continue

                session = build_conversation_session(
                    session_id=session_id,
                    agents=agents,
                    routing_strategy=msg.routing_strategy,
                )
                logger.info(
                    "Session %s 使用路由策略：%s（前端指定：%s）",
                    session_id,
                    session.orchestrator.handoff.strategy,
                    msg.routing_strategy or "(未指定，使用後端預設)",
                )
                await _send(
                    ws,
                    {
                        "type": "session_ready",
                        "agents": [a.model_dump() for a in agents],
                    },
                )

            elif msg.type == "user_audio":
                if session is None or not msg.audio:
                    await _send(ws, {"type": "error", "message": "尚未 init_session 或缺少 audio"})
                    continue
                audio_bytes = base64.b64decode(msg.audio)
                async for event in session.handle_user_audio(audio_bytes):
                    await _send(ws, _event_to_server_message(event))

            elif msg.type == "user_text":
                if session is None or not msg.text:
                    await _send(ws, {"type": "error", "message": "尚未 init_session 或缺少 text"})
                    continue
                async for event in session.handle_user_text(msg.text):
                    await _send(ws, _event_to_server_message(event))

            elif msg.type == "end_session":
                logger.info("Session 結束：session_id=%s", session_id)
                break

    except WebSocketDisconnect:
        logger.info("WebSocket 連線中斷：session_id=%s", session_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("WebSocket 處理發生未預期錯誤：%s", exc)
        await _send(ws, {"type": "error", "message": str(exc)})

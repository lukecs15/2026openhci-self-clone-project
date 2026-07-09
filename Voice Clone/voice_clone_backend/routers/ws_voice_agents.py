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
    { "type": "session_summary", "text": "..." }
    { "type": "error", "message": "..." }

end_session 收到後，如果已經 init_session（session 不是 None），會先呼叫
session.generate_summary()（見 pipeline/conversation_pipeline.py /
agents/orchestrator.py）用整段對話歷史請 LLM 生成一句總結性的鼓勵語，
以 session_summary 事件送給前端，前端可以用這句話 + 融合波形做結束畫面
（見 useVoiceAgentSession.js），送完才真正斷線。生成失敗（例如 LLM API
逾時/出錯）只記 log、不阻塞斷線流程，避免使用者卡在「按了結束卻沒反應」。

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

── end_session 要能立刻中斷正在跑的生成（修過的真實回報問題：按下結束
   對話要等所有 agent 的語音都生成完才會進總結頁面）───────────────────

第一版寫法是最單純的「收到一則訊息才處理、處理完才收下一則」序列迴圈：
`user_text`/`user_audio` 都是 `async for event in session.handle_user_text(...):
await _send(...)` 這樣直接在主收訊迴圈裡「同步跑完」；這代表主迴圈會整個
卡在這個 async for 裡，直到這一輪所有 agent 的完整回覆（LLM 串流 + TTS）
都跑完才會再去 `await ws.receive_text()`。使用者實測回報：在語音生成到一半
時按下「結束對話」，畫面並不會立刻跳到總結頁面，而是要等目前這輪所有
agent 的語音都生成完才會進去——因為前端送出的 end_session 訊息只是靜靜
躺在 WebSocket 的接收緩衝區裡，後端根本還沒空去讀它。

跟辯論模式（routers/ws_debate.py）分析過的根因完全一樣，這裡採用同一套
「背景 asyncio.Task + 隨時可以 cancel」的修法（辯論模式已經驗證有效，
見該檔案開頭「架構差異」說明），但不需要辯論模式那套「持續自己講不停」
的事件佇列/turn_ack 機制——這裡的「一輪」是由使用者的 user_text/user_audio
觸發的一次性生成，不是背景無限迴圈，所以只需要：
    - `current_turn_task`：目前這輪生成的背景 task（沒有生成中時是 None）。
    - 收到 user_text/user_audio：直接 `asyncio.create_task()` 開一個背景
      task 去跑 `session.handle_user_text()`/`handle_user_audio()` 並把
      事件送給前端，主迴圈本身立刻回到 `await ws.receive_text()`，不會被
      這一輪生成卡住，隨時能收到後續訊息（包含 end_session）。
    - 收到 end_session：先 `cancel()` 掉 `current_turn_task`（如果還在跑）
      並等它真的停下來，這一步會讓 CancelledError 沿著
      `agents/orchestrator.py` 的 async generator 鏈往外傳，連
      `_run_job_group()` 平行開出去的每個 agent 背景 task 也會一併被
      cancel（見該檔案的說明），確保「中斷」是真的中斷運算，不是只有
      前端不再收事件、後端其實還在背景繼續跑。task 真的停下來之後才呼叫
      `session.generate_summary()` 並送出 `session_summary`，讓總結頁面
      能立刻出現，不用等生成跑完。
    - 正常情況（沒有按結束）：這一輪的背景 task 本來就會自然跑完，不需要
      額外等待或呼叫 `_cancel_current_turn_task()`；只有在收到下一則
      user_text/user_audio 或 end_session 時才需要確保「上一輪」已經
      結束/被取消，避免兩輪同時跑、事件交錯送給前端（一般使用情境下不會
      發生「上一輪還沒結束就送下一句」，這裡的取消只是保險，不是主要
      使用路徑）。

TODO: 加入心跳檢查（ping/pong），防止 WebSocket 超時斷線（可參考既有
      backend/routers/ws_conversation.py 的 _heartbeat() 實作）
TODO: 支援串流音訊輸入（目前 user_audio 假設收到的是一段完整語音）
TODO: 加入 VAD / turn-detection，取代目前「前端自行斷句再送出」的簡化作法
"""

import asyncio
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


async def _run_turn(ws: WebSocket, session_id: str, event_source) -> None:
    """
    背景執行一輪生成（user_text/user_audio 觸發），把每個事件送給前端。
    抽成獨立函式讓主迴圈可以用 asyncio.create_task() 丟到背景執行，不會
    卡住 `await ws.receive_text()`（見檔案開頭「end_session 要能立刻中斷
    正在跑的生成」說明）。

    刻意不攔截 asyncio.CancelledError：end_session 取消這個 task 時，讓
    取消訊號正常往外傳（跟 agents/debate.py 的取消哲學一致），不需要在
    這裡做任何收尾——已經送出去的事件前端會照樣顯示，還沒送出去的部分
    單純就不會再送，orchestrator 那邊也不會留下講到一半的 history 紀錄
    （見 agents/orchestrator.py 的說明）。
    """
    try:
        async for event in event_source:
            await _send(ws, _event_to_server_message(event))
    except asyncio.CancelledError:
        logger.info("Session %s 目前這輪生成被中斷（使用者結束對話）", session_id)
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Session %s 這一輪生成發生未預期錯誤：%s", session_id, exc)
        await _send(ws, {"type": "error", "message": str(exc)})


@router.websocket("/ws/voice-agents/{session_id}")
async def voice_agents_endpoint(ws: WebSocket, session_id: str):
    await ws.accept()
    session: Optional[ConversationSession] = None
    logger.info("WebSocket 連線建立：session_id=%s", session_id)

    # 目前這一輪生成的背景 task（見檔案開頭「end_session 要能立刻中斷正在
    # 跑的生成」說明），沒有生成中時是 None。
    current_turn_task: Optional[asyncio.Task] = None

    async def _cancel_current_turn_task() -> None:
        nonlocal current_turn_task
        if current_turn_task is not None and not current_turn_task.done():
            current_turn_task.cancel()
            try:
                await current_turn_task
            except asyncio.CancelledError:
                pass
        current_turn_task = None

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
                # 保險起見：正常使用情境下不會「上一輪還沒結束就送下一句」，
                # 這裡先確保沒有殘留的背景 task，避免萬一發生時兩輪事件交錯。
                await _cancel_current_turn_task()
                audio_bytes = base64.b64decode(msg.audio)
                current_turn_task = asyncio.create_task(
                    _run_turn(ws, session_id, session.handle_user_audio(audio_bytes))
                )

            elif msg.type == "user_text":
                if session is None or not msg.text:
                    await _send(ws, {"type": "error", "message": "尚未 init_session 或缺少 text"})
                    continue
                await _cancel_current_turn_task()
                current_turn_task = asyncio.create_task(
                    _run_turn(ws, session_id, session.handle_user_text(msg.text))
                )

            elif msg.type == "end_session":
                logger.info("Session 結束：session_id=%s", session_id)
                # 先中斷目前這一輪生成（見檔案開頭說明），讓使用者不用等
                # LLM/TTS 跑完才進總結頁面，也讓 orchestrator 平行開出去的
                # 每個 agent 背景 task 一併真的停下來。
                await _cancel_current_turn_task()
                if session is not None:
                    try:
                        summary_text = await session.generate_summary()
                        await _send(ws, {"type": "session_summary", "text": summary_text})
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("生成結束總結失敗，略過：%s", exc)
                break

    except WebSocketDisconnect:
        logger.info("WebSocket 連線中斷：session_id=%s", session_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("WebSocket 處理發生未預期錯誤：%s", exc)
        await _send(ws, {"type": "error", "message": str(exc)})
    finally:
        # 連線意外斷開（非正常 end_session 流程）時，同樣要確保背景生成
        # task 被清乾淨，不會留下孤兒 task 繼續在背景跑。
        await _cancel_current_turn_task()

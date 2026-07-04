"""
routers/ws_conversation.py — WebSocket 多物件語音對話端點

WebSocket 位址：
    WS /ws/conversation/{session_id}

訊息協議（JSON）：

Client → Server：
    { "type": "init_session",
      "objects": [{ "object_id", "object_name", "object_description",
                    "model_url", "personality": {...} }],
      "scene_mode": "spatial" | "abstract" }

    { "type": "request_intro", "object_id": "..." }
      → 請求指定物件的自我介紹（Phase 1，每個物件呼叫一次）

    { "type": "user_audio", "audio": "<base64 WAV>" }
      → 使用者語音輸入，觸發 STT + 所有物件依序回應

    { "type": "user_text", "text": "..." }
      → 使用者文字輸入（直接跳過 STT）

    { "type": "scene_mode", "mode": "spatial" | "abstract" }
      → 切換場景模式

    { "type": "end_session" }
      → 結束對話，清除 session

Server → Client：
    { "type": "session_ready", "summary": {...} }
      → init_session 成功後回傳

    { "type": "object_speaking",
      "object_id": "...", "object_name": "...",
      "text": "...", "audio": "<base64 WAV>" }
      → 物件發言（含合成語音）

    { "type": "all_listening" }
      → 通知前端所有物件進入聆聽狀態（用戶開始說話）

    { "type": "user_transcript", "text": "..." }
      → STT 辨識結果回傳給前端顯示

    { "type": "can_end", "show": true }
      → 第 10 次對話後送出，前端顯示結束按鈕

    { "type": "session_ended" }
      → end_session 後送出

    { "type": "error", "message": "..." }
      → 錯誤通知

TODO: 加入心跳檢查（ping/pong），防止 WebSocket 超時斷線
TODO: 支援物件之間的互動（object_to_object 訊息類型）
TODO: 加入 STT 串流（逐字返回 transcript，提升即時感）
"""

import asyncio
import base64
import json
import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from models.schemas import PersonalityAnalyzeResponse, BigFiveScores
from services.conversation_orchestrator import (
    ConversationOrchestrator,
    ObjectPersona,
    get_orchestrator,
)
from services.voice_service import get_voice_service

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Voice WebSocket"])


# ─────────────────────────────────────────────────────────────────────────────
# 輔助函式
# ─────────────────────────────────────────────────────────────────────────────

def _parse_personality(data: Optional[dict]) -> Optional[PersonalityAnalyzeResponse]:
    """從 dict 安全地解析 PersonalityAnalyzeResponse（容錯版）。"""
    if not data:
        return None
    try:
        scores_data = data.get("scores", {})
        scores = BigFiveScores(
            openness=scores_data.get("openness", 3.0),
            conscientiousness=scores_data.get("conscientiousness", 3.0),
            extraversion=scores_data.get("extraversion", 3.0),
            agreeableness=scores_data.get("agreeableness", 3.0),
            neuroticism=scores_data.get("neuroticism", 3.0),
        )
        return PersonalityAnalyzeResponse(
            scores=scores,
            personality_summary=data.get("personality_summary", ""),
            communication_style=data.get("communication_style", ""),
            object_description=data.get("object_description", ""),
            self_description=data.get("self_description", ""),
        )
    except Exception as exc:
        logger.warning("解析 personality 失敗（使用預設）：%s", exc)
        return None


async def _send(ws: WebSocket, payload: dict):
    """安全地送出 JSON 訊息（忽略已關閉的連線）。"""
    try:
        await ws.send_text(json.dumps(payload, ensure_ascii=False))
    except Exception as exc:
        logger.debug("WebSocket 送出失敗（連線可能已關閉）：%s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# 主要 WebSocket Handler
# ─────────────────────────────────────────────────────────────────────────────

async def _heartbeat(ws: WebSocket, interval: int = 20):
    """每 interval 秒送一次 ping，防止 XTTS v2 載入期間 WebSocket idle timeout。"""
    try:
        while True:
            await asyncio.sleep(interval)
            await _send(ws, {"type": "ping"})
    except asyncio.CancelledError:
        pass
    except Exception:
        pass


@router.websocket("/ws/conversation/{session_id}")
async def conversation_ws(ws: WebSocket, session_id: str):
    """
    多物件語音對話的 WebSocket 主入口。

    每個 session_id 對應一個獨立的對話場景。
    連線斷開時自動清理 session（若尚未 end_session）。
    """
    await ws.accept()
    logger.info("WS 連線建立：session_id=%s", session_id)

    orch: ConversationOrchestrator = get_orchestrator()
    voice_svc = get_voice_service()
    session_initialized = False

    # 心跳任務：每 20 秒 ping，防止 XTTS v2 載入期間 WS 因靜默斷線
    heartbeat_task = asyncio.create_task(_heartbeat(ws))

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await _send(ws, {"type": "error", "message": "訊息格式錯誤，需要 JSON"})
                continue

            msg_type = msg.get("type", "")

            # ── init_session ──────────────────────────────────────────────────
            if msg_type == "init_session":
                objects_data = msg.get("objects", [])
                scene_mode = msg.get("scene_mode", "spatial")

                if not objects_data:
                    await _send(ws, {"type": "error", "message": "objects 不能為空"})
                    continue

                personas = []
                for obj_data in objects_data:
                    personality = _parse_personality(obj_data.get("personality"))
                    persona = ObjectPersona(
                        object_id=obj_data.get("object_id", ""),
                        object_name=obj_data.get("object_name", "未知物件"),
                        object_description=obj_data.get("object_description", ""),
                        personality=personality,
                        model_url=obj_data.get("model_url", ""),
                    )
                    personas.append(persona)

                session = await orch.create_session(
                    session_id=session_id,
                    objects=personas,
                    scene_mode=scene_mode,
                )
                session_initialized = True

                await _send(ws, {
                    "type": "session_ready",
                    "session_id": session_id,
                    "summary": session.to_summary(),
                })
                logger.info("Session %s 初始化完成，共 %d 個物件", session_id, len(personas))

            # ── request_intro ─────────────────────────────────────────────────
            elif msg_type == "request_intro":
                if not session_initialized:
                    await _send(ws, {"type": "error", "message": "請先發送 init_session"})
                    continue

                object_id = msg.get("object_id", "")
                result = await orch.generate_intro(session_id, object_id)

                if "error" in result:
                    await _send(ws, {"type": "error", "message": result["error"]})
                    continue

                intro_text = result["text"]
                audio_b64 = await _synthesize_and_encode(voice_svc, intro_text, object_id)

                session = orch.get_session(session_id)
                obj = next((o for o in (session.objects if session else []) if o.object_id == object_id), None)

                await _send(ws, {
                    "type": "object_speaking",
                    "object_id": object_id,
                    "object_name": obj.object_name if obj else "",
                    "text": intro_text,
                    "audio": audio_b64,
                    "phase": "intro",
                })

                # 若 Phase 1 完成，通知前端進入 dialogue
                if result.get("phase_complete"):
                    await _send(ws, {"type": "phase_changed", "phase": "dialogue"})

            # ── user_audio ────────────────────────────────────────────────────
            elif msg_type == "user_audio":
                if not session_initialized:
                    await _send(ws, {"type": "error", "message": "請先發送 init_session"})
                    continue

                audio_b64 = msg.get("audio", "")
                if not audio_b64:
                    await _send(ws, {"type": "error", "message": "audio 欄位不能為空"})
                    continue

                # 通知前端所有物件進入聆聽
                await _send(ws, {"type": "all_listening"})

                # STT
                try:
                    audio_bytes = base64.b64decode(audio_b64)
                    user_text = await voice_svc.transcribe(audio_bytes)
                except Exception as exc:
                    logger.error("STT 失敗：%s", exc)
                    await _send(ws, {"type": "error", "message": f"語音辨識失敗：{exc}"})
                    continue

                if not user_text.strip():
                    await _send(ws, {"type": "error", "message": "未偵測到語音內容，請再試一次"})
                    continue

                # 回傳 STT 結果
                await _send(ws, {"type": "user_transcript", "text": user_text})

                # 處理對話並生成回應
                await _process_and_send_replies(ws, orch, voice_svc, session_id, user_text)

            # ── user_text ─────────────────────────────────────────────────────
            elif msg_type == "user_text":
                if not session_initialized:
                    await _send(ws, {"type": "error", "message": "請先發送 init_session"})
                    continue

                user_text = msg.get("text", "").strip()
                if not user_text:
                    continue

                await _send(ws, {"type": "all_listening"})
                await _send(ws, {"type": "user_transcript", "text": user_text})
                await _process_and_send_replies(ws, orch, voice_svc, session_id, user_text)

            # ── scene_mode ────────────────────────────────────────────────────
            elif msg_type == "scene_mode":
                mode = msg.get("mode", "spatial")
                if mode in ("spatial", "abstract"):
                    await orch.set_scene_mode(session_id, mode)
                    await _send(ws, {"type": "scene_mode_changed", "mode": mode})

            # ── end_session ───────────────────────────────────────────────────
            elif msg_type == "end_session":
                orch.end_session(session_id)
                await _send(ws, {"type": "session_ended"})
                logger.info("Session %s 正常結束", session_id)
                break

            # ── pong（前端回應心跳）────────────────────────────────────────────
            elif msg_type == "pong":
                pass  # 前端還活著，不做任何事

            else:
                await _send(ws, {"type": "error", "message": f"未知的訊息類型：{msg_type}"})

    except WebSocketDisconnect:
        logger.info("WS 連線中斷：session_id=%s", session_id)
        if session_initialized:
            orch.end_session(session_id)
    except Exception as exc:
        logger.error("WS 處理錯誤（session=%s）：%s", session_id, exc, exc_info=True)
        try:
            await _send(ws, {"type": "error", "message": f"伺服器錯誤：{exc}"})
        except Exception:
            pass
        if session_initialized:
            orch.end_session(session_id)
    finally:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# 內部輔助
# ─────────────────────────────────────────────────────────────────────────────

async def _synthesize_and_encode(voice_svc, text: str, object_id: str) -> str:
    """
    合成語音並 base64 編碼。

    若找不到 VoiceProfile，回傳空字串（前端會跳過播放）。
    """
    profile = voice_svc.get_profile(object_id)
    if profile is None:
        # 沒有 profile → 回傳空字串（前端只顯示文字，不播音）
        logger.debug("物件 %s 無 VoiceProfile，跳過 TTS", object_id)
        return ""
    try:
        audio_bytes = await voice_svc.synthesize(text, profile)
        return base64.b64encode(audio_bytes).decode("utf-8")
    except Exception as exc:
        logger.error("TTS 合成失敗（object=%s）：%s", object_id, exc)
        return ""


async def _process_and_send_replies(
    ws: WebSocket,
    orch: ConversationOrchestrator,
    voice_svc,
    session_id: str,
    user_text: str,
):
    """
    流水線版本：Gemini(obj1) → TTS(obj1) → Send(obj1) → Gemini(obj2) → …

    使用 orch.stream_user_input()（async generator），每個物件一完成 Gemini
    就立刻進行 TTS 並推送，不等所有物件的 Gemini 都跑完。
    相比舊版（先等所有 Gemini，再依序 TTS），可消除 (N-1) 個 Gemini 的等待延遲。
    """
    async for reply in orch.stream_user_input(session_id, user_text):
        if "error" in reply:
            await _send(ws, {"type": "error", "message": reply["error"]})
            continue

        object_id = reply["object_id"]
        text = reply["text"]
        audio_b64 = await _synthesize_and_encode(voice_svc, text, object_id)

        await _send(ws, {
            "type": "object_speaking",
            "object_id": object_id,
            "object_name": reply.get("object_name", ""),
            "text": text,
            "audio": audio_b64,
            "phase": "dialogue",
        })

    # 檢查是否達到 10 次對話
    session = orch.get_session(session_id)
    if session and session.can_end:
        await _send(ws, {"type": "can_end", "show": True})

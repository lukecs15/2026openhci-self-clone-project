"""
routers/ws_debate.py — 自我省思／自我成長主題辯論模式 WebSocket 端點

WebSocket 位址：
    WS /ws/voice-debate/{session_id}

訊息協定詳見 models/schemas.py 底部「辯論模式 WebSocket 訊息協定」的說明。

跟 routers/ws_voice_agents.py 最大的架構差異——為什麼不能照抄原本那套
「收到一則訊息才處理、處理完才收下一則」的序列寫法：

一般多 Agent 對話裡，一次 handle_user_text() 的事件串流通常幾秒內就結束，
處理完再收下一則訊息沒什麼問題。但辯論模式裡兩位 agent 是「自己講個不停」
（不需要使用者每次輸入才觸發下一輪），使用者必須能在 agent 生成/播放的
過程中「隨時」送出暫停——如果沿用原本寫法，主迴圈會整個卡在
`async for event in orchestrator.run_next_turn()` 裡等這一輪生成跑完，
完全收不到使用者送來的暫停訊息，暫停就不可能是「立刻」的。

因此這裡把「讓兩位 agent 一直講下去」的邏輯放進一個獨立的 asyncio.Task
（_run_debate_loop，透過 debate_task 變數持有），事件透過 asyncio.Queue
轉發給另一個負責送出的 task（sender_task）；WebSocket 主迴圈本身只單純
不斷 `await ws.receive_text()`，跟這兩個背景 task 完全並行、互不阻塞。
暫停／插話 = 直接對 debate_task 呼叫 cancel()，讓它在目前卡住的
LLM/TTS 呼叫處乾淨中斷（DebateOrchestrator.run_next_turn() 沒有攔截
asyncio.CancelledError，取消會正常往外傳，不會留下沒送出去的半吊子
事件，也不會讓 history 多出一筆「講到一半」的紀錄，見 agents/debate.py
的說明）。

── 等待前端回報播放完成（修過的真實回報問題：插話後接續回應的是錯的
   agent）──────────────────────────────────────────────────────────

`DebateOrchestrator.run_next_turn()` 本身已經有依音訊長度估算的節奏控制
（見 agents/debate.py），但那只是「估計值」：如果前端開著「用瀏覽器語音
朗讀」開關，實際聽到的聲音是瀏覽器 Web Speech API 唸的，唸多久跟後端的
估計是兩回事，往往比估計慢不少。過去 `_run_debate_loop` 講完一輪、睡完
`_INTER_TURN_GAP_SECONDS` 就立刻開始生成下一輪，完全不管前端是不是真的
已經聽完——後端這邊很快就會跑到比使用者實際聽到的還前面好幾輪。這時候
使用者聽著（其實是舊的）某位 agent 的聲音按下暫停，以為自己打斷的是他
正在聽的那位，但後端當下真正在生成／被取消的其實是後面別輪的另一位
agent，插話後接續回應的自然就對不上使用者的預期。

修法：新增 `turn_played` 訊息，前端在真的播完某一輪的音訊/朗讀之後才會
送出（見 useDebateSession.js 的事件序列化管線說明）。`_run_debate_loop`
講完一輪後，不會馬上生成下一輪，而是先 `turn_ack_event.clear()` 再等待
這個事件被 set（也就是等前端送 `turn_played`），逾時（`_TURN_ACK_TIMEOUT_SECONDS`）
則放棄等待、照樣往下走，避免前端萬一沒有回報（例如瀏覽器完全不支援
音訊播放）讓辯論卡死不動。這樣後端最多只會比前端「正在播放/剛播完的
那一輪」領先一輪（也就是正在生成中的下一輪），暫停時 `current_speaker_id`
所代表的 agent 就會跟使用者實際聽到、想打斷的那位一致。

── 達到回合上限那一輪也要等播完才送 debate_finished（修過的真實回報
   問題：插話按鈕在提示訊息出現後又跳回來、按了暫停卻打不開輸入框）──

上面這段等待邏輯過去只套用在「還沒結束」的轉場（換下一位 agent之前），
達到 `DEBATE_MAX_TURNS` 上限、真正讓 `orchestrator.is_finished` 變成
`True` 的那一輪反而是唯一沒有等待就直接送出 `debate_finished` 的一輪：
`while` 迴圈在該輪的所有事件（含 `agent_speaking_end`）都進了
`event_queue` 之後立刻 `break`，`turn_ack_event` 完全沒被等待過。這一輪
的音訊／朗讀在前端可能還要好幾秒才會真的播完，但 `debate_finished` 幾乎
是緊接在 `agent_speaking_end` 後面就送到前端——這正是使用者實測懷疑的
「生成已經到上限，但語音還沒播完」。更麻煩的是前端 `debate_finished`
是直接 dispatch（不像 `agent_speaking_*` 事件要排進序列化管線等播放
真的完成），這一輪自己的 `agent_speaking_start` 事件如果排在管線裡稍晚
才被處理到，會把畫面狀態蓋回「進行中」，插話按鈕因此重新跳出來；這時
使用者按下暫停，前端會送出 `pause_debate`，但後端的 `debate_task` 其實
早就 `done()`（`_run_debate_loop` 已經整個結束），`_cancel_debate_task()`
判斷 task 已完成就不會做任何事，自然也不會回傳 `debate_paused`——前端
`status` 永遠等不到 `'paused'`，插話輸入框（只在 `status === 'paused'`
才顯示，見 `DebateStage.jsx`）就一直不會出現，使用者看到的就是「暫停
按鈕按下去確實讓聲音停了（前端本地立刻停止播放），但打不開輸入框」。

修法：把 `turn_ack_event` 的等待挪到 `is_finished` 判斷「之前」，不管
這一輪是不是最後一輪都要先等前端回報播完，才決定要不要 `break`——這樣
`debate_finished` 保證是在最後一輪真的被前端確認播完之後才會送出，前端
不會再有「訊息/按鈕狀態被最後一輪事件蓋回去」的問題，`pause_debate`
自然也不會再遇到 `debate_task` 已經 done() 的情況。`_run_debate_loop`
因此從 `voice_debate_endpoint` 裡的 closure 抽成模組層級函式，方便直接
用真正的 `DebateOrchestrator`（`max_turns=1`）單元測試「最後一輪也會
等 ack」這個修過的行為（見 tests/test_ws_debate.py）。

── user_intervene_audio（VR 版新增）─────────────────────────────────────
網頁版插話刻意只吃文字（見 agents/debate.py 檔案開頭說明）。VR 版
（voice_clone_unity）的使用者敲法槌插話改用語音，這裡新增
`user_intervene_audio` 訊息類型：先呼叫 `session.transcribe_intervention_
audio()`（見 pipeline/debate_pipeline.py，重用既有 STTService 雙引擎
架構）送出 `user_transcript` 事件，辨識到非空文字才會照跟 `user_intervene`
完全相同的流程繼續（取消背景 task → inject_user_message → ack →
重啟背景 task）。完整協定說明見 models/schemas.py 底部。
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from agents.debate import DEFAULT_DEBATE_TOPICS, DebateOrchestrator, build_custom_topic
from models.schemas import AgentConfig, DebateClientMessage
from pipeline.debate_pipeline import DebateSession, build_debate_session

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Voice Debate WebSocket"])

# 換人發言之間額外留白的秒數（自然的對話停頓感）。DebateOrchestrator.
# run_next_turn() 本身已經會依該輪預估播放時長做節奏控制（見
# agents/debate.py 檔案開頭「節奏控制」說明），這裡再加一小段固定停頓，
# 模擬真人對話「等對方講完，稍微停頓一下才接話」的感覺，不會讓兩位
# agent 一講完立刻無縫接上下一句。
_INTER_TURN_GAP_SECONDS = 0.6

# 等待前端回報 turn_played 的逾時秒數（見檔案開頭「等待前端回報播放完成」
# 說明）。純粹是安全網，避免前端萬一沒有回報（連線異常、瀏覽器完全不支援
# 音訊播放等極端情況）讓辯論背景迴圈卡死不動；正常情況下前端會在真的播完
# 那一輪之後很快送出，不會真的等到逾時。
_TURN_ACK_TIMEOUT_SECONDS = 20.0


async def _send(ws: WebSocket, payload: dict) -> None:
    try:
        await ws.send_text(json.dumps(payload, ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        logger.debug("WebSocket 送出失敗（連線可能已關閉）：%s", exc)


async def _wait_for_turn_ack(event: asyncio.Event, timeout: float) -> None:
    """
    等待前端回報「這一輪播放完成」（event 被 set），逾時就放棄等待、直接
    往下走，不讓辯論背景迴圈卡死。抽成獨立函式方便單元測試「事件已經
    set」與「逾時」兩種情境，不需要真的跑一整個 WebSocket 連線。
    """
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        logger.warning("等待前端 turn_played 回報逾時（%.1fs），改用固定停頓繼續", timeout)


def _event_to_server_message(event: dict) -> dict:
    """把 orchestrator 吐出的內部事件字典轉成前端可解析的 JSON payload（audio 轉 base64）。"""
    out = dict(event)
    audio_bytes = out.pop("audio_bytes", None)
    if audio_bytes is not None:
        out["audio"] = base64.b64encode(audio_bytes).decode("ascii")
    return out


async def _run_debate_loop(
    orchestrator: DebateOrchestrator,
    event_queue: "asyncio.Queue[Optional[dict]]",
    turn_ack_event: asyncio.Event,
    ack_timeout: float = _TURN_ACK_TIMEOUT_SECONDS,
    inter_turn_gap: float = _INTER_TURN_GAP_SECONDS,
) -> None:
    """
    背景持續讓兩位 agent 輪流講下去，直到暫停（cancel）或達到回合上限。

    抽成模組層級函式（而不是 voice_debate_endpoint 裡的 closure），方便
    直接用真正的 DebateOrchestrator（max_turns=1）單元測試「連最後一輪
    也會等前端 turn_played 才送出 debate_finished」這個修過的行為，見
    檔案開頭「達到回合上限那一輪也要等播完才送 debate_finished」說明。

    ── 預生成下一輪（延遲優化，穿透式串流版）───────────────────────────
    舊版流程是「這一輪播完（等 turn_played）→ 停頓 → 才開始生成下一輪」，
    換人發言的空檔 = 下一輪完整的 LLM 首句 + TTS 首 chunk 延遲。現在改成：
    這一輪事件釋出後**立刻**開始生成下一輪（_emit_turn），搭配一個
    「釋出閘門」（release gate，由背景的 _open_release_gate 在收到
    turn_played + 自然停頓之後打開）：

      - 閘門還沒開：生成出來的事件先扣在本地 buffer。
      - 閘門打開（不管生成到一半還是已生成完）：buffer 先倒出去，之後的
        事件改為**直通串流**——跟第一輪一樣邊生成邊送。

    這個「穿透」設計是實測修過的問題：第一版把投機輪做成「整輪生成完
    才一次釋出」，在 TTS 生成比實際播放慢的機器上（生成 15 秒音訊要花
    超過 15 秒），換人空檔變成「整輪生成時間 − 上一輪播放時間」，比舊版
    「只等第一句生成」還要久。穿透式串流讓換人空檔 =
    max(上一輪剩餘播放時間 + 停頓, 首句生成時間)，嚴格優於兩個舊版本。

    投機生成的取消語意：只有「這一輪已完整生成、而且一個事件都還沒釋出」
    （使用者完全沒聽到）時才用 `orchestrator.rollback_state()` 還原狀態，
    避免插話後的接續回應與判決書參照一段使用者沒聽過的「幽靈發言」；
    生成中途被取消時 run_next_turn() 本來就不寫入狀態（rollback 冪等），
    已釋出部分事件的輪次則視同「正在播放中被打斷」，比照舊版行為不回滾。

    turn_ack_event 的 clear 時機：某一輪事件全數釋出之後立刻清掉。前端
    要等播完該輪（處理到 agent_speaking_end）才會送 turn_played，必然晚
    於釋出當下，不會有 ack 被提早吃掉的競態；逾時後才遲到的舊 ack 也會
    在下一輪釋出後被 clear 掉，不會被誤認成下一輪的回報。
    """
    gate_opener: Optional[asyncio.Task] = None
    try:
        release_gate = asyncio.Event()
        release_gate.set()  # 第一輪（含插話後重啟的第一輪）：立即直通串流
        while True:
            emitted_any = await _emit_turn(orchestrator, event_queue, release_gate)
            if gate_opener is not None:
                gate_opener.cancel()  # 正常情況已完成，這裡只是保險
                gate_opener = None
            if not emitted_any and orchestrator.is_finished:
                break  # 重啟時就已達回合上限：沒有新事件，直接收尾

            # 這一輪事件已全數釋出，接下來才會收到它的 turn_played：先歸零。
            turn_ack_event.clear()

            if orchestrator.is_finished:
                # 最後一輪也要等前端確認播完，debate_finished 才不會搶在
                # 音訊播完前送出（見檔案開頭說明）。
                await _wait_for_turn_ack(turn_ack_event, ack_timeout)
                break

            # 立刻開始生成下一輪（回到迴圈頂端的 _emit_turn），釋出時機
            # 交給背景的 gate opener（等這一輪的 turn_played + 停頓）。
            release_gate = asyncio.Event()
            gate_opener = asyncio.create_task(
                _open_release_gate(turn_ack_event, release_gate, ack_timeout, inter_turn_gap)
            )
        event_queue.put_nowait({"type": "debate_finished"})
    except asyncio.CancelledError:
        event_queue.put_nowait(
            {"type": "debate_paused", "agent_id": orchestrator.current_speaker_id}
        )
        raise
    finally:
        if gate_opener is not None and not gate_opener.done():
            gate_opener.cancel()


async def _open_release_gate(
    turn_ack_event: asyncio.Event,
    release_gate: asyncio.Event,
    ack_timeout: float,
    inter_turn_gap: float,
) -> None:
    """背景等待「上一輪播完（turn_played）＋自然停頓」後打開釋出閘門，
    讓 _emit_turn 裡投機生成中的下一輪開始（穿透式）釋出事件。"""
    await _wait_for_turn_ack(turn_ack_event, ack_timeout)
    if inter_turn_gap > 0:
        await asyncio.sleep(inter_turn_gap)
    release_gate.set()


async def _emit_turn(
    orchestrator: DebateOrchestrator,
    event_queue: "asyncio.Queue[Optional[dict]]",
    release_gate: asyncio.Event,
) -> bool:
    """
    生成一輪並釋出事件（穿透式串流，見 _run_debate_loop 的說明）：
    release_gate 打開之前生成的事件扣在本地 buffer；打開之後（不管是
    生成前、生成中還是生成完才開）buffer 先倒出、其餘直通串流。

    回傳這一輪是否有任何事件（False = orchestrator 已達回合上限，
    run_next_turn() 直接返回）。

    取消語意：「已完整生成且一個事件都沒釋出」→ rollback（使用者沒聽
    過這一輪）；其餘情況不回滾（生成中途取消本來就不寫入狀態；已釋出
    部分事件視同播放中被打斷）。
    """
    buffer: list[dict] = []
    emitted_any = False
    released_any = False
    generation_done = False
    snapshot = orchestrator.snapshot_state()
    try:
        async for event in orchestrator.run_next_turn():
            emitted_any = True
            if release_gate.is_set():
                for buffered in buffer:
                    event_queue.put_nowait(buffered)
                buffer.clear()
                event_queue.put_nowait(event)
                released_any = True
            else:
                buffer.append(event)
        generation_done = True

        if not release_gate.is_set():
            await release_gate.wait()
        for buffered in buffer:
            event_queue.put_nowait(buffered)
            released_any = True
        buffer.clear()
        return emitted_any
    except asyncio.CancelledError:
        if generation_done and not released_any:
            orchestrator.rollback_state(snapshot)
        raise


@router.websocket("/ws/voice-debate/{session_id}")
async def voice_debate_endpoint(ws: WebSocket, session_id: str):
    await ws.accept()
    logger.info("辯論模式 WebSocket 連線建立：session_id=%s", session_id)

    session: Optional[DebateSession] = None
    event_queue: "asyncio.Queue[Optional[dict]]" = asyncio.Queue()
    debate_task: Optional[asyncio.Task] = None
    # 見檔案開頭「等待前端回報播放完成」說明：每輪講完後先清掉，等前端送
    # turn_played 才 set，_run_debate_loop 才會繼續生成下一輪。
    turn_ack_event = asyncio.Event()

    async def _cancel_debate_task() -> None:
        nonlocal debate_task
        if debate_task is not None and not debate_task.done():
            debate_task.cancel()
            try:
                await debate_task
            except asyncio.CancelledError:
                pass
        debate_task = None

    async def _drain_queue_to_client() -> None:
        while True:
            event = await event_queue.get()
            if event is None:
                return
            await _send(ws, _event_to_server_message(event))

    sender_task = asyncio.create_task(_drain_queue_to_client())

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
                msg = DebateClientMessage(**data)
            except Exception as exc:  # noqa: BLE001
                await _send(ws, {"type": "error", "message": f"訊息格式錯誤：{exc}"})
                continue

            if msg.type == "init_debate_session":
                # 自訂議題（VR/手機 onboarding 流程）：topic_id="custom" +
                # topic_title 動態組出主題；topic_id 不在預設清單但有帶
                # topic_title 時也視為自訂議題（呼叫端漏寫 "custom" 的防呆）。
                if msg.topic_id == "custom" or (
                    msg.topic_id not in DEFAULT_DEBATE_TOPICS and msg.topic_title
                ):
                    topic = build_custom_topic(msg.topic_title or "")
                else:
                    topic = DEFAULT_DEBATE_TOPICS.get(msg.topic_id or "")
                agents: list[AgentConfig] = msg.agents or []
                if topic is None:
                    await _send(ws, {"type": "error", "message": f"未知的辯論主題：{msg.topic_id}"})
                    continue
                if len(agents) != 2:
                    await _send(ws, {"type": "error", "message": "辯論模式需要恰好指定 2 位 agent"})
                    continue

                session = build_debate_session(
                    session_id=session_id,
                    agent_a=agents[0],
                    agent_b=agents[1],
                    topic=topic,
                    # final web 三情境體驗可逐場覆寫回合上限（不帶=沿用 config）
                    max_turns=msg.max_turns,
                )
                await _send(
                    ws,
                    {
                        "type": "debate_ready",
                        "agents": [a.model_dump() for a in agents],
                        "topic_id": topic.topic_id,
                        "topic_title": topic.title,
                    },
                )
                debate_task = asyncio.create_task(
                    _run_debate_loop(session.orchestrator, event_queue, turn_ack_event)
                )

            elif msg.type == "pause_debate":
                if session is None:
                    await _send(ws, {"type": "error", "message": "尚未 init_debate_session"})
                    continue
                await _cancel_debate_task()

            elif msg.type == "user_intervene":
                if session is None or not msg.text:
                    await _send(ws, {"type": "error", "message": "尚未 init_debate_session 或缺少 text"})
                    continue
                # 保險起見：插話前一定要確保沒有背景 task 還在跑（正常流程前端會先
                # 送 pause_debate 再送插話，這裡即使前端沒照順序做也不會壞掉）。
                await _cancel_debate_task()
                session.orchestrator.inject_user_message(msg.text)
                await _send(ws, {"type": "user_intervene_ack", "text": msg.text})
                debate_task = asyncio.create_task(
                    _run_debate_loop(session.orchestrator, event_queue, turn_ack_event)
                )

            elif msg.type == "user_intervene_audio":
                # VR 語音插話（見 models/schemas.py「user_intervene_audio」
                # 說明）：先轉錄、送 user_transcript 讓前端知道辨識結果，
                # 再走跟 user_intervene 完全相同的流程。轉錄失敗（STT primary
                # 與 fallback 皆逾時/例外，見 services/stt_service.py）只回報
                # error，不取消目前背景 task、不當作插話送出——使用者可以
                # 再敲一次法槌重試，不會因為一次辨識失敗就打斷正在進行的辯論。
                if session is None or not msg.audio:
                    await _send(ws, {"type": "error", "message": "尚未 init_debate_session 或缺少 audio"})
                    continue
                audio_bytes = base64.b64decode(msg.audio)
                try:
                    transcript_event = await session.transcribe_intervention_audio(audio_bytes)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("辯論模式插話語音辨識失敗：%s", exc)
                    await _send(ws, {"type": "error", "message": f"語音辨識失敗：{exc}"})
                    continue
                await _send(ws, transcript_event)
                intervene_text = (transcript_event.get("text") or "").strip()
                if not intervene_text:
                    await _send(ws, {"type": "error", "message": "沒有辨識到任何內容，請再說一次"})
                    continue
                await _cancel_debate_task()
                session.orchestrator.inject_user_message(intervene_text)
                await _send(ws, {"type": "user_intervene_ack", "text": intervene_text})
                debate_task = asyncio.create_task(
                    _run_debate_loop(session.orchestrator, event_queue, turn_ack_event)
                )

            elif msg.type == "turn_played":
                # 見檔案開頭「等待前端回報播放完成」說明；沒有 session/還沒
                # 開始討論時收到這則訊息不需要視為錯誤，安靜忽略即可（例如
                # 前端斷線重連時序偶發錯亂）。
                turn_ack_event.set()

            elif msg.type == "end_session":
                logger.info("辯論 Session 結束：session_id=%s", session_id)
                # 必須先取消背景的 _run_debate_loop task，理由：
                #   1. 避免它繼續往 event_queue 塞下一輪事件，跟即將送出的
                #      session_summary 搶時序。
                #   2. 跟 pause_debate / user_intervene 用同一套收尾方式，
                #      不需要另外處理「task 還在跑」的情況。
                await _cancel_debate_task()
                if session is not None:
                    # 「內在法庭」判決書為主要產物（見 agents/debate.py 的
                    # generate_verdict()），text 欄位帶結語一句話，向後相容
                    # 只讀 text 的既有前端；verdict 欄位給 Unity 判決書面板
                    # 與手機 ResultPage 使用。
                    try:
                        verdict = await session.generate_verdict()
                        await _send(
                            ws,
                            {
                                "type": "session_summary",
                                "text": verdict.get("closing_line", ""),
                                "verdict": verdict,
                            },
                        )
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("生成判決書失敗，改用一句總結語：%s", exc)
                        try:
                            summary_text = await session.generate_summary()
                            await _send(ws, {"type": "session_summary", "text": summary_text})
                        except Exception as exc2:  # noqa: BLE001
                            logger.warning("生成結束總結失敗，略過：%s", exc2)
                break

    except WebSocketDisconnect:
        logger.info("辯論模式 WebSocket 連線中斷：session_id=%s", session_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("辯論模式 WebSocket 處理發生未預期錯誤：%s", exc)
        await _send(ws, {"type": "error", "message": str(exc)})
    finally:
        await _cancel_debate_task()
        event_queue.put_nowait(None)
        sender_task.cancel()
        try:
            await sender_task
        except asyncio.CancelledError:
            pass
# （檔尾註解：預生成下一輪的行為測試見 tests/test_ws_debate.py）

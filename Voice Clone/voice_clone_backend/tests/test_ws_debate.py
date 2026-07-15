"""
tests/test_ws_debate.py — routers/ws_debate.py 的輔助邏輯測試

測試抽出來的 `_wait_for_turn_ack()`（等待前端回報播放完成、逾時就放棄
等待）與 `_run_debate_loop()`（背景讓兩位 agent 輪流講下去的主迴圈，含
「達到回合上限那一輪也要先等 ack 才送 debate_finished」的修過的行為，
見 routers/ws_debate.py 檔案開頭「達到回合上限那一輪也要等播完才送
debate_finished」說明），不測試整條 WebSocket 連線——專案裡目前沒有
其他 WS 端點層級的測試（ws_voice_agents.py 也沒有），照同樣的慣例只測
「可以獨立驗證的純邏輯」，`_run_debate_loop` 已經是模組層級函式、吃
真正的 DebateOrchestrator 當參數，直接用真的 orchestrator（max_turns=1）
就能測，不需要另外搭一個假的。
"""

import asyncio

import pytest

from agents.debate import DEFAULT_DEBATE_TOPICS, DebateOrchestrator
from routers.ws_debate import _run_debate_loop, _wait_for_turn_ack
from services.llm_service import MockLLMService
from services.tts_service import MockTTSService


async def _instant_sleep(seconds):
    """跟 tests/test_debate.py 一樣：立即完成的假 pacing sleep，不拖慢測試。"""
    return None


def _build_debate(sample_agents, max_turns=1):
    topic = DEFAULT_DEBATE_TOPICS["failure"]
    return DebateOrchestrator(
        agent_a=sample_agents[0],
        agent_b=sample_agents[1],
        topic=topic,
        llm_service=MockLLMService(scripted_reply="我覺得可以這樣做。"),
        tts_service=MockTTSService(),
        pacing_sleep_fn=_instant_sleep,
        max_turns=max_turns,
    )


@pytest.mark.asyncio
async def test_wait_for_turn_ack_returns_immediately_when_already_set():
    event = asyncio.Event()
    event.set()

    start = asyncio.get_event_loop().time()
    await _wait_for_turn_ack(event, timeout=5.0)
    elapsed = asyncio.get_event_loop().time() - start

    assert elapsed < 0.1


@pytest.mark.asyncio
async def test_wait_for_turn_ack_returns_once_event_is_set_concurrently():
    event = asyncio.Event()

    async def _set_soon():
        await asyncio.sleep(0.01)
        event.set()

    asyncio.create_task(_set_soon())
    # 不應該拋例外，也不應該真的等到 timeout 那麼久
    await asyncio.wait_for(_wait_for_turn_ack(event, timeout=5.0), timeout=1.0)
    assert event.is_set()


@pytest.mark.asyncio
async def test_wait_for_turn_ack_gives_up_gracefully_on_timeout():
    event = asyncio.Event()  # 故意不 set，模擬前端沒有回報

    # 用很短的 timeout 讓測試快速跑完；函式本身不應該拋出例外，逾時後
    # 應該正常返回（呼叫端可以繼續往下走，不會卡死）。
    await _wait_for_turn_ack(event, timeout=0.05)
    assert not event.is_set()


@pytest.mark.asyncio
async def test_run_debate_loop_waits_for_ack_even_on_final_turn(sample_agents):
    """
    修過的真實回報問題：達到 max_turns 的最後一輪過去會跳過 ack 等待，
    debate_finished 幾乎緊接在該輪 agent_speaking_end 之後就送出，導致
    前端在該輪音訊/朗讀都還沒播完時就提早顯示「已達上限」、隱藏插話
    按鈕，播完之後管線才把這一輪的 agent_speaking_start 等事件 dispatch
    出來，又把畫面狀態蓋回「進行中」。

    用 max_turns=1（一輪就結束）驗證：故意不送 turn_played，
    `_run_debate_loop` 仍然會先等滿 ack_timeout 才把 debate_finished
    放進 queue——證明「最後一輪」跟其他輪一樣會等待，不會被 is_finished
    提早跳過。
    """
    orchestrator = _build_debate(sample_agents, max_turns=1)
    event_queue = asyncio.Queue()
    turn_ack_event = asyncio.Event()  # 故意不 set，模擬前端沒有回報 turn_played

    start = asyncio.get_event_loop().time()
    await _run_debate_loop(
        orchestrator,
        event_queue,
        turn_ack_event,
        ack_timeout=0.1,
        inter_turn_gap=0,
    )
    elapsed = asyncio.get_event_loop().time() - start

    # 一定要真的等過 ack_timeout 才會送出 debate_finished，不能提早跳過。
    assert elapsed >= 0.1

    events = []
    while not event_queue.empty():
        events.append(event_queue.get_nowait())

    assert events[-1] == {"type": "debate_finished"}
    # 最後一輪本身的 agent_speaking_start/end 事件應該已經送出（真的有講完
    # 這一輪，只是 debate_finished 要等 ack 才會接在後面）。
    assert any(e.get("type") == "agent_speaking_start" for e in events)
    assert any(e.get("type") == "agent_speaking_end" for e in events)


@pytest.mark.asyncio
async def test_snapshot_rollback_restores_orchestrator_state(sample_agents):
    """
    投機生成的還原基礎：跑完一輪後 snapshot，再跑（投機）一輪，rollback
    之後 history / turn_count / current_speaker_id 都要回到 snapshot 當下，
    對「還沒投機」的狀態呼叫 rollback 也要是無害的（冪等）。
    """
    orchestrator = _build_debate(sample_agents, max_turns=6)
    async for _ in orchestrator.run_next_turn():
        pass

    snapshot = orchestrator.snapshot_state()
    history_len, turn_count, speaker_id = snapshot

    # 冪等：沒有投機任何東西時 rollback 不改變狀態。
    orchestrator.rollback_state(snapshot)
    assert orchestrator.snapshot_state() == snapshot

    # 投機一輪後 rollback：狀態完整還原。
    async for _ in orchestrator.run_next_turn():
        pass
    assert orchestrator.turn_count == turn_count + 1
    orchestrator.rollback_state(snapshot)
    assert len(orchestrator.history) == history_len
    assert orchestrator.turn_count == turn_count
    assert orchestrator.current_speaker_id == speaker_id


@pytest.mark.asyncio
async def test_run_debate_loop_prefetch_holds_next_turn_until_ack(sample_agents):
    """
    預生成下一輪的核心行為：第一輪事件送出後，迴圈會在「前端還沒回報
    turn_played」的情況下就先把下一輪生成好（turn_count 前進到 2），但
    事件必須扣在 buffer 裡不能進 queue——queue 裡只能看到第一輪的
    agent_speaking_start。
    """
    orchestrator = _build_debate(sample_agents, max_turns=6)
    event_queue = asyncio.Queue()
    turn_ack_event = asyncio.Event()  # 故意不 set：前端「一直在播第一輪」

    task = asyncio.create_task(
        _run_debate_loop(orchestrator, event_queue, turn_ack_event, ack_timeout=30.0, inter_turn_gap=0)
    )
    try:
        # 等投機生成完成（turn_count 到 2 代表第二輪已經生成完、扣在 buffer）
        for _ in range(500):
            if orchestrator.turn_count >= 2:
                break
            await asyncio.sleep(0.01)
        assert orchestrator.turn_count == 2

        events = []
        while not event_queue.empty():
            events.append(event_queue.get_nowait())
        starts = [e for e in events if e.get("type") == "agent_speaking_start"]
        assert len(starts) == 1, "投機生成的第二輪事件不應該在 ack 之前釋出"

        # 投機生成的深度上限是「一輪」：第二輪生成完後，第三輪在收到
        # turn_played 之前絕對不能開始（_emit_turn 會卡在 release_gate，
        # 迴圈不會前進到下一次生成）——不會在背後無限往後生、燒 API 額度。
        await asyncio.sleep(0.3)
        assert orchestrator.turn_count == 2, "不應該在沒有 ack 的情況下繼續生成第三輪"
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


@pytest.mark.asyncio
async def test_run_debate_loop_cancel_discards_prefetched_turn(sample_agents):
    """
    插話取消時，投機生成（使用者沒聽過）的那一輪必須被整個丟棄：
    turn_count 回到 1、history 裡沒有第二輪的發言——否則插話後的接續
    回應與判決書會參照一段「幽靈發言」。
    """
    orchestrator = _build_debate(sample_agents, max_turns=6)
    event_queue = asyncio.Queue()
    turn_ack_event = asyncio.Event()  # 不 set：迴圈投機完會卡在等 ack

    task = asyncio.create_task(
        _run_debate_loop(orchestrator, event_queue, turn_ack_event, ack_timeout=30.0, inter_turn_gap=0)
    )
    for _ in range(500):
        if orchestrator.turn_count >= 2:
            break
        await asyncio.sleep(0.01)
    assert orchestrator.turn_count == 2

    history_before_cancel = len(orchestrator.history)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

    assert orchestrator.turn_count == 1
    assert len(orchestrator.history) == history_before_cancel - 1

    events = []
    while not event_queue.empty():
        events.append(event_queue.get_nowait())
    # 取消後照舊送出 debate_paused（前端據此顯示「已暫停」）。
    assert events[-1] == {
        "type": "debate_paused",
        "agent_id": orchestrator.current_speaker_id,
    }


@pytest.mark.asyncio
async def test_run_debate_loop_final_turn_finishes_promptly_once_ack_arrives(sample_agents):
    """
    對照組：如果前端很快就送出 turn_played（模擬正常播放完成），最後一輪
    不應該白白等滿整個 ack_timeout——確保修法沒有把「正常情況」拖慢，
    只是把「這一輪真的播完了嗎」這件事真的等到答案而已。
    """
    orchestrator = _build_debate(sample_agents, max_turns=1)
    event_queue = asyncio.Queue()
    turn_ack_event = asyncio.Event()

    async def _ack_soon():
        await asyncio.sleep(0.01)
        turn_ack_event.set()

    asyncio.create_task(_ack_soon())

    # 用 wait_for 包住：如果修法讓最後一輪還是白白等滿 ack_timeout（5 秒），
    # 這裡會逾時失敗，證明 ack 提早到達時不會被無謂拖慢。
    await asyncio.wait_for(
        _run_debate_loop(
            orchestrator,
            event_queue,
            turn_ack_event,
            ack_timeout=5.0,
            inter_turn_gap=0,
        ),
        timeout=1.0,
    )

    events = []
    while not event_queue.empty():
        events.append(event_queue.get_nowait())
    assert events[-1] == {"type": "debate_finished"}

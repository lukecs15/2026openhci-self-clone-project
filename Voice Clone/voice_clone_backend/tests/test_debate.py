"""
tests/test_debate.py — DebateOrchestrator（agents/debate.py）迴歸測試

涵蓋需求：
    - 三個預設主題存在且內容完整
    - 兩位 agent 輪流發言、history 正確記錄講者
    - 「暫停＝中斷生成」：取消 run_next_turn() 不會留下半吊子的 history/狀態
    - 使用者插話後由「原本被打斷的那位」agent 接續回應（current_speaker_id 不變）
    - 對話歷史組訊息格式（顯示名稱：/ 使用者：前綴）
    - 達到 max_turns 上限後自動停止
    - 節奏控制：換人發言前依預估播放時長 sleep，取消發生在節奏控制期間
      跟取消發生在生成期間效果一樣（見 test_run_next_turn_cancellation_
      during_pacing_leaves_state_untouched）

測試預設把 pacing_sleep_fn 換成立即完成的假版本（_instant_sleep），避免
節奏控制真的讓測試套件變慢；需要驗證節奏控制本身時，改用會記錄呼叫時長
的假版本，一樣不會真的等待。
"""

import asyncio

import pytest

from agents.debate import DEFAULT_DEBATE_TOPICS, DebateOrchestrator, _audio_duration_ms
from models.schemas import LLMTextChunk, TTSAudioChunk
from services.llm_service import MockLLMService
from services.tts_service import MockTTSService


async def _instant_sleep(seconds):
    """測試預設用的假 pacing sleep：立即完成，不會真的拖慢測試套件。"""
    return None


def _build_debate(sample_agents, topic_id="failure", **kwargs):
    topic = DEFAULT_DEBATE_TOPICS[topic_id]
    debate = DebateOrchestrator(
        agent_a=sample_agents[0],
        agent_b=sample_agents[1],
        topic=topic,
        llm_service=kwargs.pop("llm_service", MockLLMService(scripted_reply="我覺得可以這樣做。")),
        tts_service=kwargs.pop("tts_service", MockTTSService()),
        pacing_sleep_fn=kwargs.pop("pacing_sleep_fn", _instant_sleep),
        **kwargs,
    )
    return debate


def test_default_debate_topics_has_three_entries_with_content():
    assert len(DEFAULT_DEBATE_TOPICS) == 3
    for topic_id, topic in DEFAULT_DEBATE_TOPICS.items():
        assert topic.topic_id == topic_id
        assert topic.title
        assert topic.seed_prompt


def test_open_debate_seeds_history_once(sample_agents):
    debate = _build_debate(sample_agents)
    debate.open_debate()
    assert len(debate.history) == 1
    assert debate.history[0]["role"] == "user"
    assert debate.topic.title in debate.history[0]["text"]

    debate.open_debate()  # 重複呼叫不應該重複塞入
    assert len(debate.history) == 1


def test_current_speaker_defaults_to_agent_a(sample_agents):
    debate = _build_debate(sample_agents)
    assert debate.current_speaker_id == sample_agents[0].agent_id


def test_rejects_two_identical_agents(sample_agents):
    topic = DEFAULT_DEBATE_TOPICS["failure"]
    with pytest.raises(ValueError):
        DebateOrchestrator(
            agent_a=sample_agents[0],
            agent_b=sample_agents[0],
            topic=topic,
            llm_service=MockLLMService(),
            tts_service=MockTTSService(),
        )


@pytest.mark.asyncio
async def test_run_next_turn_alternates_speakers_and_records_history(sample_agents):
    debate = _build_debate(sample_agents)
    debate.open_debate()

    events_1 = [e async for e in debate.run_next_turn()]
    assert events_1[0] == {"type": "agent_speaking_start", "agent_id": "agent-a"}
    assert events_1[-1] == {"type": "agent_speaking_end", "agent_id": "agent-a"}
    assert debate.history[-1]["agent_id"] == "agent-a"
    assert debate.history[-1]["text"] == "我覺得可以這樣做。"
    assert debate.current_speaker_id == "agent-b"
    assert debate.turn_count == 1

    events_2 = [e async for e in debate.run_next_turn()]
    assert events_2[0]["agent_id"] == "agent-b"
    assert debate.history[-1]["agent_id"] == "agent-b"
    assert debate.current_speaker_id == "agent-a"
    assert debate.turn_count == 2


@pytest.mark.asyncio
async def test_run_next_turn_stops_yielding_once_finished(sample_agents):
    debate = _build_debate(sample_agents, max_turns=1)
    debate.open_debate()

    _ = [e async for e in debate.run_next_turn()]
    assert debate.is_finished

    events_after_finished = [e async for e in debate.run_next_turn()]
    assert events_after_finished == []
    # 不應該多推進 turn_count 或切換講者
    assert debate.turn_count == 1


@pytest.mark.asyncio
async def test_run_next_turn_cancellation_leaves_state_untouched(sample_agents):
    """
    迴歸測試：暫停 = 直接 cancel 正在跑 run_next_turn() 的 task。取消發生在
    LLM 串流「卡住」的中途時，不應該讓 history 多出一筆講到一半的紀錄、
    也不應該切換 current_speaker_id 或增加 turn_count——下一次
    run_next_turn() 應該還是同一位 agent，重新根據（可能剛插話進來的）
    最新歷史生成一次完整回覆，而不是從中斷點「接著講」。
    """
    hang_event = asyncio.Event()

    class _HangingLLMService:
        async def stream_reply(self, agent_id, system_prompt, messages):
            yield LLMTextChunk(agent_id=agent_id, delta_text="開頭片段")
            await hang_event.wait()  # 永遠不會被 set，模擬卡住等待取消
            yield LLMTextChunk(agent_id=agent_id, delta_text="", is_final=True)  # pragma: no cover

    debate = _build_debate(sample_agents, llm_service=_HangingLLMService())
    debate.open_debate()
    history_len_before = len(debate.history)
    speaker_before = debate.current_speaker_id

    collected_events = []

    async def _consume():
        async for event in debate.run_next_turn():
            collected_events.append(event)

    task = asyncio.create_task(_consume())
    await asyncio.sleep(0)  # 讓 task 先跑到 hang_event.wait() 卡住
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # 只會收到 agent_speaking_start，不會有 agent_speaking_end（生成被取消，沒跑完）
    assert collected_events == [{"type": "agent_speaking_start", "agent_id": speaker_before}]
    assert len(debate.history) == history_len_before
    assert debate.current_speaker_id == speaker_before
    assert debate.turn_count == 0


@pytest.mark.asyncio
async def test_run_next_turn_cancellation_during_pacing_leaves_state_untouched(sample_agents):
    """
    迴歸測試：取消發生在「節奏控制」的等待期間（生成已經跑完，正在等
    pacing_sleep_fn 補足預估播放時長）時，效果要跟取消發生在生成期間
    一樣——history/turn_count/current_speaker_id 都不應該被改動，因為
    節奏控制的 sleep 就在 history.append() 之前（見 agents/debate.py
    run_next_turn() 的順序）。
    """
    hang_event = asyncio.Event()

    async def _hanging_pacing_sleep(seconds):
        await hang_event.wait()  # 永遠不會被 set，模擬卡在節奏控制期間

    debate = _build_debate(sample_agents, pacing_sleep_fn=_hanging_pacing_sleep)
    debate.open_debate()
    history_len_before = len(debate.history)
    speaker_before = debate.current_speaker_id

    collected_events = []

    async def _consume():
        async for event in debate.run_next_turn():
            collected_events.append(event)

    task = asyncio.create_task(_consume())
    # 讓 task 有機會跑完 LLM 串流 + TTS 合成，進入節奏控制的 sleep
    for _ in range(20):
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # 這一輪應該已經產生完整的 chunk 事件（生成本身沒被打斷），
    # 但因為卡在節奏控制，agent_speaking_end 還沒送出、history 也還沒寫入
    event_types = [e["type"] for e in collected_events]
    assert "agent_speaking_start" in event_types
    assert "agent_speaking_end" not in event_types
    assert len(debate.history) == history_len_before
    assert debate.current_speaker_id == speaker_before
    assert debate.turn_count == 0


def test_inject_user_message_appends_without_changing_speaker(sample_agents):
    debate = _build_debate(sample_agents)
    debate.open_debate()
    speaker_before = debate.current_speaker_id
    history_len_before = len(debate.history)

    debate.inject_user_message("我覺得應該要學會接納失敗")

    assert debate.current_speaker_id == speaker_before
    assert len(debate.history) == history_len_before + 1
    assert debate.history[-1] == {"role": "user", "text": "我覺得應該要學會接納失敗"}


@pytest.mark.asyncio
async def test_intervened_turn_is_answered_by_the_interrupted_agent(sample_agents):
    """端到端驗證：暫停（模擬取消）之後插話，下一次 run_next_turn() 仍然是同一位 agent 回應。"""
    debate = _build_debate(sample_agents)
    debate.open_debate()
    speaker_before = debate.current_speaker_id

    debate.inject_user_message("等一下，我想先問個問題")

    events = [e async for e in debate.run_next_turn()]
    assert events[0]["agent_id"] == speaker_before
    assert debate.history[-1]["agent_id"] == speaker_before


def test_build_messages_prefixes_agent_names_and_user_intervene(sample_agents):
    debate = _build_debate(sample_agents)
    debate.history = [
        {"role": "assistant", "agent_id": "agent-a", "text": "我先說。"},
        {"role": "user", "text": "我想問一下"},
        {"role": "assistant", "agent_id": "agent-b", "text": "好，我來回答。"},
    ]

    messages = debate._build_messages()

    assert messages == [
        {"role": "assistant", "content": "小明：我先說。"},
        {"role": "user", "content": "使用者：我想問一下"},
        {"role": "assistant", "content": "小華：好，我來回答。"},
    ]


@pytest.mark.parametrize(
    "raw_text,expected",
    [
        ("小華：我很好，謝謝關心！", "我很好，謝謝關心！"),
        ("小華:我很好，謝謝關心！", "我很好，謝謝關心！"),
        ("小明：這是別人的名字誤植在開頭", "這是別人的名字誤植在開頭"),
        ("使用者：這是使用者插話格式誤植在開頭", "這是使用者插話格式誤植在開頭"),
        ("我很好，謝謝關心！", "我很好，謝謝關心！"),
        (
            "今天天氣真好，小華：這句話中間才出現名字冒號",
            "今天天氣真好，小華：這句話中間才出現名字冒號",
        ),
    ],
)
def test_strip_leading_speaker_prefix(sample_agents, raw_text, expected):
    debate = _build_debate(sample_agents)
    assert debate._strip_leading_speaker_prefix(raw_text) == expected


def test_build_debate_system_prompt_mentions_topic_and_other_agent(sample_agents):
    debate = _build_debate(sample_agents, topic_id="boundaries")
    agent_a = sample_agents[0]  # 小明
    agent_b = sample_agents[1]  # 小華

    system_prompt = debate._build_debate_system_prompt(agent_a)

    assert system_prompt.startswith(agent_a.persona_prompt)
    assert debate.topic.title in system_prompt
    assert "小華" in system_prompt  # 提到對方名字
    assert "小明：" in system_prompt  # 防呆提醒提到自己的顯示名稱前綴
    assert "扮演" in system_prompt


@pytest.mark.asyncio
async def test_run_next_turn_passes_debate_system_prompt_to_llm_service(sample_agents):
    captured: dict[str, str] = {}

    class _CapturingLLMService:
        async def stream_reply(self, agent_id, system_prompt, messages):
            captured[agent_id] = system_prompt
            yield LLMTextChunk(agent_id=agent_id, delta_text="回覆內容。")
            yield LLMTextChunk(agent_id=agent_id, delta_text="", is_final=True)

    debate = _build_debate(sample_agents, llm_service=_CapturingLLMService())
    debate.open_debate()

    _ = [e async for e in debate.run_next_turn()]

    assert "agent-a" in captured
    assert captured["agent-a"].startswith(sample_agents[0].persona_prompt)


# ─────────────────────────────────────────────────────────────────────────────
# 節奏控制（修過的真實回報問題：使用者實測發現兩位 agent 來回對答「過快」）
# ─────────────────────────────────────────────────────────────────────────────

def test_audio_duration_ms_computes_from_pcm_byte_length():
    # 24000 Hz、16-bit mono：1 秒音訊 = 24000 個 sample * 2 bytes
    assert _audio_duration_ms(b"\x00\x00" * 24000, 24000) == pytest.approx(1000.0)
    assert _audio_duration_ms(b"\x00\x00" * 12000, 24000) == pytest.approx(500.0)
    assert _audio_duration_ms(b"", 24000) == 0.0
    assert _audio_duration_ms(b"\x00\x00", 0) == 0.0
    assert _audio_duration_ms(None, 24000) == 0.0


@pytest.mark.asyncio
async def test_run_next_turn_calls_pacing_sleep_with_positive_duration(sample_agents):
    """
    MockTTSService 會產生好幾個 0.5 秒的音訊 chunk，_synthesize_and_wrap
    帶上 sample_rate 後，run_next_turn() 應該累計出一個 > 0 的預估播放
    時長，並呼叫 pacing_sleep_fn（而不是完全不呼叫或永遠傳 0）。
    """
    captured_durations = []

    async def _capture_sleep(seconds):
        captured_durations.append(seconds)

    debate = _build_debate(
        sample_agents,
        llm_service=MockLLMService(scripted_reply="我覺得可以這樣做，謝謝你的分享。"),
        tts_service=MockTTSService(chunk_seconds=0.5),
        pacing_sleep_fn=_capture_sleep,
    )
    debate.open_debate()

    _ = [e async for e in debate.run_next_turn()]

    assert len(captured_durations) == 1
    assert captured_durations[0] > 0


@pytest.mark.asyncio
async def test_run_next_turn_pacing_clamped_to_max_pacing_seconds(sample_agents):
    """單輪音訊長度遠超過 max_pacing_seconds 時，補的等待時間要被限制在上限內。"""
    captured_durations = []

    async def _capture_sleep(seconds):
        captured_durations.append(seconds)

    class _LongAudioTtsService:
        async def synthesize(self, agent_id, text, voice_profile_id=""):
            # 60 秒份量的音訊（24000 Hz、16-bit mono），遠超過下面設定的 max_pacing_seconds
            yield TTSAudioChunk(
                agent_id=agent_id, audio_bytes=b"\x00\x00" * (24000 * 60), sample_rate=24000
            )
            yield TTSAudioChunk(agent_id=agent_id, audio_bytes=b"", is_final=True)

    debate = _build_debate(
        sample_agents,
        llm_service=MockLLMService(scripted_reply="很長很長的一段話。"),
        tts_service=_LongAudioTtsService(),
        pacing_sleep_fn=_capture_sleep,
        max_pacing_seconds=5.0,
    )
    debate.open_debate()

    _ = [e async for e in debate.run_next_turn()]

    assert len(captured_durations) == 1
    assert captured_durations[0] <= 5.0 + 0.01


@pytest.mark.asyncio
async def test_run_next_turn_defaults_to_real_asyncio_sleep_when_not_injected(sample_agents):
    """
    不注入 pacing_sleep_fn 時，DebateOrchestrator 應該 fallback 用真正的
    asyncio.sleep（而不是默默不做任何節奏控制）。

    直接斷言 _pacing_sleep_fn 的函式身分（is asyncio.sleep），而不是用
    monkeypatch 攔截全域 asyncio.sleep 再跑一輪生成——MockLLMService 內部
    逐字元也會呼叫 asyncio.sleep(0)（見 services/llm_service.py），攔截
    全域 asyncio.sleep 會連帶捕捉到那些呼叫，沒辦法只驗證節奏控制這一次。
    """
    topic = DEFAULT_DEBATE_TOPICS["failure"]
    debate = DebateOrchestrator(
        agent_a=sample_agents[0],
        agent_b=sample_agents[1],
        topic=topic,
        llm_service=MockLLMService(scripted_reply="我覺得可以這樣做。"),
        tts_service=MockTTSService(),
        # 刻意不傳 pacing_sleep_fn，驗證預設會 fallback 用 asyncio.sleep
    )

    assert debate._pacing_sleep_fn is asyncio.sleep

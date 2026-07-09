"""
test_orchestrator_integration.py — 端到端 smoke test（全 mock，無需 GPU/API key）

驗證 STT → 路由決策 → LLM 串流 → 斷句 → TTS 整條管線可以正確跑完，
事件順序符合 WebSocket 協定預期，這是「小模組」在開發機（無 GPU）上
最重要的驗證項目：確保架構本身組裝正確，之後換上真實模型時邏輯不需重寫。
"""

import pytest

import services.tts_service as tts_service_module
from agents.orchestrator import MultiAgentOrchestrator
from models.schemas import AgentConfig, LLMTextChunk, STTEngineUsed
from services.llm_service import MockLLMService
from services.stt_service import MockSTTEngine, STTService
from services.tts_service import MockTTSService
from services.voice_profile_service import VoiceProfileService


def _build_mock_orchestrator(agents, routing_strategy="heuristic"):
    mock_stt = STTService(
        primary_engine=MockSTTEngine(canned_text="小明，你今天過得如何？"),
        fallback_engine=MockSTTEngine(),
    )
    return MultiAgentOrchestrator(
        agents=agents,
        stt_service=mock_stt,
        llm_service=MockLLMService(scripted_reply="我今天很好，謝謝關心！"),
        tts_service=MockTTSService(),
        routing_strategy=routing_strategy,
    )


@pytest.mark.asyncio
async def test_full_pipeline_handoff_flow(sample_agents):
    orch = _build_mock_orchestrator(sample_agents)

    transcript_event = await orch.transcribe_user_audio(b"fake-wav-bytes")
    assert transcript_event["type"] == "user_transcript"
    assert transcript_event["engine_used"] == STTEngineUsed.MOCK.value

    events = [e async for e in orch.handle_user_text(transcript_event["text"])]
    event_types = [e["type"] for e in events]

    # 應該先有路由決策，再開始發話，最後結束發話
    assert event_types[0] == "routing_decision"
    assert "agent_speaking_start" in event_types
    assert "agent_speaking_chunk" in event_types
    assert event_types[-1] == "agent_speaking_end"

    routing_event = events[0]
    assert routing_event["mode"] == "handoff"
    # user_text 提到「小明」，heuristic 應該指名 agent-a
    assert routing_event["agent_ids"] == ["agent-a"]


@pytest.mark.asyncio
async def test_no_agent_mentioned_all_agents_respond_sequentially(sample_agents):
    """
    需求變更：使用者輸入沒有指名特定 agent 時，預設「全體依序輪流各自回應
    一次」（像小組討論），而不是像過去那樣一次輸入只有一個 agent 回應。

    這裡額外驗證「依序」的意思是嚴格序列（一個 agent 完整講完、觸發
    agent_speaking_end，下一個 agent 才開始 agent_speaking_start），
    跟 Job Group 的平行處理（agent 之間互不等待）不同。
    """
    orch = _build_mock_orchestrator(sample_agents)

    events = [e async for e in orch.handle_user_text("今天天氣真好")]
    routing_event = events[0]

    assert routing_event["mode"] == "handoff"
    assert routing_event["agent_ids"] == ["agent-a", "agent-b", "agent-c"]

    # 依序：agent-a 的 start/end 應該完整出現在 agent-b 的 start 之前，以此類推
    ordered_agent_ids_in_events = [
        e["agent_id"] for e in events if e["type"] in ("agent_speaking_start", "agent_speaking_end")
    ]
    assert ordered_agent_ids_in_events == [
        "agent-a", "agent-a",
        "agent-b", "agent-b",
        "agent-c", "agent-c",
    ]


@pytest.mark.asyncio
async def test_agent_speaking_chunk_text_not_duplicated_per_audio_chunk(sample_agents):
    """
    迴歸測試：修過的 bug——一句話的 TTS 串流常常會分好幾個音訊 chunk
    （MockTTSService 依文字長度模擬分段），過去每個音訊 chunk 都把整句
    文字重複塞進 text 欄位，前端會把同一句話重複顯示 N 次（N=該句音訊
    chunk 數）。現在只有該句「第一個」音訊 chunk 附帶文字。
    """
    orch = _build_mock_orchestrator(sample_agents)

    events = [e async for e in orch.handle_user_text("小明，你好嗎？")]
    chunk_events = [e for e in events if e["type"] == "agent_speaking_chunk"]

    # scripted_reply 只有一句（一個句尾標點），所以只會有「一個」句子，
    # 但因為文字夠長，MockTTSService 會把它分成多個音訊 chunk。
    assert len(chunk_events) > 1, "測試前提：這句話應該被分成多個音訊 chunk"

    non_empty_texts = [e["text"] for e in chunk_events if e["text"]]
    assert len(non_empty_texts) == 1, "應該只有第一個音訊 chunk 帶有文字，其餘留空"
    assert non_empty_texts[0] == "我今天很好，謝謝關心！"

    empty_text_count = sum(1 for e in chunk_events if not e["text"])
    assert empty_text_count == len(chunk_events) - 1


@pytest.mark.asyncio
async def test_full_pipeline_job_group_flow(sample_agents):
    orch = _build_mock_orchestrator(sample_agents)

    events = [e async for e in orch.handle_user_text("大家覺得呢？")]
    routing_event = events[0]

    assert routing_event["mode"] == "job_group"
    assert set(routing_event["agent_ids"]) == {"agent-a", "agent-b", "agent-c"}

    # 三個 agent 都應該各自有 start/end 事件
    start_agent_ids = {e["agent_id"] for e in events if e["type"] == "agent_speaking_start"}
    end_agent_ids = {e["agent_id"] for e in events if e["type"] == "agent_speaking_end"}
    assert start_agent_ids == {"agent-a", "agent-b", "agent-c"}
    assert end_agent_ids == {"agent-a", "agent-b", "agent-c"}


@pytest.mark.asyncio
async def test_conversation_history_is_recorded(sample_agents):
    orch = _build_mock_orchestrator(sample_agents)

    events = [e async for e in orch.handle_user_text("小華，你好嗎？")]

    assert any(e.get("role") == "user" for e in orch.history) or orch.history[0]["role"] == "user"
    assistant_turns = [h for h in orch.history if h["role"] == "assistant"]
    assert len(assistant_turns) == 1
    assert assistant_turns[0]["agent_id"] == "agent-b"
    assert assistant_turns[0]["text"] == "我今天很好，謝謝關心！"


def test_build_messages_prefixes_speaker_name_for_each_agent_turn(sample_agents):
    """
    迴歸測試：修過的限制——self.history 裡每筆 agent 發言其實都帶著
    agent_id（見 _run_single_agent），但 _build_messages() 組訊息時過去把
    agent_id 丟掉、只留純文字，導致某個 agent 生成回覆時，對話歷史裡混著
    好幾個不同 agent 講過的話，卻完全看不出「這句是誰講的」。現在每則
    agent 歷史發言都會加上「顯示名稱：」前綴（例如「小明：我很好！」），
    讓 LLM 從歷史文字本身就能分辨每一句話的講者是誰。

    這裡直接操作 orch.history（不跑完整 LLM/TTS 管線），只驗證
    _build_messages() 這個組訊息的純邏輯本身。
    """
    orch = _build_mock_orchestrator(sample_agents)
    orch.history = [
        {"role": "user", "text": "大家好嗎"},
        {"role": "assistant", "agent_id": "agent-a", "text": "我很好！"},
        {"role": "assistant", "agent_id": "agent-b", "text": "我也不錯。"},
    ]

    messages = orch._build_messages("那今天要做什麼")

    assert messages == [
        {"role": "user", "content": "大家好嗎"},
        {"role": "assistant", "content": "小明：我很好！"},
        {"role": "assistant", "content": "小華：我也不錯。"},
        {"role": "user", "content": "那今天要做什麼"},
    ]


def test_build_messages_falls_back_to_agent_id_when_agent_not_found(sample_agents):
    """
    邊界情況：history 裡的 agent_id 找不到對應的 AgentConfig（例如 agent
    後來被移出候選名單），不應該整個掛掉，改用 agent_id 字串本身當前綴。
    """
    orch = _build_mock_orchestrator(sample_agents)
    orch.history = [
        {"role": "assistant", "agent_id": "agent-removed", "text": "我曾經說過這句話"},
    ]

    messages = orch._build_messages("繼續聊")

    assert messages[0] == {"role": "assistant", "content": "agent-removed：我曾經說過這句話"}


def test_build_system_prompt_includes_guardrail_and_agent_name(sample_agents):
    """
    迴歸測試：修過的 bug——_build_messages() 把對話歷史組成「顯示名稱：內容」
    格式後，回報的真實現象是 LLM 會模仿這個格式，在自己的回覆開頭也加上
    「顯示名稱：」（前端疊加一次顯示名稱後就變成「小華：小華：...」），
    甚至在同一則回覆裡切換身分、扮演起別的 agent（例如「小華：小明：...」）。
    _build_system_prompt() 會在 persona_prompt 後面加一段明確提醒，這裡
    驗證提醒文字有正確帶入該 agent 自己的顯示名稱，且沒有動到原本的
    persona_prompt 內容（維持 system prompt 前綴穩定，不影響 prompt 快取）。
    """
    orch = _build_mock_orchestrator(sample_agents)
    agent_b = sample_agents[1]  # 小華

    system_prompt = orch._build_system_prompt(agent_b)

    assert system_prompt.startswith(agent_b.persona_prompt)
    assert "小華：" in system_prompt
    assert "不要在開頭加上" in system_prompt
    assert "扮演" in system_prompt


@pytest.mark.parametrize(
    "raw_text,expected",
    [
        ("小華：我很好，謝謝關心！", "我很好，謝謝關心！"),
        ("小華:我很好，謝謝關心！", "我很好，謝謝關心！"),  # 半形冒號也要能去除
        ("小明：這是別人的名字誤植在開頭", "這是別人的名字誤植在開頭"),
        ("我很好，謝謝關心！", "我很好，謝謝關心！"),  # 沒有前綴不應該被動到
        (
            "今天天氣真好，小華：這句話中間才出現名字冒號",
            "今天天氣真好，小華：這句話中間才出現名字冒號",
        ),  # 只處理開頭，不動中間內容
    ],
)
def test_strip_leading_speaker_prefix(sample_agents, raw_text, expected):
    orch = _build_mock_orchestrator(sample_agents)
    assert orch._strip_leading_speaker_prefix(raw_text) == expected


@pytest.mark.asyncio
async def test_run_single_agent_strips_self_name_prefix_from_llm_reply(sample_agents):
    """
    端到端迴歸測試：模擬 LLM 回覆真的在開頭模仿了「顯示名稱：」格式
    （這是使用者回報的真實 bug 現象：小華的回覆變成「小華：小華：...」），
    驗證最終送到前端的 agent_speaking_chunk 文字、以及寫進 self.history
    的文字，都已經把這個多餘的自我前綴去掉。
    """
    orch = MultiAgentOrchestrator(
        agents=sample_agents,
        stt_service=STTService(primary_engine=MockSTTEngine(), fallback_engine=MockSTTEngine()),
        llm_service=MockLLMService(scripted_reply="小華：我很好，謝謝關心！"),
        tts_service=MockTTSService(),
    )

    events = [e async for e in orch.handle_user_text("小華，你好嗎？")]
    chunk_events = [e for e in events if e["type"] == "agent_speaking_chunk"]
    non_empty_texts = [e["text"] for e in chunk_events if e["text"]]

    assert non_empty_texts == ["我很好，謝謝關心！"]

    assistant_turns = [h for h in orch.history if h["role"] == "assistant"]
    assert assistant_turns[0]["text"] == "我很好，謝謝關心！"


@pytest.mark.asyncio
async def test_run_single_agent_passes_augmented_system_prompt_to_llm_service(sample_agents):
    """
    確認 _run_single_agent 真的把 _build_system_prompt() 組出來的提醒文字
    傳給 llm_service.stream_reply()，而不是只傳原始的 persona_prompt。
    """
    captured: dict[str, str] = {}

    class _CapturingLLMService:
        async def stream_reply(self, agent_id, system_prompt, messages):
            captured[agent_id] = system_prompt
            yield LLMTextChunk(agent_id=agent_id, delta_text="回覆內容。")
            yield LLMTextChunk(agent_id=agent_id, delta_text="", is_final=True)

    orch = MultiAgentOrchestrator(
        agents=sample_agents,
        stt_service=STTService(primary_engine=MockSTTEngine(), fallback_engine=MockSTTEngine()),
        llm_service=_CapturingLLMService(),
        tts_service=MockTTSService(),
    )

    _ = [e async for e in orch.handle_user_text("小明，你好嗎？")]

    assert "agent-a" in captured
    assert captured["agent-a"].startswith(sample_agents[0].persona_prompt)
    assert "小明：" in captured["agent-a"]


@pytest.mark.asyncio
async def test_orchestrator_wires_up_llm_decision_routing(sample_agents):
    """
    迴歸測試：修過的 bug——過去 MultiAgentOrchestrator 建立 HandoffCoordinator
    時沒有傳入 llm_decision_fn，就算 routing_strategy 設成 "llm_decision"，
    decide() 判斷式裡的 self._llm_decision_fn is not None 永遠是 False，
    會直接 fallback 走 heuristic，等於完全沒有真的呼叫 LLM 做路由判斷。

    現在 orchestrator 會用自己手上的 llm_service 組出 llm_decision_fn 並
    注入 HandoffCoordinator，這裡用一個「不管問什麼都回傳指定 JSON」的假
    LLM service 驗證：路由決策真的採用了 LLM 回傳的結果（agent-c），而不是
    heuristic 規則會選的結果（這句話完全沒提到任何 agent 名字，heuristic
    會回傳全體依序回應，兩者結果明顯不同，足以證明真的有走 LLM 路徑）。
    """

    class _FixedRoutingLLMService:
        async def stream_reply(self, agent_id, system_prompt, messages):
            yield LLMTextChunk(agent_id=agent_id, delta_text='{"target_agent_id": "agent-c"}')
            yield LLMTextChunk(agent_id=agent_id, delta_text="", is_final=True)

    orch = MultiAgentOrchestrator(
        agents=sample_agents,
        stt_service=STTService(primary_engine=MockSTTEngine(), fallback_engine=MockSTTEngine()),
        llm_service=_FixedRoutingLLMService(),
        tts_service=MockTTSService(),
        routing_strategy="llm_decision",
    )

    events = [e async for e in orch.handle_user_text("這個問題誰都可以回答")]
    routing_event = events[0]

    assert routing_event["type"] == "routing_decision"
    assert routing_event["mode"] == "handoff"
    assert routing_event["agent_ids"] == ["agent-c"]


@pytest.mark.asyncio
async def test_agent_speaks_with_assigned_voice_profile(tmp_path, monkeypatch):
    """
    使用者上傳音訊建立 VoiceProfile 後，指派給 agent-a（AgentConfig.voice_profile_id）。
    整條 handle_user_text 流程跑完後，TTS 服務應該有查到這個 profile
    （驗證「使用者丟入音訊 → 克隆聲音 → 指派給 agent → 對話中真的用上」這條路徑接得起來）。
    """
    profile_service = VoiceProfileService(base_dir=str(tmp_path / "voice_profiles"))
    monkeypatch.setattr(
        tts_service_module, "resolve_voice_profile", lambda pid: profile_service.get_profile(pid)
    )

    class _FakeSTTEngine:
        async def transcribe(self, audio_bytes, language="zh"):
            return "使用者上傳的參考音訊逐字稿"

    fake_stt = STTService(primary_engine=_FakeSTTEngine(), fallback_engine=_FakeSTTEngine())
    filename = profile_service.save_uploaded_sample(b"fake-wav-bytes", ext=".wav")
    profile = await profile_service.create_profile(filename, label="我的聲音", stt_service=fake_stt)

    agents = [
        AgentConfig(
            agent_id="agent-a",
            display_name="小明",
            persona_prompt="你是小明。",
            voice_profile_id=profile.profile_id,
        ),
    ]

    mock_tts = MockTTSService()
    orch = MultiAgentOrchestrator(
        agents=agents,
        stt_service=STTService(primary_engine=MockSTTEngine(), fallback_engine=MockSTTEngine()),
        llm_service=MockLLMService(scripted_reply="我是用你的聲音在說話！"),
        tts_service=mock_tts,
    )

    events = [e async for e in orch.handle_user_text("小明，說句話")]

    assert any(e["type"] == "agent_speaking_chunk" for e in events)
    assert mock_tts.last_resolved_profile is not None
    assert mock_tts.last_resolved_profile.profile_id == profile.profile_id


# ─────────────────────────────────────────────────────────────────────────────
# generate_summary() — 結束對話時生成一句總結性紀念語（見
# routers/ws_voice_agents.py 的 end_session 處理）
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_generate_summary_formats_history_and_uses_summary_agent_id(sample_agents):
    """
    generate_summary() 應該把 self.history 整理成「顯示名稱：內容」逐行文字
    塞進單一個 user message，並固定用 agent_id="summary" 呼叫
    llm_service.stream_reply()（不對應任何一位 agent，MockLLMService 用同一個
    id 判斷要回傳「總結用」腳本，見 services/llm_service.py）。
    """
    captured: dict[str, object] = {}

    class _CapturingLLMService:
        async def stream_reply(self, agent_id, system_prompt, messages):
            captured["agent_id"] = agent_id
            captured["system_prompt"] = system_prompt
            captured["messages"] = messages
            yield LLMTextChunk(agent_id=agent_id, delta_text="願你帶著今天的收穫，")
            yield LLMTextChunk(agent_id=agent_id, delta_text="繼續勇敢向前。")
            yield LLMTextChunk(agent_id=agent_id, delta_text="", is_final=True)

    orch = MultiAgentOrchestrator(
        agents=sample_agents,
        stt_service=STTService(primary_engine=MockSTTEngine(), fallback_engine=MockSTTEngine()),
        llm_service=_CapturingLLMService(),
        tts_service=MockTTSService(),
    )
    orch.history = [
        {"role": "user", "text": "最近工作上遇到一些挫折"},
        {"role": "assistant", "agent_id": "agent-a", "text": "挫折其實是成長的養分。"},
    ]

    summary = await orch.generate_summary()

    assert summary == "願你帶著今天的收穫，繼續勇敢向前。"
    assert captured["agent_id"] == "summary"
    assert captured["messages"] == [
        {
            "role": "user",
            "content": (
                "以下是這場對話的紀錄：\n"
                "使用者：最近工作上遇到一些挫折\n"
                "小明：挫折其實是成長的養分。"
            ),
        }
    ]


@pytest.mark.asyncio
async def test_generate_summary_returns_fallback_sentence_when_history_empty(sample_agents):
    """理論上不會發生（呼叫端通常已經有至少一輪對話），但空歷史時也要有
    保底句子，不應該回傳空字串。"""
    orch = _build_mock_orchestrator(sample_agents)
    assert orch.history == []

    summary = await orch.generate_summary()

    assert isinstance(summary, str)
    assert summary

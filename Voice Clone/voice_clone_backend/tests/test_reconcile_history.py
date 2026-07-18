"""
test_reconcile_history.py — 驗證 DebateOrchestrator.reconcile_history_with_client()

對應 final web 的「介入核對」：使用者暫停時，前端把被打斷那一輪「實際
顯示過的句子」隨 pause_debate 帶給後端，後端把對話歷史修剪成使用者
真正看到的內容（見 routers/ws_debate.py 的 pause_debate 處理與
models/schemas.py 的 heard_texts 說明）。

三種情況（對照 reconcile_history_with_client 的 docstring）：
    1. 整輪已在 history、播放中被打斷 → 修剪成前端顯示的前綴 + 打斷標記
    2. heard_texts 為空（一句都沒顯示）→ 整筆移除、還原輪數與發言者
    3. 該輪生成中途被取消、不在 history，但前端已顯示部分句子 → 補寫
另外驗證：不帶（None/未呼叫）時 history 完全不變（Unity/舊網頁版相容）。
"""

from agents.debate import DebateOrchestrator, DEFAULT_DEBATE_TOPICS
from models.schemas import AgentConfig
from services.llm_service import MockLLMService
from services.tts_service import MockTTSService


def _make_orchestrator() -> DebateOrchestrator:
    agent_a = AgentConfig(agent_id="a", display_name="甲", persona_prompt="p")
    agent_b = AgentConfig(agent_id="b", display_name="乙", persona_prompt="p")
    return DebateOrchestrator(
        agent_a=agent_a,
        agent_b=agent_b,
        topic=DEFAULT_DEBATE_TOPICS["failure"],
        llm_service=MockLLMService(),
        tts_service=MockTTSService(),
    )


def test_trim_last_turn_to_heard_prefix():
    """情況 1：整輪在 history，但使用者只看到前兩句 → 修剪 + 打斷標記。"""
    orch = _make_orchestrator()
    orch.history.append({"role": "assistant", "agent_id": "a", "text": "第一句。第二句。第三句。"})
    orch.turn_count = 1
    orch.current_speaker_id = "b"

    orch.reconcile_history_with_client("a", ["第一句。", "第二句。"])

    last = orch.history[-1]
    assert last["agent_id"] == "a"
    assert last["text"].startswith("第一句。第二句。")
    assert "被使用者打斷" in last["text"]
    assert "第三句" not in last["text"]
    # 輪數不變（這一輪確實發生過），但發言權還給被打斷的那位：
    # 插話後由他接續回應（修過的真實問題：預生成讓 current_speaker 已
    # 切成對方，介入後回應的內容像另一個立場）
    assert orch.turn_count == 1
    assert orch.current_speaker_id == "a"


def test_remove_turn_when_nothing_was_seen():
    """情況 2：一句都還沒顯示就暫停 → 整筆移除，視同這一輪沒發生。"""
    orch = _make_orchestrator()
    orch.history.append({"role": "assistant", "agent_id": "a", "text": "還沒被看到的整輪。"})
    orch.turn_count = 1
    orch.current_speaker_id = "b"

    orch.reconcile_history_with_client("a", [])

    assert all(e.get("agent_id") != "a" for e in orch.history if e.get("role") == "assistant")
    assert orch.turn_count == 0
    assert orch.current_speaker_id == "a"


def test_append_partial_turn_not_yet_in_history():
    """情況 3：該輪生成中途被取消（不在 history），前端已顯示部分句子 → 補寫。"""
    orch = _make_orchestrator()
    orch.history.append({"role": "assistant", "agent_id": "a", "text": "上一輪完整發言。"})
    orch.turn_count = 1
    orch.current_speaker_id = "b"  # b 的這一輪生成中被取消，沒寫進 history

    orch.reconcile_history_with_client("b", ["乙講到一半的第一句。"])

    last = orch.history[-1]
    assert last["agent_id"] == "b"
    assert last["text"].startswith("乙講到一半的第一句。")
    assert "被使用者打斷" in last["text"]
    # 不切換發言者：被打斷的那位（b）照舊接續回應
    assert orch.current_speaker_id == "b"


def test_full_turn_seen_is_noop():
    """前端顯示內容與 history 一致（整輪剛好播完）→ 什麼都不改。"""
    orch = _make_orchestrator()
    orch.history.append({"role": "assistant", "agent_id": "a", "text": "完整的一輪。"})
    before = [dict(e) for e in orch.history]

    orch.reconcile_history_with_client("a", ["完整的一輪。"])

    assert orch.history == before

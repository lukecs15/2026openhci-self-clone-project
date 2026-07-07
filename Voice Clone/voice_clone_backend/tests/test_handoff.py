"""test_handoff.py — 驗證 Handoff（序列交接）決策邏輯。"""

import asyncio

import pytest

from agents.handoff import (
    HandoffCoordinator,
    build_llm_routing_decision_fn,
    parse_llm_tool_call_response,
)
from models.schemas import LLMTextChunk, RoutingMode


@pytest.mark.asyncio
async def test_heuristic_picks_mentioned_agent(sample_agents):
    coordinator = HandoffCoordinator(strategy="heuristic")
    decision = await coordinator.decide("小華，你覺得呢？", sample_agents)

    assert decision.mode == RoutingMode.HANDOFF
    assert decision.target_agent_ids == ["agent-b"]


@pytest.mark.asyncio
async def test_heuristic_no_mention_targets_all_agents_in_order(sample_agents):
    """
    沒有指名特定 agent 時，預設全體依序輪流各自回應一次（像小組討論：
    使用者說一句話，agent A 先回、接著 B、再來 C），而不是像過去那樣
    「這次只有一個 agent 回，下次輸入才輪到下一個」。
    """
    coordinator = HandoffCoordinator(strategy="heuristic")

    decision = await coordinator.decide("大家好嗎", sample_agents)

    assert decision.mode == RoutingMode.HANDOFF
    assert decision.target_agent_ids == ["agent-a", "agent-b", "agent-c"]

    # 每次呼叫都一樣（沒有 round-robin 狀態，永遠是全體、依原始順序）
    decision_again = await coordinator.decide("再聊聊", sample_agents)
    assert decision_again.target_agent_ids == ["agent-a", "agent-b", "agent-c"]


@pytest.mark.asyncio
async def test_heuristic_picks_earliest_mentioned_name_not_candidate_list_order(sample_agents):
    """
    迴歸測試：修過的 bug——使用者回報「小華你有從小明那邊取得重新交叉比對了
    一個結果嗎」這句話明顯是在對小華說話（「小華你...」），只是句子裡也
    提到了小明的名字，但因為候選名單裡 agent-a（小明）排在 agent-b（小華）
    前面，舊邏輯依名單順序找到「小明」就直接回傳，完全沒管小明的名字其實
    出現在句子後段。現在改成比較「文字中最先出現的名字」，這句話裡「小華」
    出現在「小明」前面，應該選到小華（agent-b）。
    """
    coordinator = HandoffCoordinator(strategy="heuristic")

    decision = await coordinator.decide(
        "小華你有從小明那邊取得重新交叉比對了一個結果嗎", sample_agents
    )

    assert decision.mode == RoutingMode.HANDOFF
    assert decision.target_agent_ids == ["agent-b"]


@pytest.mark.asyncio
async def test_heuristic_picks_earliest_mentioned_name_reverse_order(sample_agents):
    """
    對照組：確認不是單純「永遠選候選名單第一個有提到的」，而是真的比較文字
    中出現的位置——這句話裡「小明」出現在「小華」前面，應該選到小明（agent-a），
    跟上一個測試的順序剛好相反。
    """
    coordinator = HandoffCoordinator(strategy="heuristic")

    decision = await coordinator.decide(
        "小明你有跟小華討論過那個案子了嗎", sample_agents
    )

    assert decision.mode == RoutingMode.HANDOFF
    assert decision.target_agent_ids == ["agent-a"]


@pytest.mark.asyncio
async def test_llm_decision_strategy_uses_injected_fn(sample_agents):
    async def fake_llm_decision(user_text: str, agents) -> str:
        return "agent-c"

    coordinator = HandoffCoordinator(strategy="llm_decision", llm_decision_fn=fake_llm_decision)
    decision = await coordinator.decide("隨便誰都可以回答", sample_agents)

    assert decision.target_agent_ids == ["agent-c"]
    assert decision.mode == RoutingMode.HANDOFF


@pytest.mark.asyncio
async def test_llm_decision_invalid_agent_id_falls_back_to_first(sample_agents):
    async def fake_llm_decision(user_text: str, agents) -> str:
        return "not-a-real-agent"

    coordinator = HandoffCoordinator(strategy="llm_decision", llm_decision_fn=fake_llm_decision)
    decision = await coordinator.decide("測試", sample_agents)

    assert decision.target_agent_ids == [sample_agents[0].agent_id]


def test_parse_llm_tool_call_response_valid_json():
    raw = 'some preamble text {"target_agent_id": "agent-b"} trailing'
    result = parse_llm_tool_call_response(raw, valid_agent_ids=["agent-a", "agent-b"])
    assert result == "agent-b"


def test_parse_llm_tool_call_response_invalid_agent_returns_empty():
    raw = '{"target_agent_id": "agent-z"}'
    result = parse_llm_tool_call_response(raw, valid_agent_ids=["agent-a", "agent-b"])
    assert result == ""


def test_parse_llm_tool_call_response_no_json_returns_empty():
    result = parse_llm_tool_call_response("這裡沒有 JSON", valid_agent_ids=["agent-a"])
    assert result == ""


# ─────────────────────────────────────────────────────────────────────────────
# build_llm_routing_decision_fn — 讓 agent_routing_strategy=llm_decision
# 真的呼叫 LLM 做路由判斷（修過的 bug：過去這個策略設定了也不會生效）
# ─────────────────────────────────────────────────────────────────────────────


class _FakeRoutingLLMService:
    """模擬 LLMService.stream_reply：一次吐出一整段（模擬 tool-call）文字。"""

    def __init__(self, scripted_response: str):
        self._scripted_response = scripted_response

    async def stream_reply(self, agent_id, system_prompt, messages):
        yield LLMTextChunk(agent_id=agent_id, delta_text=self._scripted_response)
        yield LLMTextChunk(agent_id=agent_id, delta_text="", is_final=True)


class _HangingRoutingLLMService:
    """模擬呼叫 LLM 卡住不回應（測試逾時保護）。"""

    async def stream_reply(self, agent_id, system_prompt, messages):
        await asyncio.sleep(10)
        yield LLMTextChunk(agent_id=agent_id, delta_text="不應該執行到這裡", is_final=True)


class _BrokenRoutingLLMService:
    """模擬呼叫 LLM 直接拋例外（測試例外防呆）。"""

    async def stream_reply(self, agent_id, system_prompt, messages):
        raise RuntimeError("模擬 API 呼叫失敗")
        yield  # pragma: no cover - 讓這個方法是 async generator，不會真的執行到


@pytest.mark.asyncio
async def test_build_llm_routing_decision_fn_parses_target_agent(sample_agents):
    fake_llm = _FakeRoutingLLMService('{"target_agent_id": "agent-c"}')
    decision_fn = build_llm_routing_decision_fn(fake_llm, timeout_ms=1000)
    coordinator = HandoffCoordinator(strategy="llm_decision", llm_decision_fn=decision_fn)

    decision = await coordinator.decide("這件事誰都可以幫忙看一下", sample_agents)

    assert decision.mode == RoutingMode.HANDOFF
    assert decision.target_agent_ids == ["agent-c"]


@pytest.mark.asyncio
async def test_build_llm_routing_decision_fn_times_out_and_falls_back(sample_agents):
    """
    LLM 呼叫逾時（超過 timeout_ms）時，routing 函式應回傳空字串，讓
    HandoffCoordinator._decide_via_llm fallback 用候選名單第一個 agent，
    不會讓整輪對話因為路由判斷卡住而永遠等下去。
    """
    decision_fn = build_llm_routing_decision_fn(_HangingRoutingLLMService(), timeout_ms=50)
    coordinator = HandoffCoordinator(strategy="llm_decision", llm_decision_fn=decision_fn)

    decision = await coordinator.decide("隨便誰都可以", sample_agents)

    assert decision.target_agent_ids == [sample_agents[0].agent_id]


@pytest.mark.asyncio
async def test_build_llm_routing_decision_fn_handles_exception_gracefully(sample_agents):
    """LLM 呼叫過程拋例外（例如 API 錯誤）時，同樣要優雅 fallback，不能整個掛掉。"""
    decision_fn = build_llm_routing_decision_fn(_BrokenRoutingLLMService(), timeout_ms=1000)
    coordinator = HandoffCoordinator(strategy="llm_decision", llm_decision_fn=decision_fn)

    decision = await coordinator.decide("隨便誰都可以", sample_agents)

    assert decision.target_agent_ids == [sample_agents[0].agent_id]


@pytest.mark.asyncio
async def test_build_llm_routing_decision_fn_invalid_json_falls_back(sample_agents):
    """LLM 沒有照格式回傳合法 JSON 時，也要 fallback，不是直接把整段文字當 agent_id。"""
    fake_llm = _FakeRoutingLLMService("我覺得應該是小華喔")
    decision_fn = build_llm_routing_decision_fn(fake_llm, timeout_ms=1000)
    coordinator = HandoffCoordinator(strategy="llm_decision", llm_decision_fn=decision_fn)

    decision = await coordinator.decide("隨便誰都可以", sample_agents)

    assert decision.target_agent_ids == [sample_agents[0].agent_id]

"""test_job_group.py — 驗證 Job Group（平行分派再彙整）邏輯。"""

import asyncio

import pytest

from agents.job_group import JobGroupCoordinator, should_use_job_group


@pytest.mark.asyncio
async def test_dispatch_runs_all_agents_concurrently_and_collects_results():
    group = JobGroupCoordinator(max_concurrency=4)

    async def job_fn(agent_id: str) -> str:
        await asyncio.sleep(0.01)
        return f"{agent_id}-回應"

    results = await group.dispatch(["a", "b", "c"], job_fn)

    assert results == {"a": "a-回應", "b": "b-回應", "c": "c-回應"}


@pytest.mark.asyncio
async def test_dispatch_isolates_single_agent_failure():
    group = JobGroupCoordinator(max_concurrency=4)

    async def job_fn(agent_id: str) -> str:
        if agent_id == "b":
            raise RuntimeError("b 掛了")
        return f"{agent_id}-ok"

    results = await group.dispatch(["a", "b", "c"], job_fn)

    assert results["a"] == "a-ok"
    assert results["c"] == "c-ok"
    assert isinstance(results["b"], RuntimeError)


@pytest.mark.asyncio
async def test_dispatch_respects_max_concurrency():
    group = JobGroupCoordinator(max_concurrency=2)
    active = 0
    max_active = 0

    async def job_fn(agent_id: str) -> str:
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.02)
        active -= 1
        return agent_id

    await group.dispatch(["a", "b", "c", "d"], job_fn)

    assert max_active <= 2


def test_make_routing_decision_mode_is_job_group():
    decision = JobGroupCoordinator.make_routing_decision(["a", "b"])
    assert decision.mode.value == "job_group"
    assert decision.target_agent_ids == ["a", "b"]


@pytest.mark.parametrize(
    "text,agent_count,expected",
    [
        ("大家覺得呢？", 3, True),
        ("我們來辯論一下", 3, True),
        ("小明你覺得呢？", 3, False),
        ("大家好", 1, False),  # 只有一個 agent，不需要 job group
    ],
)
def test_should_use_job_group_heuristic(text, agent_count, expected):
    assert should_use_job_group(text, agent_count) is expected

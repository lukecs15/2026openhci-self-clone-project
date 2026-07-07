"""
agents/job_group.py — Job Group 協調器（平行式：多個 agent 同時處理再彙整）

對照架構文件 2.2 節：
    Job / Job Group：把任務平行分派給多個 agent 同時處理，再收集結果
    （適合多角色討論、辯論類情境）。

與 handoff.py 的差異：
    - handoff：一次只有一個 agent 該發話（序列式，交接控制權）
    - job_group：多個 agent「同時」被要求產生回應（例如辯論雙方同時準備論點、
      腦力激盪多角色各自提出想法），彼此不互相等待，最後統一收集結果。

使用方式：
    group = JobGroupCoordinator(max_concurrency=4)
    results = await group.dispatch(
        agent_ids=["agent-a", "agent-b", "agent-c"],
        job_fn=lambda agent_id: llm_service.generate_reply(agent_id, ...),
    )
    # results 為 {agent_id: 回應內容}，保留每個 agent 對應的結果，
    # 任一 agent 失敗不影響其他 agent（見 _run_one 的例外處理）
"""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, Generic, TypeVar

from models.schemas import RoutingDecision, RoutingMode

logger = logging.getLogger(__name__)

T = TypeVar("T")

JobFn = Callable[[str], Awaitable[T]]


class JobGroupCoordinator(Generic[T]):
    """
    平行分派任務給多個 agent，並收集結果（任一 agent 失敗不影響其他 agent）。
    """

    def __init__(self, max_concurrency: int = 4):
        self._semaphore = asyncio.Semaphore(max_concurrency)

    async def dispatch(self, agent_ids: list[str], job_fn: JobFn) -> dict[str, T | Exception]:
        """
        平行呼叫 job_fn(agent_id) 給每個 agent_id，回傳 {agent_id: 結果或例外}。

        刻意不用 asyncio.gather(..., return_exceptions=False)，而是逐一包裝，
        確保單一 agent 拋出例外時不會讓整個 job group 中斷、其他 agent 結果遺失。
        """
        results: dict[str, T | Exception] = {}

        async def _run_one(agent_id: str) -> None:
            async with self._semaphore:
                try:
                    results[agent_id] = await job_fn(agent_id)
                except Exception as exc:  # noqa: BLE001 — 個別 agent 失敗需隔離
                    logger.warning("Job group 中 agent %s 執行失敗：%s", agent_id, exc)
                    results[agent_id] = exc

        await asyncio.gather(*(_run_one(agent_id) for agent_id in agent_ids))
        return results

    @staticmethod
    def make_routing_decision(agent_ids: list[str], reason: str = "多角色討論情境") -> RoutingDecision:
        return RoutingDecision(
            mode=RoutingMode.JOB_GROUP, target_agent_ids=list(agent_ids), reason=reason
        )


def should_use_job_group(user_text: str, agent_count: int) -> bool:
    """
    簡單啟發式：偵測使用者是否要求「大家」、「所有人」、「辯論」等多角色同時發言的字眼。

    真正的策略應由 LLM 動態判斷（見架構文件待辦事項 4），此函式是
    agent_routing_strategy=heuristic 時的預設規則，也方便單元測試。
    """
    if agent_count < 2:
        return False
    keywords = ("大家", "所有人", "每個人", "辯論", "討論一下", "都說說")
    return any(kw in user_text for kw in keywords)

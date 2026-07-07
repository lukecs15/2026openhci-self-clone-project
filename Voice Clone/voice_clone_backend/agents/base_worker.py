"""
agents/base_worker.py — 多 Agent 共享訊息匯流排（shared bus）與 worker 基底

對照架構文件 2.2 節（Pipecat 多 Agent 模型）：
    - 每個 Agent 是一個 worker，可在執行期動態啟動其他 worker 並加入 bus
    - Pipecat 原生是「多個透過共享訊息匯流排溝通的 agent」模型，不是單一
      active agent 掌控 session 的序列式模型（那是 LiveKit Agents 的作法）

本檔案提供不依賴 pipecat-ai 套件本身的最小可測試骨架：
    - AgentBus：進程內共享匯流排（asyncio.Queue 為底），worker 之間透過它收發事件
    - BaseWorker：所有 Agent worker 的共同基底（對應 Pipecat 的 BaseWorker）
    - LLMWorker：包裝單一 Agent 的 LLM + STT/TTS 呼叫邏輯

之後若要換成真正的 pipecat-ai（見 requirements/prod-rtx5090.txt），
這裡的介面設計刻意貼近 Pipecat 的 BaseWorker / PipelineWorker 概念，
方便日後把 AgentBus 換成 pipecat 的 shared bus，把 BaseWorker 換成
`pipecat.agents.BaseWorker` 子類別，而不需要重寫上層編排邏輯。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass
class BusEvent:
    """在 AgentBus 上傳遞的事件。"""

    event_type: str
    agent_id: str
    payload: Any = None


class AgentBus:
    """
    進程內共享訊息匯流排。

    多個 worker（agent）透過 publish()/subscribe() 溝通，不需要互相持有參照，
    對應架構文件所述「Pipecat 原生就是多 Agent 系統：協調多個透過共享訊息
    匯流排溝通的 agent」。
    """

    def __init__(self):
        self._subscribers: list[asyncio.Queue[BusEvent]] = []

    def subscribe(self) -> asyncio.Queue[BusEvent]:
        q: asyncio.Queue[BusEvent] = asyncio.Queue()
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[BusEvent]) -> None:
        if q in self._subscribers:
            self._subscribers.remove(q)

    async def publish(self, event: BusEvent) -> None:
        logger.debug("bus publish: %s from %s", event.event_type, event.agent_id)
        for q in list(self._subscribers):
            await q.put(event)


class BaseWorker:
    """
    所有 Agent worker 的共同基底。

    對應 Pipecat 的 BaseWorker：可在執行期被動態啟動，並加入共享 bus。
    子類別（如 LLMWorker）實作 handle_event() 決定收到特定事件時該做什麼。
    """

    def __init__(self, agent_id: str, bus: AgentBus):
        self.agent_id = agent_id
        self.bus = bus
        self._queue = bus.subscribe()
        self._task: Optional[asyncio.Task] = None
        self._running = False

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        self._running = False
        self.bus.unsubscribe(self._queue)
        if self._task:
            self._task.cancel()

    async def _run_loop(self) -> None:
        while self._running:
            event = await self._queue.get()
            await self.handle_event(event)

    async def handle_event(self, event: BusEvent) -> None:  # pragma: no cover - 抽象方法
        raise NotImplementedError

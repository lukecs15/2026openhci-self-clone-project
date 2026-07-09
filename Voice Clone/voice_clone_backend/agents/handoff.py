"""
agents/handoff.py — Handoff 協調器（序列式：依序把控制權交給一個或多個 agent）

對照架構文件 2.2 節：
    Handoff：LLM 透過 tool call 決定把對話控制權轉移給哪個 agent（序列式）。

行為（依需求調整過）：
    - 使用者訊息中明確提到某個 agent 的名字 → 只由該 agent 回應（target 為單一 agent）。
      如果同一句話裡提到「不只一個」agent 的名字（例如「小華你有從小明那邊聽到消息嗎」，
      這句話同時提到小華跟小明），會挑「在文字中最先出現」的那個名字，而不是依 agents
      候選名單本身的順序去找——後者曾經是一個 bug：不管小明的名字實際出現在句子的哪個
      位置，只要候選名單裡 agent-a（小明）排在前面，就一律先比對到小明，導致「小華你有
      從小明那邊取得...」這種明顯是在對小華說話、只是句子裡提到小明的情況，被誤判成要
      小明回應。「文字中最先出現的名字」是比較貼近中文口語「稱呼在前」習慣的簡單啟發式，
      不是完美的語意理解，複雜情境仍然可能誤判，真正想要更準確的判斷可以改用
      agent_routing_strategy=llm_decision（見下方）。
    - 沒有明確指名 → 預設所有 agent 依序輪流各自回應一次（像小組討論：使用者說一句話，
      agent A 先回、接著 B 回、再來 C 回），而不是像過去那樣「這次只有一個 agent 回，
      下次輸入才輪到下一個」。RoutingDecision.target_agent_ids 因此可以是多個 agent id，
      orchestrator 收到 HANDOFF 模式的多個 target 時會依序（非平行）逐一呼叫。

Job Group（見 agents/job_group.py）則保留給「明確要求多角色同時／平行處理」的情境
（例如訊息包含「大家」「辯論」等關鍵字），兩者的差異是 Job Group 走平行 asyncio 任務、
Handoff 的多 target 是逐一循序執行。

本模組提供兩種決策策略（對應 config.py 的 agent_routing_strategy）：
    - heuristic：規則式（指名 / 全體依序回應），不需要呼叫 LLM，延遲最低，
      也是目前預設值，方便在沒有 LLM API key 的情況下測試。
    - llm_decision：真的呼叫 LLM 判斷「這句話該由誰回應」，語意理解能力比
      heuristic 的字串比對準確得多（例如能處理同時提到多個名字、或完全沒
      提名字但語意上很清楚在問誰的情況）。build_llm_routing_decision_fn()
      組出符合 LLMDecisionFn 介面的判斷函式，agents/orchestrator.py 建立
      MultiAgentOrchestrator 時會自動用它（跟產生實際回覆用的同一個
      llm_service），不需要呼叫端額外接線。這裡用「要求 LLM 只回傳一個
      JSON 物件」的簡化寫法模擬 tool call，不是用 LLM SDK 原生的 function
      calling schema——之後想換成真正的 function calling 也只需要改
      build_llm_routing_decision_fn() 這一個函式，其餘部分不用動。

── llm_decision 支援「同時指名多位」（修過的真實回報問題）────────────────
使用者實測回報：「小明、小華你們今天過得如何」這句話明確同時稱呼了小明和
小華兩位，但設定 routing_strategy=llm_decision 時卻只有小明回應。追查後
發現這不是 bug，是舊版設計本來就刻意如此：_ROUTING_SYSTEM_PROMPT 過去要求
LLM「只能從候選名單中選一位」，回傳格式也是單一個
`{"target_agent_id": "<id>"}`，就算 LLM 語意上判斷這句話該由兩位一起
回應，也沒有管道可以表達「選這兩位」，舊版的 target_agent_id 解析函式
只解析單一 target_agent_id，HandoffCoordinator._decide_via_llm() 也只組出
長度固定為 1 的 target_agent_ids。

修法：把 LLM 路由的回傳格式改成陣列 `{"target_agent_ids": ["<id>", ...]}`，
可以是 1 個、多個、或全部候選 agent，讓 LLM 的語意判斷結果能真的反映在
決策上（例如「小明、小華你們今天過得如何」可以讓 LLM 判斷兩位都該回應）。
agents/orchestrator.py 的 HANDOFF 模式本來就會依序（非平行）逐一呼叫
target_agent_ids 裡的每一個 agent（見該檔案 handle_user_text() 的說明），
所以這裡不需要改任何 orchestrator 邏輯，單純讓 target_agent_ids 的長度可以
大於 1 就會自動生效。

這裡刻意只調整 llm_decision 這條路徑，heuristic（字串比對）刻意保持原有的
「同時提到多個名字時只挑文字中最先出現的那一個」行為不變——heuristic 的
設計目標本來就是「規則簡單、延遲最低」，真的要處理「同時指名多位該怎麼
拆」這種語意判斷，本來就該交給 llm_decision，這也是 heuristic docstring
本身建議的方向（見上面「複雜情境仍然可能誤判，真正想要更準確的判斷可以
改用 agent_routing_strategy=llm_decision」）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import TYPE_CHECKING, Awaitable, Callable, Optional

from config import get_settings
from models.schemas import AgentConfig, RoutingDecision, RoutingMode

if TYPE_CHECKING:
    from services.llm_service import LLMService

logger = logging.getLogger(__name__)

# LLM 決策函式型別：輸入（使用者文字, 候選 agent 列表），輸出目標 agent_id 列表
# （可以是 1 個、多個、或全部候選 agent，見檔案開頭「llm_decision 支援
# 同時指名多位」說明；判斷失敗時回傳空 list，由 HandoffCoordinator 決定
# fallback 行為，不是回傳空字串）。
LLMDecisionFn = Callable[[str, list[AgentConfig]], Awaitable[list[str]]]


class HandoffCoordinator:
    """
    決定「這句話該由哪個/哪些 agent 依序回應」（序列交接）。

    target_agent_ids 可以是一個 agent（使用者明確指名）或多個 agent
    （沒有指名時，預設全體依序各自回應一次）。
    """

    def __init__(
        self,
        strategy: str = "heuristic",
        llm_decision_fn: Optional[LLMDecisionFn] = None,
    ):
        self._strategy = strategy
        self._llm_decision_fn = llm_decision_fn

    @property
    def strategy(self) -> str:
        """目前實際生效的路由策略，供外部（例如 WebSocket 路由記 log）讀取確認。"""
        return self._strategy

    async def decide(self, user_text: str, agents: list[AgentConfig]) -> RoutingDecision:
        if not agents:
            raise ValueError("agents 不可為空")

        if self._strategy == "llm_decision" and self._llm_decision_fn is not None:
            return await self._decide_via_llm(user_text, agents)
        return self._decide_via_heuristic(user_text, agents)

    def _decide_via_heuristic(
        self, user_text: str, agents: list[AgentConfig]
    ) -> RoutingDecision:
        """
        規則式決策：
            1. 若使用者文字中提到一或多個 agent 的 display_name，交給「文字中最先
               出現」的那一個（不是候選名單順序上最先的那一個——修過的 bug，見檔案
               開頭說明）。
            2. 完全沒提到任何 agent 名字，才交給「全體」，依 agents 原始順序依序
               各自回應一次。
        """
        mentioned: list[tuple[int, AgentConfig]] = []
        for agent in agents:
            if not agent.display_name:
                continue
            idx = user_text.find(agent.display_name)
            if idx != -1:
                mentioned.append((idx, agent))

        if mentioned:
            mentioned.sort(key=lambda pair: pair[0])
            _, target_agent = mentioned[0]
            return RoutingDecision(
                mode=RoutingMode.HANDOFF,
                target_agent_ids=[target_agent.agent_id],
                reason=f"使用者提及 {target_agent.display_name}（文字中最先出現的名字）",
            )

        all_ids = [agent.agent_id for agent in agents]
        return RoutingDecision(
            mode=RoutingMode.HANDOFF,
            target_agent_ids=all_ids,
            reason="未指名特定 agent，全體依序輪流回應",
        )

    async def _decide_via_llm(
        self, user_text: str, agents: list[AgentConfig]
    ) -> RoutingDecision:
        """
        呼叫注入的 LLM 決策函式，取得目標 agent_id 列表（見檔案開頭「llm_decision
        支援同時指名多位」說明，可以是 1 個、多個、或全部候選 agent）。

        llm_decision_fn 內部若判斷失敗（逾時、API 錯誤、回傳格式不合法等）
        會回傳空 list；就算成功回傳，裡面也可能混著不在候選名單裡的 id
        （LLM 偶爾會「發明」不存在的 agent_id）或重複的 id。這裡統一過濾
        掉不合法的 id、依原本回傳順序去重，過濾完如果變成空 list，才 fallback
        用候選名單的第一個 agent，不會讓整輪對話因為路由判斷失敗而卡住或
        整個報錯。
        """
        assert self._llm_decision_fn is not None
        raw_target_ids = await self._llm_decision_fn(user_text, agents)
        valid_ids = {a.agent_id for a in agents}

        seen: set[str] = set()
        target_agent_ids: list[str] = []
        for agent_id in raw_target_ids:
            if agent_id in valid_ids and agent_id not in seen:
                seen.add(agent_id)
                target_agent_ids.append(agent_id)

        if not target_agent_ids:
            logger.warning(
                "LLM 回傳的 agent_id 列表（%s）沒有任何一個在候選名單中，"
                "fallback 用第一個 agent",
                raw_target_ids,
            )
            target_agent_ids = [agents[0].agent_id]

        return RoutingDecision(
            mode=RoutingMode.HANDOFF,
            target_agent_ids=target_agent_ids,
            reason="LLM tool-call 決定"
            if len(target_agent_ids) == 1
            else "LLM tool-call 決定（同時指名多位）",
        )


def parse_llm_routing_response(raw_response: str, valid_agent_ids: list[str]) -> list[str]:
    """
    解析 LLM 以 JSON 格式輸出的路由決策結果，預期格式（陣列，可以是 1 個、
    多個、或全部候選 agent，見檔案開頭「llm_decision 支援同時指名多位」說明）：
        {"target_agent_ids": ["agent-1", "agent-2"]}

    防呆／相容性考量：
        - 找不到合法 JSON、`target_agent_ids` 不是陣列、或陣列裡沒有任何
          一個 id 落在候選名單內時，回傳空 list，讓上層（HandoffCoordinator.
          _decide_via_llm）決定 fallback 行為，不在這裡自己猜。
        - 陣列裡不合法/不在候選名單的 id 會被過濾掉，不會讓整個結果作廢
          （例如 LLM 回傳 3 個 id、其中 1 個是幻覺出來的 id，仍然保留另外
          2 個合法的）。
        - 額外相容舊格式 `{"target_agent_id": "agent-1"}`（單數、字串）：
          就算 LLM 沒有照最新 prompt 的陣列格式回傳、還是習慣性吐出單數
          格式，也能正確解析成單一元素的 list，不會直接判定失敗。
    """
    match = re.search(r"\{.*\}", raw_response, re.DOTALL)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []

    raw_ids = data.get("target_agent_ids")
    if raw_ids is None:
        # 相容舊版單數格式（見上方說明）。
        single = data.get("target_agent_id")
        raw_ids = [single] if single else []
    if not isinstance(raw_ids, list):
        return []

    valid_id_set = set(valid_agent_ids)
    seen: set[str] = set()
    result: list[str] = []
    for agent_id in raw_ids:
        if isinstance(agent_id, str) and agent_id in valid_id_set and agent_id not in seen:
            seen.add(agent_id)
            result.append(agent_id)
    return result


_ROUTING_SYSTEM_PROMPT = (
    "你是一個多 Agent 對話系統裡負責「決定由誰回應」的路由器，不負責產生實際回覆內容。"
    "使用者會給你一句話，以及目前所有候選角色的 agent_id、顯示名稱與簡短人設。"
    "請判斷這句話應該由哪一位或哪幾位候選角色回應：如果訊息明確同時稱呼、詢問或提及"
    "了多位角色（例如「小明、小華你們今天過得如何」同時稱呼兩個人），就把所有真正該"
    "回應的角色都列出來；如果只是單純提到某個角色的名字、或話題明顯只跟一位角色相關，"
    "就只列那一位。只能從候選名單中選擇，不能自己發明新的 agent_id，也不要把候選名單裡"
    "跟這句話無關、沒有被稱呼或詢問到的角色也列進去。"
    '請只回傳一個 JSON 物件，格式一定要是：{"target_agent_ids": ["<候選名單中的 agent_id>", ...]}，'
    "陣列至少要有一個元素，不要輸出任何其他文字、不要加上說明、不要用 markdown code block 包起來。"
)


def _build_routing_user_message(user_text: str, agents: list[AgentConfig]) -> str:
    candidates_desc = "\n".join(
        f"- agent_id={a.agent_id}，顯示名稱={a.display_name}，人設簡介：{a.persona_prompt}"
        for a in agents
    )
    return (
        f"候選角色：\n{candidates_desc}\n\n"
        f"使用者說的話：「{user_text}」\n\n"
        "這句話應該由哪一位或哪幾位候選角色回應？"
    )


def build_llm_routing_decision_fn(
    llm_service: "LLMService", timeout_ms: Optional[int] = None
) -> LLMDecisionFn:
    """
    用注入的 llm_service（跟 agent 生成回覆共用同一個，mock 與否由呼叫端決定，
    見 pipeline/conversation_pipeline.py 與 agents/orchestrator.py）組出一個
    符合 LLMDecisionFn 介面的路由判斷函式，讓 agent_routing_strategy=llm_decision
    真的能呼叫 LLM 判斷「這句話該由誰回應」。

    設計上刻意讓 LLM 只回傳一個 JSON 物件，路由判斷只是一個短決策，用
    stream_reply() 把整個回覆讀完再一次解析即可，不需要像產生實際回覆那樣
    逐句斷句餵給 TTS。

    回傳值是 agent_id 列表（可以是 1 個、多個、或全部候選 agent，見檔案
    開頭「llm_decision 支援同時指名多位」說明）。有兩層防呆，任何一層
    觸發都會回傳空 list（HandoffCoordinator._decide_via_llm 收到空 list
    會 fallback 用候選名單第一個 agent，不會讓整輪對話卡住或報錯）：
        1. 逾時保護（timeout_ms，預設讀 config.agent_routing_llm_timeout_ms）。
        2. 呼叫過程任何例外（例如 API 錯誤、網路問題）。
    """

    async def _decide(user_text: str, agents: list[AgentConfig]) -> list[str]:
        resolved_timeout_s = (
            timeout_ms if timeout_ms is not None else get_settings().agent_routing_llm_timeout_ms
        ) / 1000

        async def _consume() -> str:
            chunks: list[str] = []
            async for token in llm_service.stream_reply(
                agent_id="router",
                system_prompt=_ROUTING_SYSTEM_PROMPT,
                messages=[
                    {"role": "user", "content": _build_routing_user_message(user_text, agents)}
                ],
            ):
                if token.is_final:
                    break
                chunks.append(token.delta_text)
            return "".join(chunks)

        try:
            raw_response = await asyncio.wait_for(_consume(), timeout=resolved_timeout_s)
        except asyncio.TimeoutError:
            logger.warning(
                "LLM 路由判斷逾時（>%sms），fallback 用候選名單第一個 agent",
                timeout_ms or get_settings().agent_routing_llm_timeout_ms,
            )
            return []
        except Exception as exc:  # noqa: BLE001
            logger.warning("LLM 路由判斷失敗（%s），fallback 用候選名單第一個 agent", exc)
            return []

        valid_ids = [a.agent_id for a in agents]
        return parse_llm_routing_response(raw_response, valid_agent_ids=valid_ids)

    return _decide

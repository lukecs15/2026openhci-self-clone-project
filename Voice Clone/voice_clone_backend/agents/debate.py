"""
agents/debate.py — 自我省思／自我成長主題「雙 Agent 辯論／討論模式」編排器

需求對照：使用者進入對話前先從三個自我省思／自我成長主題中選一個，
再從三個 agent 中選兩個，讓這兩位 agent 針對主題輪流發言、進行辯論或
討論；使用者聆聽過程中可以隨時「暫停」（立刻中斷目前正在生成的那句話），
輸入一句話插話後，由「原本被打斷的那位」agent 根據使用者的插話接續回應。

跟 agents/orchestrator.py（MultiAgentOrchestrator）的差異：
    - 固定只有兩位 agent 輪流發言，圍繞單一主題，不需要 Handoff / Job Group
      路由決策。
    - 不需要 STT：辯論模式使用者只用文字插話（見 pause_debate /
      user_intervene，由 routers/ws_debate.py 處理；前端也可以用瀏覽器
      Web Speech API 語音辨識把話轉成文字再送出，但那是前端層級的事，
      後端這裡收到的一律是文字）。
    - 支援「暫停＝中斷生成」：run_next_turn() 是一輪一輪跑的 async
      generator，刻意不攔截 asyncio.CancelledError，讓呼叫端（WS 路由）
      可以直接用 asyncio.Task.cancel() 中斷目前卡住的 LLM/TTS 呼叫。
      因為 self.history 只有在整輪生成「成功跑完」之後才會 append、
      current_speaker_id 也只有在那之後才切換，所以中途取消不會留下
      「講到一半」的殘留紀錄，下一次 run_next_turn() 會是同一位 agent
      根據（可能剛插話進來的）最新歷史重新生成一次完整回覆。

節奏控制（修過的真實回報問題：使用者實測發現兩位 agent 來回對答「過快」，
原因是 dev 環境 TTS 預設是 MockTTSService，文字→斷句→合成幾乎瞬間就能跑
完一整輪，換人發言的速度只受限於 LLM 生成速度，完全沒有「這段話講出來
實際要花多少時間」的概念，跟真人聽起來的節奏對不上）：
    - _synthesize_and_wrap() 產生的每個 agent_speaking_chunk 事件都帶上
      sample_rate，run_next_turn() 依 16-bit mono PCM 的位元組數／取樣率
      累計整輪「預估播放時長」（_audio_duration_ms()，MockTTSService 的
      靜音資料一樣適用，因為時長是從資料長度反推的，不是真的解碼音訊）。
    - 整輪生成（LLM 串流 + TTS 合成）結束後、真正把發言寫進歷史、切換
      講者、送出 agent_speaking_end 之前，用「預估播放時長 - 生成已經
      花掉的實際時間」補一段 sleep（不會是負數），讓下一位 agent 開口的
      時間點貼近「前一位真的把這段話講完」的時間點，而不是「文字生成完
      就馬上換人」。真正的 CosyVoice 2／真人聆聽情境下，生成本身可能就
      已經花了跟播放差不多的時間，這段補的 sleep 會自動趨近於 0，不會
      額外拖慢已經夠慢的真實情境。
    - sleep 上限用 max_pacing_seconds 限制（避免單輪講太長的話時，節奏
      控制反而讓等待時間離譜地久），sleep 的實作可以透過 pacing_sleep_fn
      注入（單元測試用假的立即完成版本，避免測試套件被拖慢；正式環境
      預設用真正的 asyncio.sleep）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

from models.schemas import AgentConfig
from services.llm_service import LLMService, SentenceAggregator
from services.tts_service import TTSService

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DebateTopic:
    """一個自我省思／自我成長辯論主題。"""

    topic_id: str
    title: str
    # 開場時塞進歷史、引導兩位 agent 從什麼角度切入這個主題
    seed_prompt: str


# 三個預設的自我省思／自我成長主題（前端選單只需要 topic_id + title，
# seed_prompt 只在後端組 system prompt / 開場白時使用，不需要同步到前端）。
DEFAULT_DEBATE_TOPICS: dict[str, DebateTopic] = {
    "failure": DebateTopic(
        topic_id="failure",
        title="如何面對失敗與挫折",
        seed_prompt=(
            "請針對「如何面對失敗與挫折」這個自我成長主題分享你的觀點："
            "失敗發生時該如何調適心態、從中學習，而不是被挫折感淹沒。"
        ),
    ),
    "boundaries": DebateTopic(
        topic_id="boundaries",
        title="如何設立個人界線，兼顧他人期待與自己的需求",
        seed_prompt=(
            "請針對「如何設立個人界線」這個自我成長主題分享你的觀點："
            "當他人的期待與自己的需求衝突時，該怎麼拿捏分寸、適度表達拒絕。"
        ),
    ),
    "procrastination": DebateTopic(
        topic_id="procrastination",
        title="如何克服拖延，建立自律",
        seed_prompt=(
            "請針對「如何克服拖延、建立自律」這個自我成長主題分享你的觀點："
            "拖延背後常見的心理成因是什麼，實際上有哪些方法能真正做到自律。"
        ),
    ),
}


# 辯論情境下加在 persona_prompt 後面的說明，同時涵蓋：
#   1. 主題與對話對象是誰（讓 agent 知道要「跟誰」討論「什麼」）
#   2. 每次發言長度限制（留空間給對方接話、也給使用者插話的機會）
#   3. 沿用 orchestrator.py 那套「顯示名稱：」歷史格式的防模仿提醒
#      （見 agents/orchestrator.py 的 _SPEAKER_PREFIX_GUARDRAIL 說明，
#      這裡額外多提醒「使用者：」也是格式標記、不是要模仿的對象）
_DEBATE_INSTRUCTION_TEMPLATE = (
    "\n\n【辯論／討論情境說明】你現在正在跟另一位角色「{other_name}」"
    "針對主題「{topic_title}」進行自我省思／自我成長主題的討論或辯論。"
    "{seed_prompt}\n"
    "請保持你（{name}）原本的個性與說話風格回應，每次發言請控制在大約"
    "2 到 4 句話，留一些空間讓對方接話、也讓正在聆聽的使用者有機會隨時"
    "插話參與討論，不要一次講完所有想法。\n"
    "【用字要求】你說的話會被即時轉成語音唸出來，請只使用日常口語的"
    "常用字：避免生僻字、罕用字、艱澀成語與文言書面語；也盡量避開"
    "容易唸錯的破音字用法，能換成白話說法就換（例如與其用「拗不過」"
    "不如說「說不過他」）。數字、外文縮寫請改用自然的口語講法。\n"
    "【對話歷史格式說明】接下來提供的對話歷史中，每一則發言前面會加上"
    "「顯示名稱：」（例如「{name}：...」或「使用者：...」），這只是用來"
    "標示每一句話是誰說的，不是要你模仿這種格式。你自己回覆時，請直接"
    "輸出你（{name}）要說的話本身，不要在開頭加上「{name}：」這樣的名字"
    "前綴，也不要在同一則回覆裡切換身分、扮演或模擬「{other_name}」的發言。"
    "如果歷史中出現「使用者：」開頭的發言，代表是正在聆聽的使用者中途"
    "插話，請自然地回應使用者提出的意見或問題，再視情況延續原本的討論方向。"
)


def build_custom_topic(topic_title: str) -> DebateTopic:
    """
    依使用者自訂議題（例如手機 onboarding 傳來的「最近的內耗煩惱」）動態
    組出一個 DebateTopic，topic_id 固定 "custom"。seed_prompt 用通用模板，
    引導兩位「自我」agent 從各自人格視角對這個煩惱表態，與
    DEFAULT_DEBATE_TOPICS 的固定主題走完全相同的後續流程。
    """
    title = (topic_title or "").strip() or "如何面對最近的內耗與煩惱"
    return DebateTopic(
        topic_id="custom",
        title=title,
        seed_prompt=(
            f"請針對使用者提出的個案「{title}」分享你的觀點："
            "從你自己的個性出發，說明你會怎麼看待、怎麼處理這個情況，"
            "並指出你不認同對方做法的地方。"
        ),
    )


# 辯論結束時用來生成「總結紀念語」的 system prompt，跟
# agents/orchestrator.py 的 _SUMMARY_SYSTEM_PROMPT 用途相同（同一套
# MockLLMService agent_id == "summary" 判斷邏輯也共用），差別是這裡會
# 額外把辯論主題（topic.title）帶進 prompt，讓總結能扣合主題本身，不只是
# 針對逐字內容。
_DEBATE_SUMMARY_SYSTEM_PROMPT_TEMPLATE = (
    "你是一位溫暖、有洞察力的陪伴者。使用者剛剛聆聽完一場圍繞著"
    "「{topic_title}」這個自我省思／自我成長主題的雙 Agent 討論或辯論，"
    "以下是這場討論的逐字紀錄。請根據主題與對話內容，生成「一句」溫暖、"
    "勵志、帶有心靈雞湯或鼓勵意涵的總結話語，作為使用者結束體驗後可以帶走"
    "的紀念語。\n"
    "要求：\n"
    "1. 只輸出一句話（可以是一個完整的句子，不要條列、不要標題、不要換行）。\n"
    "2. 語氣溫暖真誠，盡量扣合這個主題與對話中實際出現的內容或情緒，不要"
    "空泛制式。\n"
    "3. 使用繁體中文。\n"
    "4. 不要加上引號或任何前綴（例如「總結：」），直接輸出這句話本身。"
)


# 「內在法庭」判決書生成 prompt（見 generate_verdict()）：對照 VR 流程腳本
# End scene 的需求——判決書要列出「當事人最初的成見」以及「身為法官親口
# 駁斥後的改變」，作為體驗者可以帶走的紀念品。要求 LLM 只輸出 JSON，欄位
# 缺漏或解析失敗時 generate_verdict() 有 fallback，不會讓結束流程炸掉。
_DEBATE_VERDICT_SYSTEM_PROMPT_TEMPLATE = (
    "你是「內在法庭（心智最高法院）」的書記官。使用者（首席法官）剛剛審理完"
    "一場圍繞著個案「{topic_title}」的內心辯論：兩位訴訟代理人「{agent_a_name}」"
    "（{agent_a_role}）與「{agent_b_name}」（{agent_b_role}）分別代表使用者內心"
    "的兩種聲音，逐字紀錄中「使用者：」開頭的發言是法官敲槌後親口說出的介入意見。"
    "請根據逐字紀錄撰寫最終判決書，並「只」輸出下列 JSON（不要加上任何說明文字、"
    "markdown 標記或 ```）：\n"
    "{{\n"
    '  "case_title": "案由（一句話描述這個個案）",\n'
    '  "initial_bias": "當事人最初的成見或內耗核心（1-2 句）",\n'
    '  "viewpoint_a": "{agent_a_name}方主張摘要（1-2 句）",\n'
    '  "viewpoint_b": "{agent_b_name}方主張摘要（1-2 句）",\n'
    '  "judge_interventions": ["法官每次介入意見的摘要（沒有介入時給空陣列）"],\n'
    '  "final_verdict": "本庭最終判決主文（2-3 句，法庭文書語氣但溫暖）",\n'
    '  "revised_belief": "經法官駁斥修正後的信念（1-2 句，正向、可帶走）",\n'
    '  "closing_line": "一句溫暖的結語（不要引號、不要前綴）"\n'
    "}}\n"
    "全部使用繁體中文，內容要扣合逐字紀錄中實際出現的論點與介入意見，不要空泛制式。"
)


def _audio_duration_ms(audio_bytes: Optional[bytes], sample_rate: int) -> float:
    """
    估計一段 16-bit mono PCM 音訊的播放時長（毫秒）。

    用來讓「換人發言」的節奏貼近實際語音長度（見檔案開頭「節奏控制」
    說明），而不是像 MockTTSService／瀏覽器 TTS 那樣幾乎瞬間完成，導致
    兩位 agent 來回對答完全沒有真人聆聽該有的停頓感。這裡只從資料
    位元組數反推時長（假設 16-bit=2 bytes/sample、單聲道），不需要真的
    解碼音訊，MockTTSService 的靜音資料一樣適用。
    """
    if not audio_bytes or not sample_rate:
        return 0.0
    return (len(audio_bytes) / 2 / sample_rate) * 1000.0


def _parse_verdict_json(raw: str) -> Optional[dict]:
    """
    盡力把 LLM 回覆解析成判決書 dict：先直接 json.loads，失敗再嘗試剝掉
    常見的 ```json fence 或抓出第一個 {...} 區塊。完全失敗回 None（呼叫端
    退化處理，不拋例外）。
    """
    candidates = [raw]
    fenced = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
    if fenced != raw:
        candidates.append(fenced)
    brace_match = re.search(r"\{.*\}", raw, re.DOTALL)
    if brace_match:
        candidates.append(brace_match.group(0))
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


class DebateOrchestrator:
    """雙 Agent 輪流辯論／討論編排器（見檔案開頭說明）。"""

    def __init__(
        self,
        agent_a: AgentConfig,
        agent_b: AgentConfig,
        topic: DebateTopic,
        llm_service: LLMService,
        tts_service: TTSService,
        max_turns: int = 20,
        max_pacing_seconds: float = 12.0,
        pacing_sleep_fn: Optional[Callable[[float], Awaitable[Any]]] = None,
    ):
        if agent_a.agent_id == agent_b.agent_id:
            raise ValueError("辯論模式需要兩位「不同」的 agent")

        self.agents = [agent_a, agent_b]
        self._agents_by_id = {a.agent_id: a for a in self.agents}
        self.topic = topic
        self.llm_service = llm_service
        self.tts_service = tts_service
        self.max_turns = max_turns
        # 單輪節奏控制 sleep 的時間上限（秒），避免單輪講太長的話時節奏
        # 控制反而讓等待時間離譜地久（見檔案開頭「節奏控制」說明）。
        self.max_pacing_seconds = max_pacing_seconds
        # 可注入的 sleep 實作，預設用真正的 asyncio.sleep；單元測試可以
        # 換成立即完成的假版本，避免測試套件被真的拖慢。
        self._pacing_sleep_fn = pacing_sleep_fn or asyncio.sleep
        self.history: list[dict] = []
        self.turn_count = 0
        # 預設由使用者選擇的第一位 agent（agent_a）先開口
        self.current_speaker_id = agent_a.agent_id

    @property
    def is_finished(self) -> bool:
        """達到回合上限（避免使用者忘記暫停/結束時，背景一直呼叫 LLM 燒 API 額度）。"""
        return self.turn_count >= self.max_turns

    def _other_agent_id(self, agent_id: str) -> str:
        return next(a.agent_id for a in self.agents if a.agent_id != agent_id)

    def _build_debate_system_prompt(self, agent: AgentConfig) -> str:
        other = self._agents_by_id[self._other_agent_id(agent.agent_id)]
        return agent.persona_prompt + _DEBATE_INSTRUCTION_TEMPLATE.format(
            other_name=other.display_name,
            topic_title=self.topic.title,
            seed_prompt=self.topic.seed_prompt,
            name=agent.display_name,
        )

    def _strip_leading_speaker_prefix(self, text: str) -> str:
        """
        防呆：跟 orchestrator._strip_leading_speaker_prefix 相同邏輯（只處理
        「開頭」的顯示名稱前綴，不動文字中間內容），候選名單多包含「使用者」，
        避免 LLM 誤把使用者插話的格式也模仿進自己的回覆開頭。
        """
        stripped = text.lstrip()
        candidates = [a.display_name for a in self.agents if a.display_name] + ["使用者"]
        for name in candidates:
            for sep in ("：", ":"):
                prefix = f"{name}{sep}"
                if stripped.startswith(prefix):
                    return stripped[len(prefix):].lstrip()
        return text

    def _build_messages(self) -> list[dict]:
        """
        組出餵給 LLM 的對話歷史，跟 orchestrator._build_messages 一樣用
        「顯示名稱：內容」前綴標示每句話的講者，使用者插話則標示「使用者：」。
        """
        recent = self.history[-12:]
        messages: list[dict] = []
        for turn in recent:
            if turn["role"] == "user":
                messages.append({"role": "user", "content": f"使用者：{turn['text']}"})
                continue
            speaker = self._agents_by_id.get(turn.get("agent_id"))
            speaker_name = speaker.display_name if speaker else turn.get("agent_id", "assistant")
            messages.append({"role": "assistant", "content": f"{speaker_name}：{turn['text']}"})
        return messages

    def open_debate(self) -> None:
        """
        辯論開場：把主題塞進歷史當作引導語（只在第一次呼叫時生效，重複呼叫
        不會重複塞入，方便呼叫端不用自己追蹤「是不是第一次」）。
        """
        if self.history:
            return
        self.history.append(
            {
                "role": "user",
                "text": f"（主持人）今天的討論主題是：{self.topic.title}。{self.topic.seed_prompt}",
            }
        )

    def snapshot_state(self) -> tuple:
        """
        投機生成（預生成下一輪）前呼叫：記下目前的對話狀態。

        搭配 rollback_state() 使用，見 routers/ws_debate.py 的
        「預生成下一輪」說明：_run_debate_loop 趁前端播放這一輪時就先生成
        下一輪（事件扣在本地 buffer），如果使用者在下一輪「釋出之前」敲槌
        插話，這輪投機生成的內容使用者根本沒聽到，必須整個丟棄——包含
        run_next_turn() 成功跑完後寫進 history 的發言、遞增的 turn_count
        與切換過的 current_speaker_id，否則插話後 LLM 會看到一段「幽靈
        發言」（後端有記錄、使用者沒聽過），接續回應就對不上使用者的認知。
        """
        return (len(self.history), self.turn_count, self.current_speaker_id)

    def rollback_state(self, snapshot: tuple) -> None:
        """
        丟棄投機生成的那一輪，把狀態還原到 snapshot_state() 當下。

        冪等：投機那輪如果在生成中途就被取消（run_next_turn() 的既有保證
        是中途取消不寫入任何狀態），這裡的還原不會有任何效果，重複呼叫
        也安全。
        """
        history_len, turn_count, speaker_id = snapshot
        del self.history[history_len:]
        self.turn_count = turn_count
        self.current_speaker_id = speaker_id

    def reconcile_history_with_client(self, agent_id: str, heard_texts: list) -> None:
        """
        使用者暫停（介入/跳過）時，把「被打斷的那一輪」的對話歷史修剪成
        前端實際顯示過的內容（final web 的 pause_debate 會帶 heard_texts，
        見 models/schemas.py；沒帶就完全不會走到這裡，Unity/舊網頁版
        行為不變）。

        為什麼需要：run_next_turn() 是整輪生成成功才 append 進 history，
        但前端是逐句顯示/播放——使用者按暫停時，畫面上可能只出現了
        這一輪的前幾句。若不修剪，插話後的接續回應與判決書會參照
        「使用者根本沒看到/聽到的後半段」。三種情況：
          1. 最後一筆 history 是這位 agent（整輪已生成、播放中被打斷）：
             把該筆內容換成前端實際顯示的句子 + 打斷標記；heard_texts
             是空的（一句都還沒顯示）則整筆移除並還原輪數/發言者，
             視同這一輪沒發生（比照 rollback_state 的語意）。
          2. 最後一筆不是這位 agent（該輪生成中途被取消、沒寫進
             history，但前端已直通串流顯示了部分句子）：把使用者真正
             看到的部分補寫進 history（不切換 current_speaker_id，
             被打斷的那位照舊接續回應）。
          3. 前端顯示的內容跟 history 完全一致：什麼都不做。
        """
        heard = "".join((t or "").strip() for t in (heard_texts or []))
        interrupted_marker = "……（話說到一半，被使用者打斷）"
        idx = next(
            (i for i in range(len(self.history) - 1, -1, -1) if self.history[i].get("role") == "assistant"),
            None,
        )
        last = self.history[idx] if idx is not None else None
        if last is not None and last.get("agent_id") == agent_id:
            full_text = (last.get("text") or "").strip()
            if not heard:
                del self.history[idx]
                self.turn_count = max(0, self.turn_count - 1)
                self.current_speaker_id = agent_id
            elif heard != full_text:
                last["text"] = heard + interrupted_marker
                # 修過的真實問題（final web 實測）：預生成機制下，使用者聽
                # A 講話時 A 這一輪早已寫入歷史、current_speaker 已切成 B，
                # 暫停+插話後重啟迴圈開口的是 B——體感是「介入後回應的
                # 內容像另一個立場」，要再等一輪才輪回被打斷的 A。這裡把
                # 發言權還給被打斷（話沒說完）的那位，插話後由他接續回應，
                # 符合「打斷誰、誰回應」的體驗預期。只有 heard_texts 路徑
                # （final web）會走到這裡，Unity/舊網頁版行為不變。
                self.current_speaker_id = agent_id
            return
        if heard:
            self.history.append(
                {"role": "assistant", "agent_id": agent_id, "text": heard + interrupted_marker}
            )

    def inject_user_message(self, text: str) -> None:
        """
        使用者插話：記錄進歷史。刻意不改變 current_speaker_id——插話發生在
        「某位 agent 正要／正在發言但被暫停」的當下，所以下一次
        run_next_turn() 應該還是同一位 agent 接續回應使用者的插話，
        符合真人對話中「被打斷後接著回應」的直覺。
        """
        self.history.append({"role": "user", "text": text})

    async def run_next_turn(self) -> AsyncIterator[dict]:
        """
        讓 current_speaker_id 這位 agent 講「一輪」（一次完整發言），成功講完
        後才 append 進 history、切換成另一位 agent。

        刻意設計成「單輪」的 async generator，方便呼叫端（routers/ws_debate.py）
        用 asyncio.Task 包住單獨這一輪：暫停 = task.cancel()，取消發生在
        中途任何一個 await 點都不會有副作用（history 沒有半吊子的紀錄、
        current_speaker_id 沒有切換、turn_count 沒有增加），因為所有寫入
        state 的動作都放在整個生成迴圈「成功跑完之後」才執行——這也包含
        檔案開頭說明的節奏控制 sleep：取消發生在節奏控制的等待期間，效果
        跟取消發生在生成過程中一樣，這一輪會被整個丟棄、不會留下殘留紀錄。
        """
        if self.is_finished:
            return

        agent_id = self.current_speaker_id
        agent = self._agents_by_id[agent_id]
        yield {"type": "agent_speaking_start", "agent_id": agent_id}

        turn_start = time.monotonic()
        total_audio_ms = 0.0

        full_text_parts: list[str] = []
        aggregator = SentenceAggregator(agent_id=agent_id)
        messages = self._build_messages()
        system_prompt = self._build_debate_system_prompt(agent)
        is_first_sentence = True

        async for token in self.llm_service.stream_reply(agent_id, system_prompt, messages):
            if token.is_final:
                break
            full_text_parts.append(token.delta_text)
            for sentence in aggregator.feed(token.delta_text):
                sentence_text = sentence.sentence
                if is_first_sentence:
                    sentence_text = self._strip_leading_speaker_prefix(sentence_text)
                    is_first_sentence = False
                async for tts_event in self._synthesize_and_wrap(agent, sentence_text):
                    total_audio_ms += self._estimate_event_duration_ms(tts_event)
                    yield tts_event

        for sentence in aggregator.flush():
            sentence_text = sentence.sentence
            if is_first_sentence:
                sentence_text = self._strip_leading_speaker_prefix(sentence_text)
                is_first_sentence = False
            async for tts_event in self._synthesize_and_wrap(agent, sentence_text):
                total_audio_ms += self._estimate_event_duration_ms(tts_event)
                yield tts_event

        # ---- 節奏控制（見檔案開頭說明）----
        estimated_seconds = min(total_audio_ms / 1000.0, self.max_pacing_seconds)
        elapsed_seconds = time.monotonic() - turn_start
        remaining_seconds = estimated_seconds - elapsed_seconds
        if remaining_seconds > 0:
            await self._pacing_sleep_fn(remaining_seconds)

        full_text = self._strip_leading_speaker_prefix("".join(full_text_parts))
        self.history.append({"role": "assistant", "agent_id": agent_id, "text": full_text})
        self.turn_count += 1
        self.current_speaker_id = self._other_agent_id(agent_id)
        yield {"type": "agent_speaking_end", "agent_id": agent_id}

    def _estimate_event_duration_ms(self, tts_event: dict) -> float:
        """
        估算一個 agent_speaking_chunk 事件對應的播放時長（見檔案開頭「節奏
        控制」說明）。

        修過的真實問題：TTS 合成失敗時（見 _synthesize_and_wrap 的
        tts_error 分支）audio_bytes 一定是空的，如果照舊只從 audio_bytes
        長度反推時長，算出來永遠是 0——節奏控制形同虛設，兩位 agent 會
        完全沒有停頓地飛快輪流講下去（使用者實測回報過的真實問題）。
        這裡改成：有 tts_error 時改用文字長度粗估（跟 MockTTSService
        一致的估法：中文每字約 0.2 秒），沒有 tts_error 時才用原本的
        音訊資料長度反推。
        """
        if tts_event.get("tts_error"):
            text_len = len(tts_event.get("text") or "")
            return max(text_len * 200.0, 500.0)
        return _audio_duration_ms(tts_event.get("audio_bytes"), tts_event.get("sample_rate", 24000))

    def _format_history_for_summary(self) -> str:
        """跟 orchestrator._format_history_for_summary 相同邏輯：把
        self.history 整理成「顯示名稱／使用者：內容」逐行文字。"""
        lines: list[str] = []
        for turn in self.history:
            if turn["role"] == "user":
                lines.append(f"使用者：{turn['text']}")
                continue
            speaker = self._agents_by_id.get(turn.get("agent_id"))
            speaker_name = speaker.display_name if speaker else turn.get("agent_id", "assistant")
            lines.append(f"{speaker_name}：{turn['text']}")
        return "\n".join(lines)

    async def generate_summary(self) -> str:
        """
        辯論結束時呼叫：把整場討論歷史（含主題）整理成文字，請 LLM 生成
        一句總結性的鼓勵話語，作為使用者可以帶走的紀念品（見
        routers/ws_debate.py 的 end_session 處理）。設計理由同
        agents/orchestrator.py 的 generate_summary()：不重用
        _build_messages()，改成一次性塞進單一個 user message，agent_id
        固定用 "summary"。
        """
        transcript = self._format_history_for_summary()
        if not transcript:
            return "謝謝你今天願意花時間傾聽與思考，每一次自我對話都是成長的養分。"

        system_prompt = _DEBATE_SUMMARY_SYSTEM_PROMPT_TEMPLATE.format(topic_title=self.topic.title)
        messages = [{"role": "user", "content": f"以下是這場討論的紀錄：\n{transcript}"}]

        full_text_parts: list[str] = []
        async for token in self.llm_service.stream_reply("summary", system_prompt, messages):
            if token.is_final:
                break
            full_text_parts.append(token.delta_text)
        return "".join(full_text_parts).strip()

    async def generate_verdict(self) -> dict:
        """
        辯論結束時呼叫：生成「內在法庭」結構化判決書（VR 流程腳本 End scene
        的最終產物），欄位見 _DEBATE_VERDICT_SYSTEM_PROMPT_TEMPLATE。

        堅固性設計：
        - LLM 回傳非合法 JSON（或缺欄位）時不拋例外，退化成把整段文字塞進
          final_verdict / closing_line，結束流程照常走完。
        - 歷史為空（使用者直接結束）時回傳保底判決書。
        agent_id 固定用 "verdict"（MockLLMService 依此回傳測試用 JSON 腳本，
        跟 "summary" 的一句總結語區分開）。
        """
        agent_a, agent_b = self.agents[0], self.agents[1]
        fallback = {
            "case_title": self.topic.title,
            "initial_bias": "",
            "viewpoint_a": "",
            "viewpoint_b": "",
            "judge_interventions": [],
            "final_verdict": "本庭確認：願意坐上法官席、傾聽內心不同聲音本身，就是內在修正的開始。",
            "revised_belief": "我的內心可以同時容納不同的聲音，而由我做出最終裁決。",
            "closing_line": "謝謝你今天願意花時間傾聽與思考，每一次自我對話都是成長的養分。",
        }

        transcript = self._format_history_for_summary()
        if not transcript:
            return fallback

        system_prompt = _DEBATE_VERDICT_SYSTEM_PROMPT_TEMPLATE.format(
            topic_title=self.topic.title,
            agent_a_name=agent_a.display_name,
            agent_a_role=agent_a.role_tag or agent_a.display_name,
            agent_b_name=agent_b.display_name,
            agent_b_role=agent_b.role_tag or agent_b.display_name,
        )
        messages = [{"role": "user", "content": f"以下是這場審理的逐字紀錄：\n{transcript}"}]

        full_text_parts: list[str] = []
        async for token in self.llm_service.stream_reply("verdict", system_prompt, messages):
            if token.is_final:
                break
            full_text_parts.append(token.delta_text)
        raw = "".join(full_text_parts).strip()
        if not raw:
            return fallback

        parsed = _parse_verdict_json(raw)
        if parsed is None:
            # 不是合法 JSON：整段文字仍然有內容價值，塞進主文與結語退化呈現。
            fallback["final_verdict"] = raw
            fallback["closing_line"] = raw.splitlines()[-1].strip() or fallback["closing_line"]
            return fallback

        # 缺欄位用 fallback 值補齊，保證下游（Unity 判決書面板／手機 ResultPage）
        # 永遠拿得到完整欄位、不需要各自防呆。
        merged = {**fallback, **{k: v for k, v in parsed.items() if v not in (None, "")}}
        if not isinstance(merged.get("judge_interventions"), list):
            merged["judge_interventions"] = fallback["judge_interventions"]
        return merged

    async def _synthesize_and_wrap(self, agent: AgentConfig, sentence: str) -> AsyncIterator[dict]:
        """
        跟 orchestrator._synthesize_and_wrap 相同邏輯：一句只在第一個音訊
        chunk 帶文字；額外帶上 sample_rate，供 run_next_turn() 估算播放
        時長（見 _audio_duration_ms() / _estimate_event_duration_ms()）。

        修過的真實問題：CosyVoice 2 合成失敗時（例如模型推理錯誤）以前會
        整個 exception 往外傳，讓 run_next_turn()、_run_debate_loop() 的
        背景 task 直接掛掉、整場辯論無聲無息地卡死（debate_task 拋出的
        例外沒有人接住，之後就再也不會有新的一輪）。現在改成：合成失敗時
        記錄清楚的錯誤 log，並且仍然吐出一個 agent_speaking_chunk 事件
        （文字照常顯示/寫入歷史，audio_bytes 留空、標記 tts_error），讓
        辯論可以繼續進行下去，只是這一句沒有聲音——比整場卡死或完全沒有
        感覺地飛快跳下一輪都更接近「優雅降級」。
        """
        is_first_chunk_of_sentence = True
        try:
            async for chunk in self.tts_service.synthesize(agent.agent_id, sentence, agent.voice_profile_id):
                if chunk.is_final:
                    continue
                yield {
                    "type": "agent_speaking_chunk",
                    "agent_id": agent.agent_id,
                    "text": sentence if is_first_chunk_of_sentence else "",
                    "audio_bytes": chunk.audio_bytes,
                    "sample_rate": chunk.sample_rate,
                    "ttfb_ms": chunk.ttfb_ms,
                }
                is_first_chunk_of_sentence = False
        except Exception as exc:  # noqa: BLE001
            logger.error("TTS 合成失敗（agent=%s, sentence=%s）：%s", agent.agent_id, sentence[:30], exc)
            yield {
                "type": "agent_speaking_chunk",
                "agent_id": agent.agent_id,
                "text": sentence if is_first_chunk_of_sentence else "",
                "audio_bytes": b"",
                "sample_rate": 24000,
                "ttfb_ms": None,
                "tts_error": str(exc),
            }
# （檔尾註解：本檔案的投機生成 snapshot/rollback 支援見 snapshot_state()）

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
import logging
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
    "【對話歷史格式說明】接下來提供的對話歷史中，每一則發言前面會加上"
    "「顯示名稱：」（例如「{name}：...」或「使用者：...」），這只是用來"
    "標示每一句話是誰說的，不是要你模仿這種格式。你自己回覆時，請直接"
    "輸出你（{name}）要說的話本身，不要在開頭加上「{name}：」這樣的名字"
    "前綴，也不要在同一則回覆裡切換身分、扮演或模擬「{other_name}」的發言。"
    "如果歷史中出現「使用者：」開頭的發言，代表是正在聆聽的使用者中途"
    "插話，請自然地回應使用者提出的意見或問題，再視情況延續原本的討論方向。"
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
                    total_audio_ms += _audio_duration_ms(
                        tts_event.get("audio_bytes"), tts_event.get("sample_rate", 24000)
                    )
                    yield tts_event

        for sentence in aggregator.flush():
            sentence_text = sentence.sentence
            if is_first_sentence:
                sentence_text = self._strip_leading_speaker_prefix(sentence_text)
                is_first_sentence = False
            async for tts_event in self._synthesize_and_wrap(agent, sentence_text):
                total_audio_ms += _audio_duration_ms(
                    tts_event.get("audio_bytes"), tts_event.get("sample_rate", 24000)
                )
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

    async def _synthesize_and_wrap(self, agent: AgentConfig, sentence: str) -> AsyncIterator[dict]:
        """
        跟 orchestrator._synthesize_and_wrap 相同邏輯：一句只在第一個音訊
        chunk 帶文字；額外帶上 sample_rate，供 run_next_turn() 估算播放
        時長（見 _audio_duration_ms()）。
        """
        is_first_chunk_of_sentence = True
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

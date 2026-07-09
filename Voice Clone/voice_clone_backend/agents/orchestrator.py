"""
agents/orchestrator.py — 多 Agent 對話編排器

把 STT → 路由決策（Handoff / Job Group）→ LLM 串流 → 逐句斷句 → TTS 串流
串起來，是 pipeline/conversation_pipeline.py 實際呼叫的核心物件。

路由決策邏輯（對照架構文件待辦事項 4）：
    - agent_routing_strategy=heuristic（預設，測試友善）：
        用 job_group.should_use_job_group() 偵測使用者是否要求多角色同時發言，
        是則走 Job Group（平行），否則走 Handoff（HandoffCoordinator 決定）。
        Handoff 沒有指名特定 agent 時，預設「全體依序輪流各自回應一次」
        （像小組討論：使用者說一句話，agent A 先回、接著 B、再來 C）；
        若使用者訊息提到某個 agent 的名字，則只由該 agent 回應（同時提到多個
        名字時，挑文字中最先出現的那一個，見 agents/handoff.py 說明）。
    - agent_routing_strategy=llm_decision：
        改由 LLM 判斷「這句話該由誰回應」（見 agents/handoff.py 的
        build_llm_routing_decision_fn）。__init__ 這裡會自動用 llm_service
        （跟產生實際回覆用的同一個）組出對應的 llm_decision_fn 並注入
        HandoffCoordinator，呼叫端只要把 routing_strategy 設成 "llm_decision"
        就會生效，不需要額外接線（修過的 bug：過去這裡沒有真的組 llm_decision_fn，
        設定了 llm_decision 也永遠 fallback 用 heuristic）。

輸出以 async generator 方式吐出事件字典，對應 models.schemas.ServerMessage
的欄位命名，routers/ws_voice_agents.py 直接把每個事件轉成 JSON 送給前端。
"""

from __future__ import annotations

import logging
from typing import Any, AsyncIterator, Optional

from agents.handoff import HandoffCoordinator, build_llm_routing_decision_fn
from agents.job_group import JobGroupCoordinator, should_use_job_group
from models.schemas import AgentConfig, RoutingMode
from services.llm_service import LLMService, SentenceAggregator
from services.stt_service import STTService
from services.tts_service import TTSService

logger = logging.getLogger(__name__)

# 修過的 bug：_build_messages() 把對話歷史組成「顯示名稱：內容」的格式餵給
# LLM，讓 LLM 能分辨每句話是誰講的（見該方法的說明）。但這個格式本身會被
# LLM「模仿」，導致它自己的回覆也開頭加上「顯示名稱：」（前端本來就會再疊
# 一次顯示名稱，結果變成「小華：小華：...」），甚至在同一則回覆裡切換身分、
# 扮演起別的 agent（例如「小華：小明：...」）。這裡在每個 agent 的
# system prompt 後面加一段明確提醒，從源頭降低這種模仿行為發生的機率。
_SPEAKER_PREFIX_GUARDRAIL = (
    "\n\n【對話歷史格式說明】接下來提供的對話歷史中，每一則發言前面會加上"
    "「顯示名稱：」（例如「{name}：...」），這只是用來標示每一句話是誰說的，"
    "方便你分辨哪些是你自己過去說過的話、哪些是別人說的，不是要你模仿這種"
    "格式。你自己回覆時，請直接輸出你（{name}）要說的話本身，不要在開頭加上"
    "「{name}：」這樣的名字前綴，也不要在同一則回覆裡切換身分、扮演或模擬"
    "其他角色的發言。"
)

# 對話結束時用來生成「總結紀念語」的 system prompt。刻意跟一般回覆的
# persona system prompt 完全分開（不掛在任何一個 agent 身上），因為這句
# 總結不是「某個 agent 說的話」，而是旁觀整場對話後給使用者的一句鼓勵語。
# MockLLMService 用 agent_id == "summary" 判斷要回傳哪一種固定腳本
# （見 services/llm_service.py），這裡呼叫 stream_reply() 時也固定傳
# "summary" 當 agent_id，兩邊要對得上。
_SUMMARY_SYSTEM_PROMPT = (
    "你是一位溫暖、有洞察力的陪伴者。使用者剛剛結束了一場多 Agent 對話體驗，"
    "以下是這場對話的逐字紀錄。請根據對話內容，生成「一句」溫暖、勵志、"
    "帶有心靈雞湯或鼓勵意涵的總結話語，作為使用者結束體驗後可以帶走的紀念語。\n"
    "要求：\n"
    "1. 只輸出一句話（可以是一個完整的句子，不要條列、不要標題、不要換行）。\n"
    "2. 語氣溫暖真誠，盡量貼合對話中實際出現的內容或情緒，不要空泛制式。\n"
    "3. 使用繁體中文。\n"
    "4. 不要加上引號或任何前綴（例如「總結：」），直接輸出這句話本身。"
)


class MultiAgentOrchestrator:
    """
    多 Agent 對話編排器：串接 STT / 路由決策 / LLM / TTS。

    可透過建構子注入所有依賴（測試時全部換成 mock），未提供則使用
    services 模組的預設單例。
    """

    def __init__(
        self,
        agents: list[AgentConfig],
        stt_service: STTService,
        llm_service: LLMService,
        tts_service: TTSService,
        routing_strategy: str = "heuristic",
        max_concurrent_agents: int = 4,
    ):
        self.agents = agents
        self._agents_by_id = {a.agent_id: a for a in agents}
        self.stt_service = stt_service
        self.llm_service = llm_service
        self.tts_service = tts_service

        # routing_strategy=llm_decision 時，用自己手上的 llm_service 組出
        # 路由判斷函式並注入 HandoffCoordinator，讓「這句話該由誰回應」
        # 真的會呼叫 LLM，而不是只有設定值卻永遠 fallback 用 heuristic
        # （見 agents/handoff.py 的 build_llm_routing_decision_fn 說明）。
        llm_decision_fn = (
            build_llm_routing_decision_fn(llm_service) if routing_strategy == "llm_decision" else None
        )
        self.handoff = HandoffCoordinator(strategy=routing_strategy, llm_decision_fn=llm_decision_fn)
        self.job_group = JobGroupCoordinator(max_concurrency=max_concurrent_agents)
        self.history: list[dict] = []

    async def transcribe_user_audio(self, audio_bytes: bytes) -> dict:
        result = await self.stt_service.transcribe(audio_bytes)
        return {
            "type": "user_transcript",
            "text": result.text,
            "engine_used": result.engine_used.value,
            "used_fallback": result.used_fallback,
        }

    async def handle_user_text(self, user_text: str) -> AsyncIterator[dict]:
        """
        主要入口：使用者文字（可能來自 STT 或直接文字輸入）進來後，
        決定該用 Handoff 還是 Job Group，並串流吐出每個 agent 的發話事件。
        """
        self.history.append({"role": "user", "text": user_text})

        if should_use_job_group(user_text, len(self.agents)):
            target_agent_ids = [a.agent_id for a in self.agents]
            decision = self.job_group.make_routing_decision(target_agent_ids)
        else:
            decision = await self.handoff.decide(user_text, self.agents)

        yield {
            "type": "routing_decision",
            "mode": decision.mode.value,
            "agent_ids": decision.target_agent_ids,
        }

        if decision.mode == RoutingMode.JOB_GROUP:
            async for event in self._run_job_group(decision.target_agent_ids, user_text):
                yield event
        else:
            # Handoff：依序（非平行）逐一呼叫每個目標 agent。
            # target_agent_ids 可能只有一個（使用者指名）或全部（沒指名，
            # 全體依序輪流各自回應一次），兩種情況都走同一段程式碼。
            for agent_id in decision.target_agent_ids:
                async for event in self._run_single_agent(agent_id, user_text):
                    yield event

    def _build_system_prompt(self, agent: AgentConfig) -> str:
        """
        agent 的 system prompt = persona_prompt + 對話歷史格式提醒（見
        _SPEAKER_PREFIX_GUARDRAIL 說明）。提醒文字對同一個 agent 每次都
        完全一樣（只跟 agent.display_name 有關，不含任何逐輪變動的內容），
        不會破壞 llm_service.py 提到的「system prompt 保持逐字節不變」
        前綴快取需求。
        """
        return agent.persona_prompt + _SPEAKER_PREFIX_GUARDRAIL.format(name=agent.display_name)

    def _strip_leading_speaker_prefix(self, text: str) -> str:
        """
        防呆：就算 system prompt 已經提醒過，LLM 有時候還是會在回覆開頭
        模仿歷史訊息的「顯示名稱：」格式（不管是加上自己的名字，還是誤植成
        別人的名字）。這裡檢查文字開頭是不是剛好是候選名單裡任一個 agent
        的顯示名稱加上全形或半形冒號，是的話就去掉，避免前端疊加顯示名稱
        後變成「小華：小華：...」這種重複，或是把別人的名字誤植在自己的
        發言開頭。只用來處理「開頭」這種最常見、最好安全去除的情況，不會
        去動文字中間的內容（避免誤刪合法內容，例如角色台詞裡本來就有的
        人名加冒號）。
        """
        stripped = text.lstrip()
        for candidate in self.agents:
            name = candidate.display_name
            if not name:
                continue
            for sep in ("：", ":"):
                prefix = f"{name}{sep}"
                if stripped.startswith(prefix):
                    return stripped[len(prefix):].lstrip()
        return text

    async def _run_single_agent(self, agent_id: str, user_text: str) -> AsyncIterator[dict]:
        agent = self._agents_by_id[agent_id]
        yield {"type": "agent_speaking_start", "agent_id": agent_id}

        full_text_parts: list[str] = []
        aggregator = SentenceAggregator(agent_id=agent_id)
        messages = self._build_messages(user_text)
        system_prompt = self._build_system_prompt(agent)

        # 只需要防呆「回覆開頭」：LLM 模仿「顯示名稱：」格式幾乎都發生在
        # 整段回覆的第一句，不會每一句都重新加一次前綴。
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
                    yield tts_event

        for sentence in aggregator.flush():
            sentence_text = sentence.sentence
            if is_first_sentence:
                sentence_text = self._strip_leading_speaker_prefix(sentence_text)
                is_first_sentence = False
            async for tts_event in self._synthesize_and_wrap(agent, sentence_text):
                yield tts_event

        full_text = self._strip_leading_speaker_prefix("".join(full_text_parts))
        self.history.append({"role": "assistant", "agent_id": agent_id, "text": full_text})
        yield {"type": "agent_speaking_end", "agent_id": agent_id}

    async def _run_job_group(self, agent_ids: list[str], user_text: str) -> AsyncIterator[dict]:
        """
        平行處理多個 agent：每個 agent 各自完整跑完（LLM 串流 + TTS），
        事件用 asyncio.Queue 合併後依產生順序吐出，agent 之間互不等待。

        修過的真實問題：使用者結束對話時（routers/ws_voice_agents.py 的
        end_session 處理會 cancel 掉正在跑這個 async generator 的
        asyncio.Task，讓「按下結束立刻進總結頁面」不用等生成跑完），
        Python 會在這個 generator 目前卡住的 await 點（下面的
        `await queue.get()`）注入 CancelledError；問題是這裡用
        `asyncio.create_task()` 額外開出來的每個 agent 背景 task
        （`tasks` 這個列表）並不是這個 generator 的「子項」，asyncio
        沒有自動幫忙一起取消——就算外層被取消了，這些背景 task 仍然會
        繼續在背景呼叫 LLM/TTS，白白浪費運算資源/API 額度，也違背使用者
        「中斷當前的所有生成」的期待，只是前端不會再收到後續事件而已。
        修法：`except asyncio.CancelledError` 時，主動把還沒完成的
        agent task 全部 cancel() 並等它們真的停下來，再把 CancelledError
        往外傳（跟 agents/debate.py 的取消哲學一致：不吞掉 CancelledError，
        但要確保自己開出去的背景工作也一併真的停止）。
        """
        import asyncio

        queue: asyncio.Queue[Optional[dict]] = asyncio.Queue()

        async def _run_and_forward(agent_id: str) -> None:
            try:
                async for event in self._run_single_agent(agent_id, user_text):
                    await queue.put(event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("Job group agent %s 執行失敗：%s", agent_id, exc)
                await queue.put({"type": "error", "message": str(exc), "agent_id": agent_id})
            finally:
                await queue.put(None)  # 該 agent 結束標記

        tasks = [asyncio.create_task(_run_and_forward(aid)) for aid in agent_ids]
        try:
            remaining = len(tasks)
            while remaining > 0:
                event = await queue.get()
                if event is None:
                    remaining -= 1
                    continue
                yield event

            await asyncio.gather(*tasks)
        except asyncio.CancelledError:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise

    async def _synthesize_and_wrap(self, agent: AgentConfig, sentence: str) -> AsyncIterator[dict]:
        """
        呼叫 TTS 合成一個句子，把每個「音訊 chunk」包成 agent_speaking_chunk 事件。

        修過的 bug：TTS 串流合成一個句子時常常會分好幾個音訊 chunk 吐出
        （例如 MockTTSService 依文字長度模擬分段），過去每個音訊 chunk 都會
        把整句 sentence 文字重複塞進 text 欄位，前端 transcript 因此把同一句
        話重複顯示好幾次（chunk 數量正好等於重複次數）。現在只有該句「第一個」
        音訊 chunk 附帶文字，之後的 chunk 文字留空，前端只在文字非空時才記一筆
        transcript（音訊仍然每個 chunk 都會照樣播放，不受影響）。
        """
        # 修過的真實問題：TTS 合成失敗時（例如 CosyVoice 2 推理錯誤）以前
        # 會整個 exception 往外傳，讓這句話（連同它的文字）完全不會產生
        # 任何 agent_speaking_chunk 事件，前端 transcript 因此直接漏掉這
        # 句話，使用者只會看到 agent 忽然沒講完就結束，看不出發生了什麼
        # 事。現在改成：合成失敗時記錄清楚的錯誤 log，仍然吐出一個帶著
        # 文字、audio_bytes 留空並標記 tts_error 的事件，讓文字至少正常
        # 顯示（見 agents/debate.py 的 _synthesize_and_wrap 有相同修法，
        # 該檔案額外還處理了節奏控制的部分）。
        # 修過的另一個真實問題：這裡以前沒有帶 sample_rate 欄位（debate.py
        # 的同名函式有帶），前端播放時就沒有依據可以正確設定 AudioBuffer
        # 的取樣率，只能用寫死的預設值猜——真的接上 CosyVoice 2 之後兩邊
        # 取樣率剛好都是 24000 才「湊巧」正確，其他情況會播放速度/音高跑掉。
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

    def _build_messages(self, user_text: str) -> list[dict]:
        """
        組出餵給 LLM 的對話歷史（OpenAI 風格 messages 列表，Gemini 會在
        llm_service._stream_gemini 內再轉換角色字串，見該檔案說明）。

        修過的限制：self.history 裡每筆 agent 發言其實都帶著 agent_id
        （見 _run_single_agent 最後 append 的那行），但這裡以前組訊息時
        把 agent_id 丟掉、只留純文字，導致某個 agent 生成回覆時，對話
        歷史裡混著好幾個不同 agent 講過的話，卻完全看不出「這句是誰講
        的」，容易讓 LLM 誤把別人講過的話當成自己講過。現在每則 agent
        歷史發言都會加上「顯示名稱：」前綴，讓 LLM 從歷史文字本身就能
        分辨每一句話的講者是誰；目前正在生成回覆的 agent 會從自己的
        system prompt（persona_prompt，見 _build_system_prompt）知道
        「我是誰」，兩者對照就能判斷歷史裡哪些話是自己說過的、哪些是
        其他 agent 說的。

        注意：這個「顯示名稱：」格式本身可能被 LLM 模仿進自己的回覆裡，
        _run_single_agent 有搭配 _build_system_prompt 的提醒文字 +
        _strip_leading_speaker_prefix 防呆處理這個副作用。
        """
        # 簡化版對話歷史：僅取最近幾輪，避免 prompt 過長影響延遲
        recent = self.history[-10:]
        messages = []
        for turn in recent:
            if turn["role"] == "user":
                messages.append({"role": "user", "content": turn["text"]})
                continue

            speaker_agent = self._agents_by_id.get(turn.get("agent_id"))
            speaker_name = (
                speaker_agent.display_name if speaker_agent else turn.get("agent_id", "assistant")
            )
            messages.append({"role": "assistant", "content": f"{speaker_name}：{turn['text']}"})

        if not messages or messages[-1]["content"] != user_text:
            messages.append({"role": "user", "content": user_text})
        return messages

    def _format_history_for_summary(self) -> str:
        """把整段 self.history 整理成「顯示名稱：內容」逐行文字，供
        generate_summary() 當作單一 user message 的內容餵給 LLM。"""
        lines: list[str] = []
        for turn in self.history:
            if turn["role"] == "user":
                lines.append(f"使用者：{turn['text']}")
                continue
            speaker_agent = self._agents_by_id.get(turn.get("agent_id"))
            speaker_name = (
                speaker_agent.display_name if speaker_agent else turn.get("agent_id", "assistant")
            )
            lines.append(f"{speaker_name}：{turn['text']}")
        return "\n".join(lines)

    async def generate_summary(self) -> str:
        """
        對話結束時呼叫：把整場對話歷史整理成文字，請 LLM 生成一句總結性
        的鼓勵話語，作為使用者可以帶走的紀念品（見
        routers/ws_voice_agents.py 的 end_session 處理）。

        刻意不重用 _build_messages()（那是「幫某個 agent 產生下一句回覆」
        用的格式，會把最新一句使用者輸入單獨拉出來當最後一則 user
        message）；這裡要做的是「把整段歷史當成材料，請 LLM 用旁觀者視角
        整理感想」，所以改成一次性塞進單一個 user message，agent_id 固定
        用 "summary"（不對應任何一位 agent，也是 MockLLMService 用來判斷
        要回傳哪一種固定腳本的依據）。
        """
        transcript = self._format_history_for_summary()
        if not transcript:
            # 理論上不會發生（後端只有在使用者送出 end_session 時才會呼叫，
            # 通常已經有至少一輪對話），但保底一句通用鼓勵語，避免呼叫端
            # 收到空字串。
            return "謝謝你今天願意敞開心分享，每一次對話都是認識自己的機會。"

        messages = [{"role": "user", "content": f"以下是這場對話的紀錄：\n{transcript}"}]

        full_text_parts: list[str] = []
        async for token in self.llm_service.stream_reply("summary", _SUMMARY_SYSTEM_PROMPT, messages):
            if token.is_final:
                break
            full_text_parts.append(token.delta_text)
        return "".join(full_text_parts).strip()

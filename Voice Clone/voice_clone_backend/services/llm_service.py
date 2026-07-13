"""
services/llm_service.py — LLM 串流生成 + 逐句斷句轉發

對照架構文件 2.3 節：
    - 直接串接 OpenAI GPT 或 Google Gemini，追求最佳品質與速度，不自行本地部署 LLM
    - 啟用 streaming：token 逐字輸出，SentenceAggregator 緩衝到偵測到句子邊界
      （。！？!?\n）才把文字轉發給 TTS，讓 TTS 能「邊生成邊念」
    - 延遲優化：
        1. System prompt 保持逐字節不變 → 觸發雲端服務商的 prompt 前綴快取，降低 TTFT
        2. 絕對不要包一層「等待完整回覆才 return」的邏輯，會殺掉串流效果

本檔案兩個核心元件：
    - SentenceAggregator：純邏輯（不依賴任何 LLM SDK），把 token stream 轉成句子 stream，
      是最需要單獨測試的部分（見 tests/test_sentence_aggregator.py）。
    - LLMService：實際呼叫 OpenAI / Gemini streaming API 的封裝。

注意（曾修過的 bug）：orchestrator._build_messages() 產生的對話歷史一律用
OpenAI 慣例（"user" / "assistant"）。OpenAI API 本來就吃這兩個字，可以直接
傳；但 Google 的 google.generativeai SDK 在 start_chat(history=...) 裡只接受
"user" / "model" 兩種角色，塞 "assistant" 進去會直接被 Gemini 拒絕（400
Role 'assistant' is not supported.）。所以 _stream_gemini 內部要自行把
"assistant" 轉成 "model" 再組 history，不能假設呼叫端會傳對的角色字串。
"""

from __future__ import annotations

import logging
from typing import AsyncIterator, Optional

from config import get_settings
from models.schemas import LLMTextChunk, SentenceChunk

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# SentenceAggregator — 逐句斷句（純邏輯，無外部依賴，最容易單元測試）
# ─────────────────────────────────────────────────────────────────────────────

class SentenceAggregator:
    """
    把 LLM 逐字 token stream 緩衝成「完整句子」再吐出，讓 TTS 可以邊生成邊念。

    設計重點：
        - 不等整句「回覆」結束才輸出，只等一個「句子」邊界（標點或換行）。
        - 最後若還有殘餘文字（LLM 結束但沒有標點收尾），在 flush() 時吐出，
          並標記 is_final_of_turn=True。

    使用方式：
        agg = SentenceAggregator(agent_id="agent-1")
        async for delta in llm_token_stream:
            for sentence in agg.feed(delta):
                await tts.enqueue(sentence)
        for sentence in agg.flush():
            await tts.enqueue(sentence)
    """

    def __init__(self, agent_id: str, boundary_chars: Optional[str] = None):
        self.agent_id = agent_id
        self._boundary_chars = set(boundary_chars or get_settings().sentence_boundary_chars)
        self._buffer = ""

    def feed(self, delta_text: str) -> list[SentenceChunk]:
        """餵入新的 token/delta 文字，回傳目前可以送出的完整句子（可能為空列表）。"""
        self._buffer += delta_text
        sentences: list[SentenceChunk] = []

        start = 0
        for idx, ch in enumerate(self._buffer):
            if ch in self._boundary_chars:
                sentence_text = self._buffer[start : idx + 1].strip()
                if sentence_text:
                    sentences.append(SentenceChunk(agent_id=self.agent_id, sentence=sentence_text))
                start = idx + 1

        self._buffer = self._buffer[start:]
        return sentences

    def flush(self) -> list[SentenceChunk]:
        """LLM 該輪回覆結束時呼叫，吐出殘餘文字（標記為該輪最後一句）。"""
        remaining = self._buffer.strip()
        self._buffer = ""
        if not remaining:
            return []
        return [SentenceChunk(agent_id=self.agent_id, sentence=remaining, is_final_of_turn=True)]


# ─────────────────────────────────────────────────────────────────────────────
# LLMService — OpenAI / Gemini streaming 封裝
# ─────────────────────────────────────────────────────────────────────────────

# OpenAI 與 Gemini 對「非使用者」角色的稱呼不一樣：
#   OpenAI Chat Completions：system / user / assistant
#   Gemini（google.generativeai）start_chat(history=...)：只認 user / model
# orchestrator._build_messages() 統一用 OpenAI 慣例組出 messages，
# 呼叫 Gemini 前要在這裡做角色轉換，避免呼叫端要記兩種慣例。
_GEMINI_ROLE_MAP = {"user": "user", "assistant": "model"}


def _to_gemini_role(role: str) -> str:
    return _GEMINI_ROLE_MAP.get(role, "user")


class LLMService:
    """
    雲端 LLM streaming 封裝。

    重要：system_prompt 請保持逐字節不變（同一個 agent 多輪對話間不要動態插入
    時間戳記等易變內容到 system prompt 開頭），才能吃到 OpenAI/Gemini 的
    伺服器端 prompt 前綴快取，降低首字延遲（TTFT）。
    """

    def __init__(self, provider: Optional[str] = None):
        settings = get_settings()
        self._provider = provider or settings.llm_provider
        self._settings = settings

    async def stream_reply(
        self, agent_id: str, system_prompt: str, messages: list[dict]
    ) -> AsyncIterator[LLMTextChunk]:
        """
        串流生成單一 agent 的回覆。

        messages: OpenAI 風格的 [{"role": "user"/"assistant", "content": "..."}] 列表
                  （不含 system prompt，system_prompt 另外傳入以利前綴快取）。
                  若 provider 是 gemini，會在 _stream_gemini 內部自動把
                  "assistant" 轉成 Gemini 認得的 "model"，呼叫端不需要處理。
        """
        if self._provider == "openai":
            async for chunk in self._stream_openai(agent_id, system_prompt, messages):
                yield chunk
        elif self._provider == "gemini":
            async for chunk in self._stream_gemini(agent_id, system_prompt, messages):
                yield chunk
        else:
            raise ValueError(f"未知的 LLM provider：{self._provider}")

    async def _stream_openai(
        self, agent_id: str, system_prompt: str, messages: list[dict]
    ) -> AsyncIterator[LLMTextChunk]:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=self._settings.openai_api_key)
        stream = await client.chat.completions.create(
            model=self._settings.openai_model,
            messages=[{"role": "system", "content": system_prompt}, *messages],
            stream=True,
        )
        async for event in stream:
            delta = event.choices[0].delta.content or ""
            if delta:
                yield LLMTextChunk(agent_id=agent_id, delta_text=delta)
        yield LLMTextChunk(agent_id=agent_id, delta_text="", is_final=True)

    async def _stream_gemini(
        self, agent_id: str, system_prompt: str, messages: list[dict]
    ) -> AsyncIterator[LLMTextChunk]:
        import google.generativeai as genai

        genai.configure(api_key=self._settings.gemini_api_key)
        model = genai.GenerativeModel(
            self._settings.gemini_model, system_instruction=system_prompt
        )
        # 曾修過的 bug：這裡以前直接用 m["role"]（"user"/"assistant"）組 history，
        # Gemini 只認 "user"/"model"，第二輪對話（history 裡開始出現
        # "assistant" 角色）就會被 Gemini 回 400 Role 'assistant' is not
        # supported. 一定要先轉換角色字串。
        history = [
            {"role": _to_gemini_role(m["role"]), "parts": [m["content"]]}
            for m in messages[:-1]
        ]
        chat = model.start_chat(history=history)
        last_user_msg = messages[-1]["content"] if messages else ""

        response = await chat.send_message_async(last_user_msg, stream=True)
        async for event in response:
            if event.text:
                yield LLMTextChunk(agent_id=agent_id, delta_text=event.text)
        yield LLMTextChunk(agent_id=agent_id, delta_text="", is_final=True)


class MockLLMService(LLMService):
    """
    不呼叫任何雲端 API，依固定腳本或簡單規則吐出 token stream。

    用於單元測試 SentenceAggregator 與多 Agent 編排邏輯，不需要 API key。
    """

    # agents/orchestrator.py 與 agents/debate.py 的 generate_summary() 都固定
    # 用 agent_id="summary" 呼叫 stream_reply()（見兩檔案的說明），這裡用同一個
    # id 判斷要回傳「總結用」的固定腳本，而不是一般對話回覆的 scripted_reply，
    # 讓沒有接真實 LLM 的開發環境也能看到完整的「結束畫面」體驗（有一句看起來
    # 像總結的鼓勵語，而不是每次都吐出跟一般回覆一樣的測試句子）。
    DEFAULT_SUMMARY_REPLY = "願你把今天說出口的每一句話，都當作送給未來自己的一份禮物。"

    # agents/debate.py 的 generate_verdict() 固定用 agent_id="verdict" 呼叫，
    # 期待回傳「內在法庭判決書」JSON（欄位見該檔案的
    # _DEBATE_VERDICT_SYSTEM_PROMPT_TEMPLATE）。這裡回傳一份合法的固定 JSON，
    # 讓沒接真實 LLM 的開發環境也能看到完整的判決書結束畫面。
    DEFAULT_VERDICT_REPLY = (
        '{"case_title": "當事人內心兩種聲音之嚴重內耗案", '
        '"initial_bias": "當事人原先認定這個煩惱只有單一正確答案。", '
        '"viewpoint_a": "甲方主張應以務實步驟立即行動。", '
        '"viewpoint_b": "乙方主張應先照顧感受、接納自己的步調。", '
        '"judge_interventions": ["法官指出兩造皆忽略了實際情境的限制。"], '
        '"final_verdict": "本庭裁定：兩種聲音皆為當事人真實的一部分，行動與接納並行不悖。", '
        '"revised_belief": "我可以一邊接納情緒，一邊採取小步驟的行動。", '
        '"closing_line": "願你帶著今天的判決，溫柔而堅定地繼續前行。"}'
    )

    def __init__(
        self,
        scripted_reply: str = "你好，很高興認識你！這是一段測試回覆。",
        summary_reply: str = DEFAULT_SUMMARY_REPLY,
        verdict_reply: str = DEFAULT_VERDICT_REPLY,
    ):
        self._scripted_reply = scripted_reply
        self._summary_reply = summary_reply
        self._verdict_reply = verdict_reply

    async def stream_reply(
        self, agent_id: str, system_prompt: str, messages: list[dict]
    ) -> AsyncIterator[LLMTextChunk]:
        import asyncio

        if agent_id == "summary":
            reply = self._summary_reply
        elif agent_id == "verdict":
            reply = self._verdict_reply
        else:
            reply = self._scripted_reply
        for ch in reply:
            await asyncio.sleep(0)
            yield LLMTextChunk(agent_id=agent_id, delta_text=ch)
        yield LLMTextChunk(agent_id=agent_id, delta_text="", is_final=True)

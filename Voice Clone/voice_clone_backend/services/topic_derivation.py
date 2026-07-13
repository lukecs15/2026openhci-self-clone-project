"""
services/topic_derivation.py — 從聲音樣本逐字稿推導辯論議題

對應手機 onboarding 流程（見 routers/onboarding.py）：使用者在手機端錄一段
聲音樣本（通常會請他談談最近的煩惱），如果沒有另外輸入/選擇議題，後端就
從這段錄音的 STT 逐字稿（VoiceProfile.reference_text）用 LLM 萃取出一句
議題標題，供 Unity 開庭廣播「今日審理案件：『當事人因 ○○○ 所引發之嚴重
內耗案』」與辯論 seed prompt 使用。

堅固性設計（跟 generate_verdict() 相同精神）：LLM 失敗/逾時/回空字串都
不會擋住 onboarding link 流程，退回預設議題標題。MockLLMService 環境下
scripted_reply 不是議題格式，因此只有「真的接上雲端 LLM」時才嘗試推導，
mock 環境直接用逐字稿截斷或預設標題（讓開發環境行為可預期）。
"""

from __future__ import annotations

import asyncio
import logging

from services.llm_service import LLMService, MockLLMService

logger = logging.getLogger(__name__)

DEFAULT_TOPIC_TITLE = "如何面對最近的內耗與煩惱"

_DERIVE_TIMEOUT_SECONDS = 12.0

_DERIVE_SYSTEM_PROMPT = (
    "使用者錄了一段語音談自己最近的煩惱，以下是逐字稿。請把這個煩惱濃縮成"
    "一句 8~20 字的議題標題（例如「該不該離職去進修」「如何面對朋友的期待」），"
    "用繁體中文，只輸出標題本身，不要引號、不要句號、不要任何前綴或說明。"
    "如果逐字稿內容跟煩惱無關（例如只是隨意朗讀），請輸出「如何面對最近的內耗與煩惱」。"
)


async def derive_topic_title(reference_text: str, llm_service: LLMService) -> str:
    """從逐字稿推導議題標題，任何失敗都回退 DEFAULT_TOPIC_TITLE。"""
    text = (reference_text or "").strip()
    if not text:
        return DEFAULT_TOPIC_TITLE

    if isinstance(llm_service, MockLLMService):
        # mock 環境：不呼叫（假的）LLM，直接用逐字稿前段當標題，讓開發環境
        # 也能看到「議題跟著自己講的內容變化」的效果。
        return text[:20] or DEFAULT_TOPIC_TITLE

    try:
        return await asyncio.wait_for(_derive(text, llm_service), timeout=_DERIVE_TIMEOUT_SECONDS)
    except Exception as exc:  # noqa: BLE001
        logger.warning("議題推導失敗，改用預設議題：%s", exc)
        return DEFAULT_TOPIC_TITLE


async def _derive(text: str, llm_service: LLMService) -> str:
    messages = [{"role": "user", "content": f"逐字稿：\n{text}"}]
    parts: list[str] = []
    async for token in llm_service.stream_reply("topic", _DERIVE_SYSTEM_PROMPT, messages):
        if token.is_final:
            break
        parts.append(token.delta_text)
    title = "".join(parts).strip().strip("「」\"'。 ")
    return title[:30] if title else DEFAULT_TOPIC_TITLE

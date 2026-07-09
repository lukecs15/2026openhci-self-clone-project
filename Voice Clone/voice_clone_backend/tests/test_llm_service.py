"""
test_llm_service.py — 驗證 LLMService._stream_gemini 的角色轉換邏輯

迴歸測試的 bug：orchestrator._build_messages() 一律用 OpenAI 慣例
（"user"/"assistant"）組對話歷史。這對 OpenAI API 沒問題，但 Gemini 的
google.generativeai SDK 在 start_chat(history=...) 只認 "user"/"model"，
塞 "assistant" 進去在第二輪對話（history 裡開始出現 assistant 角色）就會被
Gemini 回 400 Role 'assistant' is not supported. Please use a valid role:
MODEL, USER.

這裡不依賴真正安裝 google-generativeai 套件，而是用假的 fake module 塞進
sys.modules，攔截 start_chat() 實際收到的 history，斷言角色已經被轉換成
Gemini 認得的 "model"（而不是原始的 "assistant"）。
"""

import sys
import types

import pytest

from services.llm_service import LLMService, MockLLMService, _to_gemini_role


def test_to_gemini_role_maps_assistant_to_model():
    assert _to_gemini_role("user") == "user"
    assert _to_gemini_role("assistant") == "model"


def test_to_gemini_role_unknown_role_defaults_to_user():
    assert _to_gemini_role("system") == "user"


@pytest.mark.asyncio
async def test_stream_gemini_translates_assistant_role_in_history(monkeypatch):
    """
    模擬第二輪對話：messages 裡已經有一則 "assistant" 角色的歷史訊息
    （orchestrator._build_messages 的真實輸出格式）。
    斷言傳給 model.start_chat(history=...) 的 history 角色是 "model"，
    不是原始的 "assistant"（不然 Gemini SDK 會直接丟 400）。
    """
    captured_history = {}

    class _FakeResponseEvent:
        def __init__(self, text):
            self.text = text

    class _FakeStreamResponse:
        def __aiter__(self):
            async def _gen():
                yield _FakeResponseEvent("你好")
                yield _FakeResponseEvent("！")
            return _gen()

    class _FakeChatSession:
        def __init__(self, history):
            captured_history["history"] = history

        async def send_message_async(self, message, stream=True):
            captured_history["last_message"] = message
            return _FakeStreamResponse()

    class _FakeGenerativeModel:
        def __init__(self, model_name, system_instruction=None):
            captured_history["model_name"] = model_name
            captured_history["system_instruction"] = system_instruction

        def start_chat(self, history=None):
            return _FakeChatSession(history)

    fake_genai = types.SimpleNamespace(
        configure=lambda api_key: None,
        GenerativeModel=_FakeGenerativeModel,
    )
    monkeypatch.setitem(sys.modules, "google.generativeai", fake_genai)
    monkeypatch.setitem(sys.modules, "google", types.SimpleNamespace(generativeai=fake_genai))

    service = LLMService(provider="gemini")
    service._settings.gemini_api_key = "fake-key"
    service._settings.gemini_model = "gemini-2.0-flash"

    messages = [
        {"role": "user", "content": "小明，你今天過得如何？"},
        {"role": "assistant", "content": "我今天很好，謝謝關心！"},
        {"role": "user", "content": "那你昨天呢？"},
    ]

    chunks = [c async for c in service._stream_gemini("agent-a", "你是小明。", messages)]

    sent_history = captured_history["history"]
    assert sent_history == [
        {"role": "user", "parts": ["小明，你今天過得如何？"]},
        {"role": "model", "parts": ["我今天很好，謝謝關心！"]},
    ]
    assert captured_history["last_message"] == "那你昨天呢？"

    full_text = "".join(c.delta_text for c in chunks if not c.is_final)
    assert full_text == "你好！"
    assert chunks[-1].is_final is True


# ─────────────────────────────────────────────────────────────────────────────
# MockLLMService — agent_id="summary" 應回傳「總結用」腳本而非一般 scripted_reply
# （見 agents/orchestrator.py / agents/debate.py 的 generate_summary()）
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_mock_llm_service_uses_summary_reply_for_summary_agent_id():
    """
    agents/orchestrator.py 與 agents/debate.py 的 generate_summary() 都固定
    用 agent_id="summary" 呼叫 stream_reply()。MockLLMService 應該用這個 id
    判斷要回傳「總結用」的固定腳本，而不是一般對話的 scripted_reply，讓沒接
    真實 LLM 的開發環境也能看到有意義的「結束總結」內容。
    """
    service = MockLLMService(scripted_reply="一般回覆", summary_reply="總結回覆")

    normal_chunks = [c async for c in service.stream_reply("agent-a", "sp", [])]
    normal_text = "".join(c.delta_text for c in normal_chunks if not c.is_final)
    assert normal_text == "一般回覆"

    summary_chunks = [c async for c in service.stream_reply("summary", "sp", [])]
    summary_text = "".join(c.delta_text for c in summary_chunks if not c.is_final)
    assert summary_text == "總結回覆"


@pytest.mark.asyncio
async def test_mock_llm_service_default_summary_reply_is_nonempty():
    service = MockLLMService()

    chunks = [c async for c in service.stream_reply("summary", "sp", [])]
    text = "".join(c.delta_text for c in chunks if not c.is_final)

    assert text  # 有預設的鼓勵語，不是空字串
    assert chunks[-1].is_final is True

"""test_sentence_aggregator.py — 驗證 LLM token stream 逐句斷句邏輯。"""

from services.llm_service import SentenceAggregator


def test_feed_emits_sentence_on_boundary_char():
    agg = SentenceAggregator(agent_id="a1")
    sentences = agg.feed("你好嗎？")
    assert [s.sentence for s in sentences] == ["你好嗎？"]


def test_feed_buffers_until_boundary_across_multiple_calls():
    agg = SentenceAggregator(agent_id="a1")
    assert agg.feed("你") == []
    assert agg.feed("好") == []
    sentences = agg.feed("嗎？")
    assert [s.sentence for s in sentences] == ["你好嗎？"]


def test_feed_emits_multiple_sentences_in_one_call():
    agg = SentenceAggregator(agent_id="a1")
    sentences = agg.feed("早安！今天天氣如何？我們出發吧。")
    assert [s.sentence for s in sentences] == ["早安！", "今天天氣如何？", "我們出發吧。"]


def test_flush_emits_residual_text_as_final_of_turn():
    agg = SentenceAggregator(agent_id="a1")
    agg.feed("這句話沒有標點收尾")
    residual = agg.flush()
    assert len(residual) == 1
    assert residual[0].sentence == "這句話沒有標點收尾"
    assert residual[0].is_final_of_turn is True


def test_flush_with_empty_buffer_returns_empty_list():
    agg = SentenceAggregator(agent_id="a1")
    agg.feed("完整句子。")
    assert agg.flush() == []


def test_custom_boundary_chars():
    agg = SentenceAggregator(agent_id="a1", boundary_chars=".")
    sentences = agg.feed("hello world.")
    assert [s.sentence for s in sentences] == ["hello world."]

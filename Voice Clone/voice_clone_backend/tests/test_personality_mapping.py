"""
test_personality_mapping.py — 驗證 Big Five → 5 位「自我」agent 的生成邏輯。

涵蓋：決定性（同樣輸入永遠得到同樣輸出）、5 個向度都會產生對應 agent、
5 位共用同一個 voice_profile_id、分數落在低/中/高段時 persona_prompt
對應正確、waveform_signature 數值有依分數線性變化且落在合理邊界內、
分數缺漏時用中性值 50 兜底、未知向度會丟例外。
"""

import pytest

from services.personality_mapping import (
    TRAIT_ORDER,
    TRAIT_PROFILES,
    build_self_agent,
    build_self_agents,
)


def test_build_self_agents_returns_five_agents_in_trait_order():
    scores = {trait: 50.0 for trait in TRAIT_ORDER}
    agents = build_self_agents(scores, voice_profile_id="profile-123")

    assert [a.agent_id for a in agents] == [f"self-{t}" for t in TRAIT_ORDER]


def test_build_self_agents_all_share_same_voice_profile_id():
    scores = {trait: 80.0 for trait in TRAIT_ORDER}
    agents = build_self_agents(scores, voice_profile_id="shared-profile")

    assert all(a.voice_profile_id == "shared-profile" for a in agents)


def test_build_self_agents_missing_trait_defaults_to_neutral_50():
    agents_with_all = build_self_agents({t: 50.0 for t in TRAIT_ORDER}, "p")
    agents_missing = build_self_agents({}, "p")

    for a, b in zip(agents_with_all, agents_missing):
        assert a.persona_prompt == b.persona_prompt
        assert a.waveform_signature == b.waveform_signature


def test_build_self_agent_unknown_trait_raises():
    with pytest.raises(ValueError):
        build_self_agent("not-a-real-trait", 50.0, "p")


def test_build_self_agent_is_deterministic():
    a1 = build_self_agent("openness", 72.0, "profile-x")
    a2 = build_self_agent("openness", 72.0, "profile-x")
    assert a1.model_dump() == a2.model_dump()


@pytest.mark.parametrize("trait", TRAIT_ORDER)
def test_low_score_uses_low_persona_text(trait):
    agent = build_self_agent(trait, 0.0, "p")
    assert agent.persona_prompt == TRAIT_PROFILES[trait].low_persona


@pytest.mark.parametrize("trait", TRAIT_ORDER)
def test_high_score_uses_high_persona_text(trait):
    agent = build_self_agent(trait, 100.0, "p")
    assert agent.persona_prompt == TRAIT_PROFILES[trait].high_persona


@pytest.mark.parametrize("trait", TRAIT_ORDER)
def test_mid_score_uses_mid_persona_text(trait):
    agent = build_self_agent(trait, 50.0, "p")
    assert agent.persona_prompt == TRAIT_PROFILES[trait].mid_persona


@pytest.mark.parametrize("trait", TRAIT_ORDER)
def test_waveform_signature_hue_is_fixed_per_trait_regardless_of_score(trait):
    low = build_self_agent(trait, 0.0, "p")
    high = build_self_agent(trait, 100.0, "p")
    assert low.waveform_signature["hue"] == TRAIT_PROFILES[trait].hue
    assert high.waveform_signature["hue"] == TRAIT_PROFILES[trait].hue


@pytest.mark.parametrize("trait", TRAIT_ORDER)
def test_waveform_signature_params_within_frontend_bounds(trait):
    for score in (0.0, 25.0, 50.0, 75.0, 100.0):
        agent = build_self_agent(trait, score, "p")
        sig = agent.waveform_signature
        assert 0.4 <= sig["frequency"] <= 3.0
        assert 0.1 <= sig["amplitude"] <= 0.6
        assert 0.4 <= sig["waveHeight"] <= 1.0
        assert 0.0 <= sig["waveformShape"] <= 1.0
        assert 0.2 <= sig["colorIntensity"] <= 1.0


def test_score_out_of_range_is_clamped_not_raising():
    too_low = build_self_agent("openness", -50.0, "p")
    too_high = build_self_agent("openness", 500.0, "p")
    assert too_low.persona_prompt == TRAIT_PROFILES["openness"].low_persona
    assert too_high.persona_prompt == TRAIT_PROFILES["openness"].high_persona


def test_waveform_signature_moves_between_low_and_high_params():
    """分數變化應該讓至少一個波形參數跟著單調變化（不是寫死常數）。"""
    low = build_self_agent("extraversion", 0.0, "p").waveform_signature
    high = build_self_agent("extraversion", 100.0, "p").waveform_signature
    assert low["frequency"] != high["frequency"]
    assert low["amplitude"] != high["amplitude"]

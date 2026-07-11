"""
services/personality_mapping.py — Big Five 五大人格 → 5 位「自我」Agent

需求（見 mobile onboarding 流程規劃）：使用者在手機端填寫 Big Five（五大人格）
問卷，系統依五個向度（開放性 / 盡責性 / 外向性 / 親和性 / 負面情緒）各
建立一位「自我」agent，5 位共用使用者剛剛上傳、克隆好的同一份聲音（同一個
voice_profile_id），讓使用者選其中 2 位進入辯論模式，達到「自我對話／自我
省思」的體驗（而不是像既有 DEFAULT_DEMO_AGENTS 那樣 3 位固定人設）。

── 分數輸入格式 ──────────────────────────────────────────────────────────
每個向度接受 0~100 的分數（50 為中性）。問卷題目本身（幾題、Likert 幾點量表）
由手機前端決定並自行換算成這個 0~100 範圍，本模組刻意不綁定特定題庫，只依賴
換算後的五個分數，方便之後題目定案/調整時不需要改動這裡的邏輯。

── persona_prompt 與 waveform_signature 怎麼算 ──────────────────────────
每個向度有一組 TraitProfile：
    - low_persona / high_persona：分數落在低/高兩端時的人格語氣描述文字，
      分數會決定要取用低端、中性、還是高端的描述（見 _persona_band()）。
    - hue：固定色相，代表「這是哪一個自我」（跟既有 WAVEFORM_PRESETS 的
      設計精神一致：顏色代表這個角色一直以來的特質，不隨分數改變）。
    - low_params / high_params：分數 0 對應 low_params，分數 100 對應
      high_params，中間用線性插值（frequency / amplitude / waveHeight /
      waveformShape 四個參數），呼應前端 utils/waveformSignature.js 檔案
      開頭的心理意義表格：
          頻率   → 思緒速度、焦慮程度、反覆出現的念頭
          振幅   → 情緒強度
          波高   → 該角色在當下的主導程度
          波形   → 說話方式、人格風格、反應模式
      colorIntensity 沿用前端一致的基準值（BASE_COLOR_INTENSITY），不當作
      人格分數的維度（跟前端設計一致：這個維度是情緒驅動，不是角色特質）。

輸出的 AgentConfig 直接可以送進既有的 WebSocket init_session / 辯論模式
init_debate_session（跟 DEFAULT_DEMO_AGENTS 是同一種資料結構），前端完全
不需要改：waveform_signature 欄位已經是 AgentConfig 的一部分（見
models/schemas.py），getWaveformSignature() 會自動優先採用。
"""

from __future__ import annotations

from dataclasses import dataclass

from models.schemas import AgentConfig

# 前端 utils/waveformSignature.js 的 BOUNDS，這裡沿用同一組邊界避免算出
# 前端會再次 clamp 但語意上不合理的極端值。
_BOUNDS = {
    "frequency": (0.4, 3.0),
    "amplitude": (0.1, 0.6),
    "waveHeight": (0.4, 1.0),
    "waveformShape": (0.0, 1.0),
    "colorIntensity": (0.2, 1.0),
}

# 跟前端 BASE_COLOR_INTENSITY 一致：colorIntensity 的角色特質不隨人格分數
# 變化，只有對話中的情緒訊號（前端 emotionSignal.js）才會讓它偏離這個基準。
_BASE_COLOR_INTENSITY = 0.55

BigFiveTrait = str  # "openness" | "conscientiousness" | "extraversion" | "agreeableness" | "neuroticism"

TRAIT_ORDER: list[BigFiveTrait] = [
    "openness",
    "conscientiousness",
    "extraversion",
    "agreeableness",
    "neuroticism",
]


@dataclass(frozen=True)
class _WaveParams:
    frequency: float
    amplitude: float
    waveHeight: float  # noqa: N815 — 對齊前端欄位命名，方便直接序列化
    waveformShape: float  # noqa: N815


@dataclass(frozen=True)
class TraitProfile:
    trait: BigFiveTrait
    display_name: str
    role_tag: str
    hue: int
    low_persona: str
    mid_persona: str
    high_persona: str
    low_params: _WaveParams
    high_params: _WaveParams


# 五個向度的完整設定。persona 文字刻意用「你是使用者內心其中一個面向」的
# 第二人稱寫法，跟既有 DEFAULT_DEMO_AGENTS 的 persona_prompt 語氣一致，
# 讓 LLM 能自然地代入「這是使用者自己人格的一部分」的角色設定。
TRAIT_PROFILES: dict[BigFiveTrait, TraitProfile] = {
    "openness": TraitProfile(
        trait="openness",
        display_name="開放的自我",
        role_tag="開放性",
        hue=270,  # 好奇、想像的紫
        low_persona="你是使用者內心務實保守的一面，偏好熟悉、可預期的做法，對新奇的想法會先謹慎評估風險，說話條理清楚、不愛天馬行空。",
        mid_persona="你是使用者內心對新事物抱持適度好奇的一面，願意嘗試但也重視實際可行性，會在創意與務實之間拿捏平衡。",
        high_persona="你是使用者內心好奇、富想像力的一面，喜歡探索新想法、新觀點，說話常帶比喻與聯想，樂於挑戰既有框架。",
        low_params=_WaveParams(frequency=0.9, amplitude=0.2, waveHeight=0.55, waveformShape=0.15),
        high_params=_WaveParams(frequency=1.7, amplitude=0.34, waveHeight=0.75, waveformShape=0.85),
    ),
    "conscientiousness": TraitProfile(
        trait="conscientiousness",
        display_name="盡責的自我",
        role_tag="盡責性",
        hue=205,  # 沉穩可靠的藍
        low_persona="你是使用者內心隨性、彈性大的一面，不喜歡被計畫綁住，容易被當下的心情牽著走，說話比較隨興、跳躍。",
        mid_persona="你是使用者內心在計畫與彈性之間拿捏的一面，會訂目標但也接受計畫需要調整，語氣平穩務實。",
        high_persona="你是使用者內心自律、有條理的一面，重視計畫與承諾，做事按部就班、說話有條理、注重細節與後果。",
        low_params=_WaveParams(frequency=1.4, amplitude=0.3, waveHeight=0.6, waveformShape=0.55),
        high_params=_WaveParams(frequency=0.7, amplitude=0.22, waveHeight=0.95, waveformShape=0.1),
    ),
    "extraversion": TraitProfile(
        trait="extraversion",
        display_name="外向的自我",
        role_tag="外向性",
        hue=24,  # 活力橘紅
        low_persona="你是使用者內心安靜、內斂的一面，比起熱鬧場合更喜歡獨處與深思，說話低調、簡潔、不搶話。",
        mid_persona="你是使用者內心社交與獨處並重的一面，能享受人群互動，也需要獨處充電，語氣自然平衡。",
        high_persona="你是使用者內心外向、充滿活力的一面，喜歡表達、主動帶動氣氛，說話熱情、direct、常常先開口。",
        low_params=_WaveParams(frequency=0.6, amplitude=0.18, waveHeight=0.5, waveformShape=0.1),
        high_params=_WaveParams(frequency=2.1, amplitude=0.42, waveHeight=0.9, waveformShape=0.55),
    ),
    "agreeableness": TraitProfile(
        trait="agreeableness",
        display_name="親和的自我",
        role_tag="親和性",
        hue=150,  # 和諧包容的綠
        low_persona="你是使用者內心比較直接、重視自己立場的一面，會坦白說出不同意見，不會為了和諧而委屈自己，語氣直率。",
        mid_persona="你是使用者內心在體諒他人與堅持自己之間拿捏的一面，會先理解對方感受，但也適時表達自己的想法。",
        high_persona="你是使用者內心溫暖、體貼、重視和諧的一面，習慣先同理對方感受、樂於配合與付出，說話溫和、鼓勵。",
        low_params=_WaveParams(frequency=1.5, amplitude=0.4, waveHeight=0.85, waveformShape=0.5),
        high_params=_WaveParams(frequency=1.0, amplitude=0.26, waveHeight=0.65, waveformShape=0.25),
    ),
    "neuroticism": TraitProfile(
        trait="neuroticism",
        display_name="負面情緒的自我",
        role_tag="負面情緒",
        hue=330,  # 波動、警覺的洋紅
        low_persona="你是使用者內心情緒穩定、沉著的一面，遇到壓力時能保持冷靜，說話語氣平緩、不容易被外界影響。",
        mid_persona="你是使用者內心對情緒有一定敏感度的一面，會留意自己與他人的感受起伏，但通常能自我調節，語氣帶著留意與省思。",
        high_persona="你是使用者內心容易感受到焦慮、擔憂的一面，對壓力與變化很敏感，常反覆思考、容易放大負面的可能性，說話帶著猶豫與不安。",
        low_params=_WaveParams(frequency=0.65, amplitude=0.2, waveHeight=0.55, waveformShape=0.15),
        high_params=_WaveParams(frequency=2.6, amplitude=0.5, waveHeight=0.7, waveformShape=0.8),
    ),
}


def _clamp(value: float, bounds: tuple[float, float]) -> float:
    lo, hi = bounds
    return min(hi, max(lo, value))


def _normalize_score(score: float) -> float:
    """0~100 分數轉成 0~1，超出範圍會被夾住（防呆，不因外部輸入炸掉）。"""
    return _clamp(score, (0.0, 100.0)) / 100.0


def _lerp_params(low: _WaveParams, high: _WaveParams, t: float) -> dict:
    def lerp(key: str) -> float:
        lo_v = getattr(low, key)
        hi_v = getattr(high, key)
        return _clamp(lo_v + (hi_v - lo_v) * t, _BOUNDS[key])

    return {
        "frequency": lerp("frequency"),
        "amplitude": lerp("amplitude"),
        "waveHeight": lerp("waveHeight"),
        "waveformShape": lerp("waveformShape"),
    }


def _persona_band(profile: TraitProfile, t: float) -> str:
    """t（0~1）落在低/中/高哪一段，決定要用哪一段 persona 文字。

    切點刻意不對稱地落在 1/3、2/3（0.34、0.66），讓中性分數（0.5 附近，
    也就是問卷沒填滿或剛好中庸的使用者）落在「中段」描述，避免分數稍微
    偏一點就整個變成極端人格。
    """
    if t < 0.34:
        return profile.low_persona
    if t > 0.66:
        return profile.high_persona
    return profile.mid_persona


def build_self_agent(trait: BigFiveTrait, score: float, voice_profile_id: str) -> AgentConfig:
    """依單一向度分數 + 聲音克隆 profile 建立一位「自我」agent。"""
    profile = TRAIT_PROFILES.get(trait)
    if profile is None:
        raise ValueError(f"未知的 Big Five 向度：{trait}")

    t = _normalize_score(score)
    params = _lerp_params(profile.low_params, profile.high_params, t)
    persona_prompt = _persona_band(profile, t)

    waveform_signature = {
        **params,
        "hue": profile.hue,
        "colorIntensity": _BASE_COLOR_INTENSITY,
        "presetName": profile.display_name,
    }

    return AgentConfig(
        agent_id=f"self-{trait}",
        display_name=profile.display_name,
        persona_prompt=persona_prompt,
        voice_profile_id=voice_profile_id,
        role_tag=profile.role_tag,
        waveform_signature=waveform_signature,
    )


def build_self_agents(scores: dict[BigFiveTrait, float], voice_profile_id: str) -> list[AgentConfig]:
    """
    依五個向度的分數建立 5 位「自我」agent，固定用 TRAIT_ORDER 的順序回傳
    （對應手機問卷、辯論選人畫面的一致排序）。

    缺漏的向度（例如問卷題目之後調整、某個向度暫時沒有分數）會用 50（中性）
    當預設值，不會讓整個生成流程失敗——這樣即使問卷題庫還在調整，
    這個函式的輸出介面也不需要跟著改。
    """
    return [
        build_self_agent(trait, scores.get(trait, 50.0), voice_profile_id)
        for trait in TRAIT_ORDER
    ]

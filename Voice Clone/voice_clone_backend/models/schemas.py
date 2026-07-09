"""
models/schemas.py — Voice Clone 多 Agent 對話系統資料結構

涵蓋：
    - AgentConfig：單一 Agent（角色）的設定（聲音克隆 profile、人格 prompt）
    - VoiceProfile：使用者上傳音訊後建立的聲音克隆 profile
    - STTResult：語音辨識結果（含使用的引擎，方便觀測 primary/fallback 切換情形）
    - LLMTextChunk / SentenceChunk：LLM 串流 token 與斷句後的句子
    - TTSAudioChunk：TTS 串流合成的音訊片段
    - RoutingDecision：多 Agent 發話順序決策（handoff 或 job_group）
    - WebSocket 訊息 envelope：ClientMessage / ServerMessage
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field


# ─────────────────────────────────────────────────────────────────────────────
# Agent 設定
# ─────────────────────────────────────────────────────────────────────────────

class AgentConfig(BaseModel):
    """單一 Agent（對話角色）的設定。"""

    agent_id: str = Field(..., description="Agent 唯一識別碼")
    display_name: str = Field(..., description="顯示名稱")
    persona_prompt: str = Field(..., description="人格 / 說話風格 system prompt 片段")
    voice_profile_id: str = Field("", description="對應的克隆語音 profile ID（CosyVoice 2）")
    # 用於 Job Group 情境下標示此 agent 的角色定位（例如 "支持方" / "反對方" / "主持人"）
    role_tag: str = Field("", description="辯論 / 討論情境下的角色標籤")
    # 波形頭像的「人格簽章」覆寫欄位。結構對照前端 utils/waveformSignature.js
    # 的 getWaveformSignature() 回傳值：
    #   { frequency, amplitude, waveHeight, waveformShape, hue, colorIntensity }
    # 前端已經預留這個接線點（同檔案「接線點：之後問卷流程」段落）：agent 物件
    # 一旦帶有這個欄位，getWaveformSignature() 會直接優先採用、完全略過原本
    # 依 agent_id 雜湊挑 preset 的邏輯，呼叫端（WaveformAvatar / AgentStage）
    # 不需要跟著改。這裡新增欄位是為了讓後端 Big Five 問卷生成的 5 位「自我」
    # agent（見 services/personality_mapping.py）可以把分數換算出的真實波形
    # 參數直接帶給前端使用，不再是隨機 preset。留空（None）時前端會照舊使用
    # 原本的 agent_id 雜湊 preset 邏輯，向後相容既有的 3 位 demo agent。
    waveform_signature: Optional[dict] = Field(
        None,
        description=(
            "波形頭像覆寫參數（frequency/amplitude/waveHeight/waveformShape/"
            "hue/colorIntensity），留空則前端使用預設 preset 邏輯"
        ),
    )


# ─────────────────────────────────────────────────────────────────────────────
# 使用者聲音克隆 Profile
# ─────────────────────────────────────────────────────────────────────────────

class VoiceProfile(BaseModel):
    """
    使用者上傳一段錄音後建立的聲音克隆 profile。

    reference_text 是 CosyVoice 2 zero-shot 克隆需要的「參考音訊逐字稿」
    （inference_zero_shot 的 prompt_text 參數，必須跟 reference_audio_path
    講的內容一致）。使用者通常不會自己打逐字稿，所以預設由後端呼叫既有的
    STTService 自動轉錄產生，使用者也可以在建立時手動覆寫。
    """

    profile_id: str = Field(..., description="Profile 唯一識別碼")
    label: str = Field("", description="顯示用名稱，例如「我的聲音」")
    reference_audio_path: str = Field(..., description="參考音訊檔案的絕對路徑")
    reference_text: str = Field("", description="參考音訊的逐字稿（zero-shot 克隆必需）")
    created_at: str = Field("", description="建立時間（ISO 8601）")


# ─────────────────────────────────────────────────────────────────────────────
# Mobile Onboarding：Big Five 問卷 + 聲音克隆 → 主系統體驗 → 結果傳回手機
# ─────────────────────────────────────────────────────────────────────────────
#
# 對應手機端流程：
#   1. 使用者在手機獨立填 Big Five 問卷 + 錄一段聲音樣本
#   2. 掃描主系統顯示的 QR（帶 session_id）→ POST /link，後端建立聲音克隆
#      profile + 依五個向度生成 5 位「自我」agent（見 services/personality_mapping.py）
#   3. 主系統輪詢／查詢到已連結，載入這 5 位 agent 讓使用者選 2 位進辯論模式
#      （沿用既有辯論模式的所有邏輯，不需要改）
#   4. 辯論結束，主系統把總結句子 + 融合波形 POST /result 寫回
#   5. 主系統顯示第二個 QR，手機掃描 GET /result 取得紀念畫面資料
#
# 「理想上主系統應該只會有一個對話一個裝置進行」：session_id 直接沿用主系統
# 既有 WebSocket 對話的 session_id（前端本來就會自己產生 uuid），onboarding
# 這裡不另外發一組 id，QR 內容就是「手機連結頁網址 + 這個 session_id」。


class BigFiveScores(BaseModel):
    """
    Big Five 五大人格量表的彙整分數，每個向度 0~100（50 為中性）。

    刻意不接收「原始題目作答」（例如第幾題選了幾分），只接收手機前端換算好
    的五個彙整分數——題目本身（幾題、幾點量表、實際文案）之後可能會調整，
    這樣調整題目不需要跟著改後端／這個 schema。
    """

    openness: float = Field(50.0, ge=0, le=100, description="開放性")
    conscientiousness: float = Field(50.0, ge=0, le=100, description="盡責性")
    extraversion: float = Field(50.0, ge=0, le=100, description="外向性")
    agreeableness: float = Field(50.0, ge=0, le=100, description="親和性")
    neuroticism: float = Field(50.0, ge=0, le=100, description="負面情緒")


class OnboardingResult(BaseModel):
    """體驗結束後要傳回手機的「紀念品」內容。"""

    summary_text: str = Field("", description="LLM 生成的結束總結句子")
    waveform_signature: Optional[dict] = Field(
        None, description="融合波形（mergeWaveformSignatures() 的結果，供手機端渲染紀念畫面）"
    )
    participant_agents: list[dict] = Field(
        default_factory=list,
        description="有參與這場對話/辯論的 agent 簡要資訊（agent_id/display_name/role_tag），供手機端顯示",
    )


class OnboardingSession(BaseModel):
    """一場「手機問卷 → 主系統體驗 → 結果回傳手機」的完整生命週期紀錄。"""

    session_id: str = Field(..., description="與主系統 WebSocket 對話共用的 session_id")
    status: Literal["linked", "completed"] = Field(
        "linked", description="linked：問卷+聲音已上傳，5 位 agent 已生成；completed：體驗結束，結果已寫回"
    )
    big_five_scores: BigFiveScores
    voice_profile_id: str = Field("", description="這場對話使用的聲音克隆 profile id")
    agents: list[AgentConfig] = Field(default_factory=list, description="依 Big Five 分數生成的 5 位自我 agent")
    result: Optional[OnboardingResult] = Field(None, description="體驗結束後回寫的總結與融合波形")
    linked_at: str = Field("", description="問卷/聲音上傳完成時間（ISO 8601）")
    completed_at: str = Field("", description="體驗結束、結果回寫時間（ISO 8601）")


# ─────────────────────────────────────────────────────────────────────────────
# STT
# ─────────────────────────────────────────────────────────────────────────────

class STTEngineUsed(str, Enum):
    BREEZE = "breeze"
    FASTER_WHISPER = "faster_whisper"
    MOCK = "mock"


@dataclass
class STTResult:
    """
    語音辨識結果。

    Attributes:
        text: 辨識出的文字。
        engine_used: 實際使用的引擎（用來觀測 primary 是否 fallback）。
        used_fallback: True 代表 primary 引擎失敗/逾時，改用 fallback。
        latency_ms: 辨識耗時（毫秒）。
        language: 偵測到的語言代碼。
    """

    text: str
    engine_used: STTEngineUsed
    used_fallback: bool = False
    latency_ms: float = 0.0
    language: str = "zh"


# ─────────────────────────────────────────────────────────────────────────────
# LLM 串流 / 斷句
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class LLMTextChunk:
    """LLM 串流輸出的單一 token / 文字片段。"""

    agent_id: str
    delta_text: str
    is_final: bool = False


@dataclass
class SentenceChunk:
    """SentenceAggregator 判斷出的完整句子（斷句後才轉發給 TTS）。"""

    agent_id: str
    sentence: str
    is_final_of_turn: bool = False


# ─────────────────────────────────────────────────────────────────────────────
# TTS
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class TTSAudioChunk:
    """TTS 串流合成的音訊片段。"""

    agent_id: str
    audio_bytes: bytes
    sample_rate: int = 24000
    is_final: bool = False
    # 首包延遲（毫秒），只在該句第一個 chunk 填入，方便前端 / 觀測工具記錄 TTFB
    ttfb_ms: Optional[float] = None


# ─────────────────────────────────────────────────────────────────────────────
# 多 Agent 發話順序決策
# ─────────────────────────────────────────────────────────────────────────────

class RoutingMode(str, Enum):
    HANDOFF = "handoff"        # 序列式：LLM 決定把控制權交給哪個 agent
    JOB_GROUP = "job_group"    # 平行式：多個 agent 同時處理，再收集結果彙整


@dataclass
class RoutingDecision:
    """
    多 Agent 編排器對「接下來誰該發話」的決策。

    Attributes:
        mode: handoff（序列交接）或 job_group（平行分派多個 agent）。
        target_agent_ids: 本輪要發話 / 處理的 agent id 列表。
            - handoff 模式：依序（非平行）逐一呼叫，長度可以是 1 個（使用者
              明確指名單一 agent、或 llm_decision 判斷只有一位該回應）、
              也可以是多個（沒有指名時 heuristic 預設全體依序回應；或
              llm_decision 判斷這句話同時指名/該由好幾位一起回應，見
              agents/handoff.py「llm_decision 支援同時指名多位」說明），
              不是固定為 1（曾經的說明過度簡化，heuristic 的「全體依序
              回應」分支其實一直都會回傳多個 id，這裡修正成跟實際行為
              一致）。
            - job_group 模式：平行處理，可為 2 個以上（辯論、腦力激盪等情境）。
        reason: 決策理由（供除錯 / log 使用）。
    """

    mode: RoutingMode
    target_agent_ids: list[str] = field(default_factory=list)
    reason: str = ""


# ─────────────────────────────────────────────────────────────────────────────
# WebSocket 訊息協定（前端 ↔ 後端）
# ─────────────────────────────────────────────────────────────────────────────
#
# Client → Server：
#   { "type": "init_session", "agents": [AgentConfig, ...],
#     "routing_strategy": "llm_decision" | "heuristic" }
#   { "type": "user_audio", "audio": "<base64 PCM/WAV>" }
#   { "type": "user_text", "text": "..." }
#   { "type": "end_session" }
#
# Server → Client：
#   { "type": "session_ready", "agents": [...] }
#   { "type": "user_transcript", "text": "...", "engine_used": "...", "used_fallback": bool }
#   { "type": "agent_speaking_start", "agent_id": "..." }
#   { "type": "agent_speaking_chunk", "agent_id": "...", "text": "...", "audio": "<base64>" }
#   { "type": "agent_speaking_end", "agent_id": "..." }
#   { "type": "routing_decision", "mode": "handoff" | "job_group", "agent_ids": [...] }
#   { "type": "session_summary", "text": "..." }  # end_session 收到後，關閉連線前送出的總結紀念語
#   { "type": "error", "message": "..." }

ClientMessageType = Literal["init_session", "user_audio", "user_text", "end_session"]
ServerMessageType = Literal[
    "session_ready",
    "user_transcript",
    "agent_speaking_start",
    "agent_speaking_chunk",
    "agent_speaking_end",
    "routing_decision",
    "session_summary",
    "error",
]


class ClientMessage(BaseModel):
    """前端送往後端的 WebSocket 訊息 envelope。"""

    type: ClientMessageType
    agents: Optional[list[AgentConfig]] = None
    routing_strategy: Optional[Literal["llm_decision", "heuristic"]] = None
    audio: Optional[str] = None  # base64
    text: Optional[str] = None


class ServerMessage(BaseModel):
    """後端送往前端的 WebSocket 訊息 envelope。"""

    type: ServerMessageType
    agents: Optional[list[AgentConfig]] = None
    text: Optional[str] = None
    engine_used: Optional[str] = None
    used_fallback: Optional[bool] = None
    agent_id: Optional[str] = None
    audio: Optional[str] = None  # base64
    mode: Optional[str] = None
    agent_ids: Optional[list[str]] = None
    message: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# 辯論模式 WebSocket 訊息協定（agents/debate.py + routers/ws_debate.py）
#
# 獨立於上面「一般多 Agent 對話」協定，走不同的 WebSocket 端點
# （/ws/voice-debate/{session_id}），因為互動模式差異較大（固定兩位 agent
# 圍繞單一主題輪流發言、需要支援「暫停＝中斷生成」與「插話」），刻意不共用
# ClientMessage / ServerMessage，避免兩種協定的欄位混在一起難以維護。
# ─────────────────────────────────────────────────────────────────────────────
#
# Client → Server：
#   { "type": "init_debate_session", "topic_id": "failure" | "boundaries" | "procrastination",
#     "agents": [AgentConfig, AgentConfig] }   # 恰好 2 位，第一位先開口
#   { "type": "pause_debate" }                 # 立刻中斷目前正在生成/播放的那句話
#   { "type": "user_intervene", "text": "..." }  # 插話（通常在 pause_debate 之後送出）
#   { "type": "turn_played", "agent_id": "..." }  # 前端回報這一輪的音訊/朗讀真的播完了
#   { "type": "end_session" }
#
# Server → Client：
#   { "type": "debate_ready", "agents": [...], "topic_id": "...", "topic_title": "..." }
#   { "type": "agent_speaking_start", "agent_id": "..." }
#   { "type": "agent_speaking_chunk", "agent_id": "...", "text": "...", "audio": "<base64>" }
#   { "type": "agent_speaking_end", "agent_id": "..." }
#   { "type": "debate_paused", "agent_id": "..." }   # 暫停成功，該 agent 的生成已中斷
#   { "type": "user_intervene_ack", "text": "..." }  # 插話已記錄，即將由暫停的 agent 接續回應
#   { "type": "debate_finished" }                    # 達到 debate_max_turns 上限，自然結束
#   { "type": "session_summary", "text": "..." }      # end_session 收到後，關閉連線前送出的總結紀念語
#   { "type": "error", "message": "..." }
#
# turn_played 是修過的真實回報問題：插話後接續回應的不是被打斷的那位 agent，
# 見 routers/ws_debate.py 檔案開頭「等待前端回報播放完成」的說明。

DebateClientMessageType = Literal[
    "init_debate_session", "pause_debate", "user_intervene", "turn_played", "end_session"
]
DebateServerMessageType = Literal[
    "debate_ready",
    "agent_speaking_start",
    "agent_speaking_chunk",
    "agent_speaking_end",
    "debate_paused",
    "user_intervene_ack",
    "debate_finished",
    "session_summary",
    "error",
]


class DebateClientMessage(BaseModel):
    """前端送往後端的辯論模式 WebSocket 訊息 envelope。"""

    type: DebateClientMessageType
    topic_id: Optional[str] = None
    agents: Optional[list[AgentConfig]] = None
    text: Optional[str] = None
    # 只有 turn_played 會帶：前端回報「這一輪播放完成」的 agent_id，純粹供
    # 後端 log/除錯用，等待機制本身只需要「有沒有收到訊號」，不需要比對值。
    agent_id: Optional[str] = None


class DebateServerMessage(BaseModel):
    """
    後端送往前端的辯論模式 WebSocket 訊息 envelope。

    routers/ws_debate.py 實際送出時直接送 dict（跟 ws_voice_agents.py 的
    ServerMessage 一樣只當作文件用的型別參考，不強制每個事件都經過這裡
    做一次序列化），欄位命名保持跟 ServerMessage 一致，方便前端共用同一套
    事件處理邏輯（agent_speaking_start/chunk/end 兩種模式完全同名同義）。
    """

    type: DebateServerMessageType
    agents: Optional[list[AgentConfig]] = None
    topic_id: Optional[str] = None
    topic_title: Optional[str] = None
    agent_id: Optional[str] = None
    text: Optional[str] = None
    audio: Optional[str] = None  # base64
    message: Optional[str] = None

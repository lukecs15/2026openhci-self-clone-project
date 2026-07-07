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
        mode: handoff（序列交接單一 agent）或 job_group（平行分派多個 agent）。
        target_agent_ids: 本輪要發話 / 處理的 agent id 列表。
            - handoff 模式下長度固定為 1。
            - job_group 模式下可為 2 個以上（辯論、腦力激盪等情境）。
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
#   { "type": "error", "message": "..." }

ClientMessageType = Literal["init_session", "user_audio", "user_text", "end_session"]
ServerMessageType = Literal[
    "session_ready",
    "user_transcript",
    "agent_speaking_start",
    "agent_speaking_chunk",
    "agent_speaking_end",
    "routing_decision",
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

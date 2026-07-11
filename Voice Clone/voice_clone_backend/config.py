"""
config.py — 環境變數與硬體設定檔（Voice Clone 多 Agent 對話模組）

本模組刻意支援「兩套硬體設定檔」，因為開發機與正式機的 VRAM 差距很大：

    DEVICE_PROFILE=dev   → 開發機：GTX 1660 Ti（6GB GDDR6）
                            - STT 僅用 faster-whisper（small/medium），Breeze ASR 停用或用最小 tiny 版驗證流程
                            - TTS 使用 MockTTSService（不載入 CosyVoice 2，只做管線/協定驗證）
                            - LLM 走雲端 API，不受硬體限制
    DEVICE_PROFILE=prod  → 正式機：RTX 5090（32GB GDDR7）
                            - STT：Breeze ASR 25/26 為主，faster-whisper large-v3 為備援
                            - TTS：CosyVoice 2（本地常駐 WebSocket 服務）
                            - 可同時載入 STT + TTS，不需分時卸載

切換方式：在 .env 設定 DEVICE_PROFILE=dev 或 prod，其餘欄位皆有依 profile 調整的預設值，
也可個別覆寫（例如 dev 環境想強制測試 Breeze ASR，設定 STT_PRIMARY_ENGINE=breeze 即可）。

STT / LLM / TTS 三者的 mock 與否現在各自獨立判斷（修過的耦合問題）：
    - STT：一律使用 services.stt_service 的雙引擎邏輯（不受這裡影響）。
    - LLM：只要 pipeline/conversation_pipeline.py 偵測到目前 llm_provider
      對應的 API key 有填，就會自動使用真正的雲端 LLM；沒填就自動 fallback
      到 MockLLMService。也可以用 force_mock_llm=true 強制一律使用 mock
      （例如寫測試、或暫時不想耗用 API 額度）。
    - TTS：由 tts_engine 決定（dev 預設 mock，prod 預設 cosyvoice2）。
    這三者互不影響，不會再出現「TTS 設 mock 就連 LLM 也被迫變成 mock」的情況。

使用方式：
    from config import get_settings
    settings = get_settings()
    if settings.is_prod_profile:
        ...
"""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings
from pydantic import Field

# .env 位於 voice_clone_backend/ 目錄下
_ENV_FILE = Path(__file__).parent / ".env"

DeviceProfile = Literal["dev", "prod"]
STTEngine = Literal["breeze", "faster_whisper", "mock"]
LLMProvider = Literal["openai", "gemini"]


class Settings(BaseSettings):
    """應用程式設定，從環境變數 / .env 讀取。"""

    # ── 硬體設定檔 ────────────────────────────────────────────────
    device_profile: DeviceProfile = "dev"

    torch_device: str = "cuda"
    torch_dtype: str = "float16"

    # ── STT 雙引擎設定 ────────────────────────────────────────────
    stt_primary_engine: STTEngine = "faster_whisper"
    stt_fallback_engine: STTEngine = "faster_whisper"

    breeze_asr_model: str = "MediaTek-Research/Breeze-ASR-25"
    breeze_asr_enabled: bool = False

    whisper_model: str = "small"
    whisper_compute_type: str = "float16"

    stt_primary_timeout_ms: int = 1500
    # 備援引擎逾時設定（毫秒）：備援也要有逾時保護，避免模型權重首次下載/
    # 載入卡住時整個請求無限期 hang 住（例如上傳聲音樣本後「處理中」永遠不結束）。
    stt_fallback_timeout_ms: int = 8000

    # ── LLM 設定（雲端 API，不受本地硬體限制）─────────────────────
    llm_provider: LLMProvider = "gemini"
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.0-flash"
    llm_stream: bool = True
    # 強制 LLM 一律使用 MockLLMService，即使已經填了 API key（預設 False：
    # 有填 key 就自動用真正的雲端 LLM，跟 TTS_ENGINE 是否為 mock 無關）。
    force_mock_llm: bool = False

    sentence_boundary_chars: str = "。！？!?\n"

    # ── TTS 設定：CosyVoice 2 ─────────────────────────────────────
    tts_engine: Literal["cosyvoice2", "mock"] = "mock"
    cosyvoice_server_host: str = "127.0.0.1"
    cosyvoice_server_port: int = 8100
    cosyvoice_model_path: str = ""
    cosyvoice_taiwan_lora_path: str = ""

    # ── 使用者聲音克隆 Profile 設定 ───────────────────────────────
    voice_profiles_dir: str = "voice_profiles"
    voice_sample_max_bytes: int = 20 * 1024 * 1024

    # ── Mobile Onboarding 設定（Big Five 問卷 → 5 位自我 agent，見
    #    services/personality_mapping.py + routers/onboarding.py）─────
    onboarding_sessions_dir: str = "onboarding_sessions"
    # 手機端網頁的 origin，onboarding 專用 REST（/api/onboarding-sessions/...）
    # 需要額外允許這個來源（跟主系統展示端的 frontend_origin 是不同來源，
    # 手機瀏覽器直接打這台後端的 API）。
    mobile_frontend_origin: str = "http://localhost:5175"
    # 用 cloudflared quick tunnel（`cloudflared tunnel --url ...`）打手機前端
    # 出去時，網域是每次重啟都會換的隨機子網域（*.trycloudflare.com），若只
    # 靠 mobile_frontend_origin 的精確比對，每次重啟 tunnel 都要重新設定、
    # 重啟後端。這裡額外支援一個 regex（可留空，預設不啟用），設一次就好，
    # 之後 tunnel 網域怎麼換都不用再改：
    #   MOBILE_FRONTEND_ORIGIN_REGEX=https://.*\.trycloudflare\.com
    mobile_frontend_origin_regex: str = ""

    # ── 多 Agent 設定 ─────────────────────────────────────────────
    max_concurrent_agents: int = 4
    # heuristic：規則式（指名 / 全體依序回應），不呼叫 LLM，延遲最低，預設值。
    # llm_decision：改呼叫 LLM 判斷「這句話該由誰回應」（見 agents/handoff.py
    # 的 build_llm_routing_decision_fn），語意判斷比字串比對準確，但每次
    # 使用者輸入都會多一次 LLM 呼叫（多一點延遲與 API 成本）。
    agent_routing_strategy: Literal["llm_decision", "heuristic"] = "heuristic"
    # llm_decision 策略呼叫 LLM 做路由判斷時的逾時保護（毫秒），逾時或呼叫
    # 失敗時會自動 fallback 用候選名單的第一個 agent，不會讓整輪對話卡死。
    agent_routing_llm_timeout_ms: int = 5000

    # ── 辯論模式設定（agents/debate.py）───────────────────────────
    # 兩位 agent 最多輪流講幾輪就自動結束（每位各講 max/2 次），避免使用者
    # 忘記按暫停/結束時，背景一直呼叫 LLM 燒 API 額度、無限講下去。
    debate_max_turns: int = 20
    # 節奏控制：換人發言前，依該輪預估播放時長（從 TTS 音訊資料長度反推）
    # 補一段等待，讓來回對答的節奏貼近真人聆聽速度，不會因為 TTS 是 mock
    # （或瀏覽器 TTS）幾乎瞬間完成就完全沒有停頓感。單一輪的等待時間上限
    # （秒），避免單輪講太長的話時節奏控制反而讓等待時間離譜地久。
    debate_max_pacing_seconds: float = 12.0

    # ── 傳輸層 / 伺服器設定 ───────────────────────────────────────
    backend_host: str = "0.0.0.0"
    backend_port: int = 8200
    frontend_origin: str = "http://localhost:5174"
    transport: Literal["websocket", "daily", "livekit"] = "websocket"

    class Config:
        env_file = str(_ENV_FILE)
        env_file_encoding = "utf-8"
        extra = "ignore"

    @property
    def is_prod_profile(self) -> bool:
        return self.device_profile == "prod"

    @property
    def has_llm_api_key(self) -> bool:
        """目前設定的 llm_provider 是否已經填了對應的 API key。"""
        if self.llm_provider == "gemini":
            return bool(self.gemini_api_key)
        if self.llm_provider == "openai":
            return bool(self.openai_api_key)
        return False

    def apply_profile_defaults(self) -> "Settings":
        """
        依 device_profile 套用硬體對應預設值（僅在使用者未於 .env 明確覆寫時生效）。
        """
        if self.device_profile == "prod":
            if self.torch_dtype == "float16":
                self.torch_dtype = "bfloat16"
            if self.whisper_model == "small":
                self.whisper_model = "large-v3"
            if not self.breeze_asr_enabled:
                self.breeze_asr_enabled = True
            if self.stt_primary_engine == "faster_whisper":
                self.stt_primary_engine = "breeze"
            if self.tts_engine == "mock":
                self.tts_engine = "cosyvoice2"
        return self


@lru_cache()
def get_settings() -> Settings:
    """回傳快取的設定單例（已套用硬體 profile 預設值）。"""
    return Settings().apply_profile_defaults()

"""
config.py - 環境變數與全域設定
"""

from functools import lru_cache
from pathlib import Path
from pydantic_settings import BaseSettings

# .env 在專案根目錄（backend/ 的上一層）
_ENV_FILE = Path(__file__).parent.parent / ".env"


class Settings(BaseSettings):
    """應用程式設定，從環境變數讀取。"""

    # API Keys（pydantic-settings 自動從 .env / 環境變數讀取）
    meshy_api_key: str = ""
    gemini_api_key: str = ""

    # Meshy.ai 設定
    meshy_base_url: str = "https://api.meshy.ai"
    meshy_poll_interval: float = 3.0
    meshy_poll_timeout: float = 300.0

    # Gemini 設定
    gemini_model: str = "gemini-2.0-flash"

    # 伺服器設定
    backend_host: str = "0.0.0.0"
    backend_port: int = 8000
    frontend_origin: str = "http://localhost:5173"

    # 本地模型設定
    local_model_weights_path: str = ""
    use_local_model_fallback: bool = True

    # 本地 GLB 輸出目錄（相對於 backend/）
    local_output_dir: str = "outputs"

    class Config:
        env_file = str(_ENV_FILE)
        env_file_encoding = "utf-8"
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    """回傳快取的設定單例。"""
    return Settings()

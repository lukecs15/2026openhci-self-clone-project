"""tests/conftest.py — 共用 fixtures，全部使用 mock，不需要 GPU / API key / 模型權重。"""

import os
import sys
from pathlib import Path

import pytest

# 讓 tests/ 可以 `import config`, `import services...` 等（模組採 backend 根目錄相對匯入）
sys.path.insert(0, str(Path(__file__).parent.parent))

os.environ.setdefault("DEVICE_PROFILE", "dev")
os.environ.setdefault("TTS_ENGINE", "mock")
os.environ.setdefault("STT_PRIMARY_ENGINE", "mock")
os.environ.setdefault("STT_FALLBACK_ENGINE", "mock")

from models.schemas import AgentConfig  # noqa: E402


@pytest.fixture
def sample_agents() -> list[AgentConfig]:
    return [
        AgentConfig(agent_id="agent-a", display_name="小明", persona_prompt="你是小明，說話直接。"),
        AgentConfig(agent_id="agent-b", display_name="小華", persona_prompt="你是小華，說話溫和。"),
        AgentConfig(agent_id="agent-c", display_name="阿德", persona_prompt="你是阿德，愛開玩笑。"),
    ]

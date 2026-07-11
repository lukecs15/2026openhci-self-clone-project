"""
services/onboarding_session_service.py — Mobile Onboarding Session 管理

管理「手機問卷 → 主系統體驗 → 結果傳回手機」這個生命週期的檔案式儲存，
儲存模式比照 services/voice_profile_service.py（JSON 檔 + 記憶體無關，
方便之後如果 onboarding 相關端點跟主 API 分開部署也能共用同一份資料）。

生命週期只有兩個狀態（沒有 "pending"）：
    linked      — 手機掃 QR 上傳問卷 + 聲音樣本，後端已建立聲音克隆 profile
                  + 5 位自我 agent（見 services/personality_mapping.py）。
                  「尚未連結」這個狀態不落地存檔，呼叫端查詢不存在的
                  session_id 時 get_session() 回傳 None，由呼叫端（router）
                  自行決定要回 404 還是視為「還在等待手機掃碼」。
    completed   — 主系統體驗（辯論模式）結束，總結句子 + 融合波形已回寫。

使用方式：
    svc = get_onboarding_session_service()
    session = svc.link_session(session_id, big_five, voice_profile_id, agents)
    ...
    session = svc.complete_session(session_id, result)
    session = svc.get_session(session_id)
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from config import get_settings
from models.schemas import AgentConfig, BigFiveScores, OnboardingResult, OnboardingSession

logger = logging.getLogger(__name__)

_SESSIONS_FILENAME = "sessions.json"


class OnboardingSessionAlreadyLinkedError(Exception):
    """session_id 已經連結過（避免同一個 session 被兩支手機搶著上傳）。"""


class OnboardingSessionNotLinkedError(Exception):
    """在 session 還沒被 link_session() 建立之前就呼叫 complete_session()。"""


class OnboardingSessionService:
    """管理 onboarding session（Big Five 分數、生成的 5 位 agent、結束結果）的檔案式儲存。"""

    def __init__(self, base_dir: Optional[str] = None):
        settings = get_settings()
        self._base_dir = Path(base_dir or settings.onboarding_sessions_dir)
        self._base_dir.mkdir(parents=True, exist_ok=True)
        self._sessions_path = self._base_dir / _SESSIONS_FILENAME

    # ── 連結（手機上傳問卷 + 聲音樣本後呼叫）────────────────────────

    def link_session(
        self,
        session_id: str,
        big_five_scores: BigFiveScores,
        voice_profile_id: str,
        agents: list[AgentConfig],
        *,
        allow_relink: bool = False,
    ) -> OnboardingSession:
        """
        建立一場已連結的 onboarding session。

        預設不允許對同一個 session_id 重複連結（避免同一個 QR 被不同手機
        搶著掃、後面的上傳把前面的資料整個蓋掉而使用者無感）；如果呼叫端
        確定要允許重新連結（例如同一個人重新填一次問卷），可傳
        allow_relink=True。
        """
        sessions = self._load_all()
        if session_id in sessions and not allow_relink:
            raise OnboardingSessionAlreadyLinkedError(
                f"session_id={session_id} 已經連結過，不允許重複連結"
            )

        session = OnboardingSession(
            session_id=session_id,
            status="linked",
            big_five_scores=big_five_scores,
            voice_profile_id=voice_profile_id,
            agents=agents,
            result=None,
            linked_at=datetime.now(timezone.utc).isoformat(),
            completed_at="",
        )

        sessions[session_id] = session.model_dump()
        self._save_all(sessions)

        logger.info(
            "onboarding session 已連結：session_id=%s, voice_profile_id=%s, agents=%s",
            session_id,
            voice_profile_id,
            [a.agent_id for a in agents],
        )
        return session

    # ── 完成（主系統體驗結束、回寫總結 + 融合波形後呼叫）────────────

    def complete_session(self, session_id: str, result: OnboardingResult) -> OnboardingSession:
        sessions = self._load_all()
        data = sessions.get(session_id)
        if data is None:
            raise OnboardingSessionNotLinkedError(
                f"session_id={session_id} 尚未連結，無法寫入結束結果"
            )

        session = OnboardingSession(**data)
        session.status = "completed"
        session.result = result
        session.completed_at = datetime.now(timezone.utc).isoformat()

        sessions[session_id] = session.model_dump()
        self._save_all(sessions)

        logger.info("onboarding session 已完成：session_id=%s", session_id)
        return session

    # ── 查詢 ──────────────────────────────────────────────────────

    def get_session(self, session_id: str) -> Optional[OnboardingSession]:
        sessions = self._load_all()
        data = sessions.get(session_id)
        return OnboardingSession(**data) if data else None

    def delete_session(self, session_id: str) -> bool:
        sessions = self._load_all()
        if session_id not in sessions:
            return False
        sessions.pop(session_id)
        self._save_all(sessions)
        return True

    # ── 內部：JSON 檔讀寫 ─────────────────────────────────────────

    def _load_all(self) -> dict:
        if not self._sessions_path.exists():
            return {}
        try:
            return json.loads(self._sessions_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            logger.warning("onboarding sessions.json 損毀，視為空的 session 清單")
            return {}

    def _save_all(self, sessions: dict) -> None:
        self._sessions_path.write_text(
            json.dumps(sessions, ensure_ascii=False, indent=2), encoding="utf-8"
        )


_onboarding_session_service_singleton: Optional[OnboardingSessionService] = None


def get_onboarding_session_service() -> OnboardingSessionService:
    global _onboarding_session_service_singleton
    if _onboarding_session_service_singleton is None:
        _onboarding_session_service_singleton = OnboardingSessionService()
    return _onboarding_session_service_singleton

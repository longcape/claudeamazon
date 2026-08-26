"""通知の中身。

開発指示書 §17 が挙げる重要イベントを型にする。送信手段（Webhook か、
標準出力か、何もしないか）からは独立させ、「何を伝えるか」だけを扱う。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum, IntEnum
from pathlib import Path
from typing import Any, Mapping

from core.state import utcnow

logger = logging.getLogger(__name__)


class NotificationLevel(IntEnum):
    """通知の深刻度。数値が大きいほど深刻。"""

    INFO = 0
    WARNING = 1
    CRITICAL = 2

    @property
    def color(self) -> int:
        """Discord の embed に使う色。"""
        return {
            NotificationLevel.INFO: 0x3498DB,
            NotificationLevel.WARNING: 0xE67E22,
            NotificationLevel.CRITICAL: 0xE74C3C,
        }[self]


class NotificationKind(str, Enum):
    """通知の種類（開発指示書 §17）。"""

    SAFETY_STOP = "SAFETY STOP"
    RESOURCE_LOW = "RESOURCE LOW"
    DAMAGE_DETECTED = "DAMAGE DETECTED"
    NEW_DROP_PROTECTED = "NEW DROP PROTECTED"
    TASK_COMPLETED = "TASK COMPLETED"
    TASK_FAILED = "TASK FAILED"
    #: 全タスクの完了。
    ALL_TASKS_COMPLETED = "ALL TASKS COMPLETED"
    #: 緊急停止の解除。
    STOP_CLEARED = "STOP CLEARED"

    @property
    def default_level(self) -> NotificationLevel:
        """既定の深刻度。"""
        return {
            NotificationKind.SAFETY_STOP: NotificationLevel.CRITICAL,
            NotificationKind.RESOURCE_LOW: NotificationLevel.CRITICAL,
            NotificationKind.DAMAGE_DETECTED: NotificationLevel.WARNING,
            NotificationKind.NEW_DROP_PROTECTED: NotificationLevel.WARNING,
            NotificationKind.TASK_FAILED: NotificationLevel.WARNING,
            NotificationKind.TASK_COMPLETED: NotificationLevel.INFO,
            NotificationKind.ALL_TASKS_COMPLETED: NotificationLevel.INFO,
            NotificationKind.STOP_CLEARED: NotificationLevel.INFO,
        }[self]


@dataclass(frozen=True)
class Notification:
    """送る 1 件。

    Attributes:
        dedupe_hint: 同じ内容の連投を抑えるための鍵。同じ種類でも
            対象が違えば別扱いにしたいので、種類とは別に持つ。
        image_path: 添付する画像。``None`` ならテキストのみ。
    """

    kind: NotificationKind
    title: str
    body: str = ""
    level: NotificationLevel | None = None
    fields: Mapping[str, str] = field(default_factory=dict)
    image_path: Path | None = None
    dedupe_hint: str = ""
    at: datetime = field(default_factory=utcnow)

    @property
    def severity(self) -> NotificationLevel:
        """深刻度（未指定なら種類の既定値）。"""
        return self.level if self.level is not None else self.kind.default_level

    @property
    def dedupe_key(self) -> str:
        """連投抑止に使う鍵。"""
        return f"{self.kind.value}:{self.dedupe_hint}"

    def describe(self) -> str:
        """1 行の要約（ログと標準出力用）。"""
        return f"[{self.kind.value}] {self.title}"

    def to_text(self) -> str:
        """テキストだけの表現。"""
        lines = [f"**{self.kind.value}** — {self.title}"]
        if self.body:
            lines.append(self.body)
        lines.extend(f"{name}: {value}" for name, value in self.fields.items())
        return "\n".join(lines)

    def to_discord_payload(self) -> dict[str, Any]:
        """Discord Webhook の JSON ペイロードへ変換する。"""
        embed: dict[str, Any] = {
            "title": f"{self.kind.value} — {self.title}",
            "color": self.severity.color,
            "timestamp": self.at.isoformat(),
        }
        if self.body:
            embed["description"] = self.body
        if self.fields:
            embed["fields"] = [
                {"name": name, "value": str(value), "inline": True}
                for name, value in self.fields.items()
            ]
        if self.image_path is not None:
            embed["image"] = {"url": f"attachment://{self.image_path.name}"}
        return {"embeds": [embed]}

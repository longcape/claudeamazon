"""安全判定の共通型。

各 Guard は :class:`SafetyVerdict` を返すだけで、停止処理そのものは
:class:`~safety.safety_manager.SafetyManager` が行う。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum
from typing import Iterable, Mapping, Sequence


class SafetyLevel(IntEnum):
    """安全判定の結果。数値が大きいほど深刻。"""

    OK = 0
    WARNING = 1
    STOP = 2


@dataclass(frozen=True)
class SafetyVerdict:
    """安全判定の結果と理由。

    Attributes:
        level: 判定レベル。
        reasons: 人間が読める理由。``WARNING`` と ``STOP`` の理由が
            混在しうるので、レベルの根拠は :attr:`level` を見ること。
        details: 判定に使った具体値（通知やログ用）。
    """

    level: SafetyLevel
    reasons: tuple[str, ...] = ()
    details: Mapping[str, object] = field(default_factory=dict)

    @property
    def should_stop(self) -> bool:
        """タスク実行を止めるべきなら ``True``。"""
        return self.level is SafetyLevel.STOP

    @property
    def is_ok(self) -> bool:
        """問題が無ければ ``True``。"""
        return self.level is SafetyLevel.OK

    def describe(self) -> str:
        """1 行の要約を返す。"""
        if not self.reasons:
            return self.level.name
        return f"{self.level.name}: " + " / ".join(self.reasons)

    @classmethod
    def ok(cls, details: Mapping[str, object] | None = None) -> "SafetyVerdict":
        """問題なしの判定を作る。"""
        return cls(SafetyLevel.OK, (), dict(details or {}))

    @classmethod
    def warn(
        cls, reasons: Sequence[str], details: Mapping[str, object] | None = None
    ) -> "SafetyVerdict":
        """警告の判定を作る（実行は止めない）。"""
        return cls(SafetyLevel.WARNING, tuple(reasons), dict(details or {}))

    @classmethod
    def stop(
        cls, reasons: Sequence[str], details: Mapping[str, object] | None = None
    ) -> "SafetyVerdict":
        """停止判定を作る。"""
        return cls(SafetyLevel.STOP, tuple(reasons), dict(details or {}))

    @classmethod
    def merge(cls, verdicts: Iterable["SafetyVerdict"]) -> "SafetyVerdict":
        """複数の判定を統合する。

        レベルは最も深刻なものを採用し、理由と詳細はすべて残す。
        判定が 1 つも無い場合は :meth:`ok` を返す。
        """
        level = SafetyLevel.OK
        reasons: list[str] = []
        details: dict[str, object] = {}
        for verdict in verdicts:
            level = max(level, verdict.level)
            reasons.extend(verdict.reasons)
            details.update(verdict.details)
        return cls(level, tuple(reasons), details)

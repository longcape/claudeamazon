"""システム全体のステートマシン。

開発指示書 §12 の担当。取りうる状態と、その間の遷移を明示的に定義する。

不正な遷移は「例外」か「STOP」のどちらかにする、というのが指示書の
要求。既定は **EMERGENCY_STOP へ倒す**。想定外の遷移が起きた時点で
システムの理解と実際がずれているので、例外で落として途中状態を残すより、
停止状態を明示して人間の確認を待つほうが安全なため。テストなど、
ずれを即座に検出したい場面では :attr:`InvalidTransitionPolicy.RAISE`
を使う。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Mapping

from core.state import utcnow

logger = logging.getLogger(__name__)


class SystemState(str, Enum):
    """システムの状態。"""

    IDLE = "IDLE"
    INITIALIZING = "INITIALIZING"
    SYNCING = "SYNCING"
    SAFETY_CHECK = "SAFETY_CHECK"
    EXECUTING_TASK = "EXECUTING_TASK"
    WAITING_RESULT = "WAITING_RESULT"
    RECOVERING = "RECOVERING"
    EMERGENCY_STOP = "EMERGENCY_STOP"
    SHUTDOWN = "SHUTDOWN"


#: 許可された遷移。ここに無い組み合わせはすべて不正。
#:
#: * どの状態からも ``EMERGENCY_STOP`` と ``SHUTDOWN`` へは行ける。
#: * ``EMERGENCY_STOP`` から通常状態へは直接戻れない。``RECOVERING``
#:   を経由させ、復旧作業を明示的な状態として残す。
#: * ``SHUTDOWN`` は終端。
TRANSITIONS: Mapping[SystemState, frozenset[SystemState]] = {
    # IDLE からは、起動（INITIALIZING）と、常駐の次の周（SYNCING）へ進める。
    SystemState.IDLE: frozenset({SystemState.INITIALIZING, SystemState.SYNCING}),
    SystemState.INITIALIZING: frozenset({SystemState.SYNCING}),
    SystemState.SYNCING: frozenset({SystemState.SAFETY_CHECK, SystemState.IDLE}),
    SystemState.SAFETY_CHECK: frozenset(
        {SystemState.EXECUTING_TASK, SystemState.SYNCING, SystemState.IDLE}
    ),
    SystemState.EXECUTING_TASK: frozenset(
        {
            SystemState.WAITING_RESULT,
            SystemState.SAFETY_CHECK,
            SystemState.RECOVERING,
        }
    ),
    SystemState.WAITING_RESULT: frozenset(
        {
            SystemState.SYNCING,
            SystemState.SAFETY_CHECK,
            SystemState.RECOVERING,
        }
    ),
    SystemState.RECOVERING: frozenset({SystemState.SYNCING, SystemState.IDLE}),
    SystemState.EMERGENCY_STOP: frozenset({SystemState.RECOVERING}),
    SystemState.SHUTDOWN: frozenset(),
}

#: 終端状態を除くすべての状態から遷移できる先。
_ALWAYS_ALLOWED = frozenset({SystemState.EMERGENCY_STOP, SystemState.SHUTDOWN})


class InvalidTransition(Exception):
    """定義されていない状態遷移を試みたことを表す。"""

    def __init__(self, source: SystemState, target: SystemState) -> None:
        super().__init__(f"不正な状態遷移です: {source.value} -> {target.value}")
        self.source = source
        self.target = target


class InvalidTransitionPolicy(str, Enum):
    """不正な遷移が起きたときの振る舞い。"""

    #: EMERGENCY_STOP へ倒して停止する（既定）。
    EMERGENCY_STOP = "EMERGENCY_STOP"
    #: :class:`InvalidTransition` を送出する。
    RAISE = "RAISE"


@dataclass(frozen=True)
class Transition:
    """1 回の状態遷移の記録（§20 のログ用）。"""

    source: SystemState
    target: SystemState
    at: datetime
    reason: str = ""
    valid: bool = True

    def describe(self) -> str:
        """ログ用の 1 行表記。"""
        mark = "" if self.valid else "(不正) "
        suffix = f" — {self.reason}" if self.reason else ""
        return f"{mark}{self.source.value} -> {self.target.value}{suffix}"


@dataclass
class StateMachine:
    """状態と遷移を管理する。

    Example:
        >>> machine = StateMachine()
        >>> machine.transition(SystemState.INITIALIZING, "起動")
        True
        >>> machine.state
        <SystemState.INITIALIZING: 'INITIALIZING'>
    """

    state: SystemState = SystemState.IDLE
    on_invalid: InvalidTransitionPolicy = InvalidTransitionPolicy.EMERGENCY_STOP
    _history: list[Transition] = field(default_factory=list, init=False)

    @property
    def history(self) -> tuple[Transition, ...]:
        """これまでの遷移。"""
        return tuple(self._history)

    @property
    def is_stopped(self) -> bool:
        """緊急停止中なら ``True``。"""
        return self.state is SystemState.EMERGENCY_STOP

    @property
    def is_terminated(self) -> bool:
        """終了済みなら ``True``。"""
        return self.state is SystemState.SHUTDOWN

    def allowed_targets(self) -> frozenset[SystemState]:
        """現在の状態から遷移できる先。"""
        if self.state is SystemState.SHUTDOWN:
            return frozenset()
        return TRANSITIONS[self.state] | _ALWAYS_ALLOWED

    def can(self, target: SystemState) -> bool:
        """``target`` へ遷移してよいなら ``True``。"""
        return target in self.allowed_targets()

    def transition(self, target: SystemState, reason: str = "") -> bool:
        """状態を遷移させる。

        Args:
            target: 遷移先。
            reason: 遷移の理由（ログと履歴に残る）。

        Returns:
            遷移できたら ``True``。不正な遷移を
            :attr:`InvalidTransitionPolicy.EMERGENCY_STOP` で処理した
            場合は ``False``。

        Raises:
            InvalidTransition: ポリシーが ``RAISE`` で、遷移が不正な場合。
        """
        if target is self.state:
            # 同じ状態への遷移は何もしない（ポーリングで頻発するため）。
            return True

        if self.can(target):
            self._record(self.state, target, reason, valid=True)
            self.state = target
            return True

        source = self.state
        if self.on_invalid is InvalidTransitionPolicy.RAISE:
            self._record(source, target, reason, valid=False)
            raise InvalidTransition(source, target)

        logger.error(
            "不正な状態遷移のため緊急停止します: %s -> %s (%s)",
            source.value,
            target.value,
            reason or "理由なし",
        )
        self._record(source, target, reason, valid=False)
        self.state = SystemState.EMERGENCY_STOP
        self._record(
            source,
            SystemState.EMERGENCY_STOP,
            f"不正な遷移 {source.value} -> {target.value}",
            valid=True,
        )
        return False

    def emergency_stop(self, reason: str) -> None:
        """緊急停止へ遷移する。どの状態からでも呼べる（終了後を除く）。"""
        if self.state is SystemState.SHUTDOWN:
            logger.warning("終了済みのため緊急停止できません: %s", reason)
            return
        self.transition(SystemState.EMERGENCY_STOP, reason)

    def recover(self, reason: str = "") -> bool:
        """緊急停止から復旧を開始する。

        Returns:
            ``RECOVERING`` へ遷移できたら ``True``。
        """
        if not self.is_stopped:
            logger.warning("緊急停止中ではありません: %s", self.state.value)
            return False
        return self.transition(SystemState.RECOVERING, reason or "復旧開始")

    def shutdown(self, reason: str = "") -> None:
        """終了状態へ遷移する。"""
        self.transition(SystemState.SHUTDOWN, reason or "終了")

    def _record(
        self,
        source: SystemState,
        target: SystemState,
        reason: str,
        valid: bool,
    ) -> None:
        """遷移を履歴へ積む。"""
        transition = Transition(source, target, utcnow(), reason, valid)
        self._history.append(transition)
        if valid:
            logger.debug("状態遷移: %s", transition.describe())

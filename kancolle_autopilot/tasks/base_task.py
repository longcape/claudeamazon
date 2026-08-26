"""タスクの共通骨格。

開発指示書 §14 の「実行前に SafetyManager による承認を必須とする」と、
§15 の「目的画面確認 → 操作 → 結果確認 → 失敗時 STOP」をここで一度だけ
書き、個々のタスクは自分の手順だけを書けばよいようにする。

:meth:`BaseTask.execute` の流れ:

1. :class:`~safety.safety_manager.SafetyManager` の総合判定
2. タスク固有の事前条件（:meth:`BaseTask.preconditions`）
3. 手順の実行（:meth:`BaseTask.perform`）
4. 結果の照合（:meth:`BaseTask.verify`）

3 か 4 で失敗したら、その場で緊急停止をラッチする。操作したのに結果を
確認できていない状態は、次の操作を積み重ねてよい状態ではないため。
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, ClassVar, Mapping, Sequence

from automation.interface import ActionResult, GameInterface
from core.state import utcnow
from core.task_queue import Task, TaskPriority
from monitor.game_state import GameState
from safety.safety_manager import SafetyManager
from safety.verdict import SafetyVerdict
from tasks.constraints import NO_CONSTRAINTS, TaskConstraints

logger = logging.getLogger(__name__)


class ActionFailed(Exception):
    """操作が失敗したことを表す内部例外。

    :meth:`BaseTask.step` が送出し、:meth:`BaseTask.execute` が受ける。
    タスク側の手順を素直な直列コードで書けるようにするためのもの。
    """

    def __init__(self, result: ActionResult) -> None:
        super().__init__(result.describe())
        self.result = result


@dataclass(frozen=True)
class TaskResult:
    """タスクの実行結果。"""

    ok: bool
    message: str = ""
    details: Mapping[str, Any] = field(default_factory=dict)
    actions: tuple[ActionResult, ...] = ()

    @classmethod
    def succeeded(
        cls,
        message: str = "",
        details: Mapping[str, Any] | None = None,
        actions: Sequence[ActionResult] = (),
    ) -> "TaskResult":
        """成功の結果を作る。"""
        return cls(True, message, dict(details or {}), tuple(actions))

    @classmethod
    def failure(
        cls,
        message: str,
        details: Mapping[str, Any] | None = None,
        actions: Sequence[ActionResult] = (),
    ) -> "TaskResult":
        """失敗の結果を作る。"""
        return cls(False, message, dict(details or {}), tuple(actions))


@dataclass
class TaskContext:
    """タスクが参照してよいもの一式。

    Attributes:
        performed: このタスクが実行した操作の記録。:meth:`BaseTask.step`
            が積んでいく。
    """

    game_state: GameState
    safety: SafetyManager
    interface: GameInterface
    now: datetime = field(default_factory=utcnow)
    performed: list[ActionResult] = field(default_factory=list)

    @property
    def simulated(self) -> bool:
        """OS の入力に触れない実行なら ``True``。"""
        return self.interface.simulated

    @property
    def verifiable(self) -> bool:
        """操作の結果をゲーム状態で照合できるなら ``True``。"""
        return self.interface.affects_game_state


class BaseTask(ABC):
    """すべてのタスクの基底。

    サブクラスは :attr:`name` と :attr:`priority` を定義し、
    :meth:`perform` を実装する。
    """

    #: タスク名（キューとログに出る）。
    name: ClassVar[str] = "task"
    #: キューでの優先度。
    priority: ClassVar[TaskPriority] = TaskPriority.BACKGROUND
    #: 与えられた制約。:mod:`tasks.factory` が payload から設定する。
    #: 既定は「何も許可されていない」状態。
    constraints: TaskConstraints = NO_CONSTRAINTS

    # ------------------------------------------------------------------
    # サブクラスが差し替える部分
    # ------------------------------------------------------------------

    def safety_fleet_id(self, ctx: TaskContext) -> int | None:
        """安全判定の対象にする艦隊 ID。

        艦隊を動かすタスクは、これを返すことで大破・状態不明の
        チェックを総合判定に含められる。
        """
        return None

    def preconditions(self, ctx: TaskContext) -> SafetyVerdict:
        """タスク固有の事前条件を判定する。

        Returns:
            ``STOP`` なら実行しない。
        """
        return SafetyVerdict.ok()

    @abstractmethod
    def perform(self, ctx: TaskContext) -> TaskResult:
        """実際の手順。:meth:`step` を使って操作を積む。"""

    def verify(self, ctx: TaskContext) -> TaskResult:
        """操作後の結果を照合する。

        操作がゲーム状態を動かさない実行では照合を省略する。実際には
        何も起きていないので、状態が変わるはずがないため。判断基準は
        「OS の入力に触れたか」ではなく「ゲームが動いたか」。
        """
        if not ctx.verifiable:
            return TaskResult.succeeded("結果照合を省略しました（状態が変化しない実行）")
        return TaskResult.succeeded()

    # ------------------------------------------------------------------
    # 共通処理
    # ------------------------------------------------------------------

    def step(self, ctx: TaskContext, result: ActionResult) -> ActionResult:
        """操作結果を記録し、失敗していれば中断する。

        Raises:
            ActionFailed: 操作が失敗した場合。
        """
        ctx.performed.append(result)
        if result.failed:
            raise ActionFailed(result)
        return result

    def to_task(self, payload: Mapping[str, Any] | None = None) -> Task:
        """キューへ載せる :class:`~core.task_queue.Task` を作る。"""
        return Task(
            name=self.name, priority=self.priority, payload=dict(payload or {})
        )

    def execute(self, ctx: TaskContext) -> TaskResult:
        """安全判定 → 事前条件 → 手順 → 照合 の順に実行する。

        Args:
            ctx: 実行に必要な参照一式。

        Returns:
            実行結果。途中で止まった場合は理由が ``message`` に入る。
        """
        verdict = ctx.safety.evaluate(
            ctx.game_state, fleet_id=self.safety_fleet_id(ctx), now=ctx.now
        )
        if verdict.should_stop:
            logger.warning("%s: 安全判定により実行しません: %s", self.name, verdict.describe())
            return TaskResult.failure(
                f"安全判定により中止: {verdict.describe()}",
                {"verdict": verdict.level.name, "reasons": list(verdict.reasons)},
            )

        precondition = self.preconditions(ctx)
        if precondition.should_stop:
            logger.info("%s: 事前条件を満たしません: %s", self.name, precondition.describe())
            return TaskResult.failure(
                f"事前条件を満たしません: {precondition.describe()}",
                {"reasons": list(precondition.reasons)},
            )

        try:
            result = self.perform(ctx)
        except ActionFailed as exc:
            reason = f"{self.name}: 操作に失敗しました: {exc.result.describe()}"
            ctx.safety.trigger_emergency_stop(reason, at=ctx.now)
            return TaskResult.failure(reason, actions=tuple(ctx.performed))

        if not result.ok:
            ctx.safety.trigger_emergency_stop(
                f"{self.name}: {result.message}", at=ctx.now
            )
            return TaskResult(
                False, result.message, result.details, tuple(ctx.performed)
            )

        verification = self.verify(ctx)
        if not verification.ok:
            reason = f"{self.name}: 結果を確認できません: {verification.message}"
            ctx.safety.trigger_emergency_stop(reason, at=ctx.now)
            return TaskResult.failure(
                reason, verification.details, tuple(ctx.performed)
            )

        details = {**result.details, **verification.details}
        message = result.message or verification.message
        logger.info("%s: 完了しました（%d 操作）", self.name, len(ctx.performed))
        return TaskResult.succeeded(message, details, tuple(ctx.performed))

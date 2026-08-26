"""解体タスク。

開発指示書 §9 の 5 段階（candidate → validation → safety approval →
execute → result verification）のうち、3 以降をここで通す。判定そのものは
:class:`~safety.lock_guard.LockGuard` が持ち、このタスクは判定結果に
従うだけ。**タスク側で候補を作り直したり、条件を緩めたりしない。**

実行前に状態のスナップショットを取り、実行後に「消えた艦が承認した艦と
一致するか」を照合する。ここが合わないということは、意図しない艦を
解体した可能性があるので、即座に緊急停止する。
"""

from __future__ import annotations

import logging
from typing import ClassVar, Sequence

from automation.interface import Screen
from core.task_queue import TaskPriority
from monitor.game_state import GameState
from safety.verdict import SafetyVerdict
from tasks.base_task import BaseTask, TaskContext, TaskResult

logger = logging.getLogger(__name__)


class DismantleTask(BaseTask):
    """承認された艦だけを解体する。

    Args:
        candidate_ids: 解体候補の所有 ID。ここから承認されたものだけが
            実際の対象になる。
    """

    name: ClassVar[str] = "dismantle"
    priority: ClassVar[TaskPriority] = TaskPriority.BACKGROUND

    def __init__(self, candidate_ids: Sequence[int]) -> None:
        self.candidate_ids = tuple(candidate_ids)
        self._approved: tuple[int, ...] = ()
        self._before: GameState | None = None

    @property
    def approved_ids(self) -> tuple[int, ...]:
        """承認された艦の ID（:meth:`preconditions` 実行後に確定する）。"""
        return self._approved

    def preconditions(self, ctx: TaskContext) -> SafetyVerdict:
        """SafetyManager に承認を取る。"""
        if not self.candidate_ids:
            return SafetyVerdict.stop(["解体候補が指定されていません"])

        approved, rejected = ctx.safety.approve_dismantle(
            ctx.game_state, self.candidate_ids, now=ctx.now
        )
        self._approved = tuple(approved)

        details = {"approved": list(approved), "rejected": rejected}
        if not approved:
            return SafetyVerdict.stop(
                ["承認された艦がありません"] + rejected, details
            )
        if rejected:
            # 一部だけ承認されるのは正常。除外された理由は残す。
            return SafetyVerdict.warn(rejected, details)
        return SafetyVerdict.ok(details)

    def perform(self, ctx: TaskContext) -> TaskResult:
        """工廠の解体画面で承認された艦を解体する。"""
        if not self._approved:
            return TaskResult.failure("承認された艦がありません")

        # 照合用に実行前の状態を控える。
        self._before = ctx.game_state.snapshot()

        interface = ctx.interface
        self.step(ctx, interface.navigate(Screen.ARSENAL))
        self.step(ctx, interface.navigate(Screen.DISMANTLE))
        for ship_id in self._approved:
            self.step(
                ctx,
                interface.click(
                    f"ship_{ship_id}", Screen.DISMANTLE, f"艦 #{ship_id} を選択"
                ),
            )
        self.step(ctx, interface.click("dismantle_confirm", Screen.DISMANTLE, "解体"))
        self.step(ctx, interface.wait_for_state(Screen.DISMANTLE))
        return TaskResult.succeeded(
            f"{len(self._approved)} 隻を解体しました",
            {"dismantled": list(self._approved)},
        )

    def verify(self, ctx: TaskContext) -> TaskResult:
        """消えた艦が承認した艦と一致するかを照合する。"""
        if not ctx.verifiable:
            return super().verify(ctx)
        if self._before is None:
            return TaskResult.failure("実行前の状態を記録できていません")

        verdict = ctx.safety.lock_guard.verify_result(
            self._before, ctx.game_state, self._approved
        )
        if verdict.should_stop:
            return TaskResult.failure(verdict.describe(), dict(verdict.details))
        return TaskResult.succeeded("解体結果を照合しました", dict(verdict.details))

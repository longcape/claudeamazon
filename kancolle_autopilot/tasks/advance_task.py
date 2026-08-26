"""進撃・撤退のタスク。

出撃中に「次のマスへ進むか、母港へ戻るか」を判断して操作する。判断そのものは
:func:`~tasks.constraints.decide_advance` が持ち、このタスクはそれに従って
画面を操作するだけ。判断と操作を分けているのは、判断だけを単体で検証したいから。
"""

from __future__ import annotations

import logging
from typing import ClassVar

from automation.interface import Screen
from core.task_queue import TaskPriority
from safety.verdict import SafetyVerdict
from tasks.base_task import BaseTask, TaskContext, TaskResult
from tasks.constraints import AdvanceDecision, decide_advance

logger = logging.getLogger(__name__)


class AdvanceTask(BaseTask):
    """出撃中の艦隊を 1 マス進める、または撤退させる。

    Args:
        fleet_id: 出撃中の艦隊。
    """

    name: ClassVar[str] = "advance"
    priority: ClassVar[TaskPriority] = TaskPriority.SORTIE

    def __init__(self, fleet_id: int) -> None:
        self.fleet_id = fleet_id
        self._decision: AdvanceDecision | None = None

    @property
    def decision(self) -> AdvanceDecision | None:
        """実行時に下した判断（実行前は ``None``）。"""
        return self._decision

    def preconditions(self, ctx: TaskContext) -> SafetyVerdict:
        """出撃中であることを確かめる。"""
        sortie = ctx.game_state.sortie
        if sortie is None or not sortie.is_active:
            return SafetyVerdict.stop(["出撃中ではありません"])
        return SafetyVerdict.ok({"map": sortie.map_label})

    def perform(self, ctx: TaskContext) -> TaskResult:
        """判断して、進撃か撤退のどちらかを押す。"""
        decision = decide_advance(
            ctx.game_state.fleet_ships(self.fleet_id), self.constraints
        )
        self._decision = decision
        logger.info("進撃判断: %s", decision.describe())

        if decision.advance:
            self.step(
                ctx,
                ctx.interface.click("advance", Screen.SORTIE_MAP, decision.reason),
            )
            return TaskResult.succeeded(
                f"進撃しました（{decision.reason}）",
                {
                    "advanced": True,
                    "reason_code": decision.reason_code,
                    "sacrificed": list(decision.sacrificed),
                },
            )

        self.step(
            ctx, ctx.interface.click("retreat", Screen.SORTIE_MAP, decision.reason)
        )
        self.step(ctx, ctx.interface.wait_for_state(Screen.HOME))
        return TaskResult.succeeded(
            f"撤退しました（{decision.reason}）",
            {"advanced": False, "reason_code": decision.reason_code},
        )

    def verify(self, ctx: TaskContext) -> TaskResult:
        """撤退したなら出撃が終わっていることを確かめる。"""
        if not ctx.verifiable or self._decision is None:
            return super().verify(ctx)

        sortie = ctx.game_state.sortie
        if not self._decision.advance:
            if sortie is not None and sortie.is_active:
                return TaskResult.failure("撤退したのに出撃が終わっていません")
            return TaskResult.succeeded("撤退を確認しました")

        # 進撃した場合、ボスや最終マスで出撃が終わることもある。
        return TaskResult.succeeded(
            "進撃を確認しました",
            {"still_sortieing": bool(sortie and sortie.is_active)},
        )

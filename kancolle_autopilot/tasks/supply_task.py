"""補給のタスク。"""

from __future__ import annotations

import logging
from typing import ClassVar

from automation.interface import Screen
from core.task_queue import TaskPriority
from safety.verdict import SafetyVerdict
from tasks.base_task import BaseTask, TaskContext, TaskResult

logger = logging.getLogger(__name__)


class SupplyTask(BaseTask):
    """艦隊へ補給する。

    Args:
        fleet_id: 補給する艦隊。
    """

    name: ClassVar[str] = "supply"
    priority: ClassVar[TaskPriority] = TaskPriority.DAILY_TASK

    def __init__(self, fleet_id: int) -> None:
        self.fleet_id = fleet_id

    def preconditions(self, ctx: TaskContext) -> SafetyVerdict:
        """補給できる状態かを見る。"""
        reasons: list[str] = []
        state = ctx.game_state

        fleet = state.fleets.get(self.fleet_id)
        if fleet is None:
            reasons.append(f"第{self.fleet_id}艦隊の情報がありません")
        else:
            if not fleet.ship_ids:
                reasons.append(f"第{self.fleet_id}艦隊が空です")
            if fleet.mission.is_active:
                reasons.append(f"第{self.fleet_id}艦隊は遠征中です")
        if state.sortie is not None and state.sortie.is_active:
            reasons.append("出撃中です")

        if reasons:
            return SafetyVerdict.stop(reasons, {"fleet_id": self.fleet_id})
        return SafetyVerdict.ok({"fleet_id": self.fleet_id})

    def perform(self, ctx: TaskContext) -> TaskResult:
        """補給画面で一括補給する。"""
        interface = ctx.interface
        self.step(ctx, interface.navigate(Screen.SUPPLY))
        self.step(
            ctx,
            interface.click(
                f"fleet_{self.fleet_id}", Screen.SUPPLY, f"第{self.fleet_id}艦隊"
            ),
        )
        self.step(ctx, interface.click("supply_all", Screen.SUPPLY, "一括補給"))
        self.step(ctx, interface.wait_for_state(Screen.SUPPLY))
        return TaskResult.succeeded(
            f"第{self.fleet_id}艦隊へ補給しました", {"fleet_id": self.fleet_id}
        )

    def verify(self, ctx: TaskContext) -> TaskResult:
        """満たされていない艦が残っていないかを見る。"""
        if not ctx.verifiable:
            return super().verify(ctx)

        remaining = [
            ship.instance_id
            for ship in ctx.game_state.fleet_ships(self.fleet_id)
            if ship is not None and (ship.fuel == 0 or ship.ammo == 0)
        ]
        if remaining:
            return TaskResult.failure(f"補給されていない艦がいます: {remaining}")
        return TaskResult.succeeded("補給を確認しました")

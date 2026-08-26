"""遠征を出すタスク。"""

from __future__ import annotations

import logging
from typing import ClassVar

from automation.interface import Screen
from core.task_queue import TaskPriority
from safety.verdict import SafetyVerdict
from tasks.base_task import BaseTask, TaskContext, TaskResult

logger = logging.getLogger(__name__)


class ExpeditionTask(BaseTask):
    """指定した艦隊を遠征へ出す。

    Args:
        fleet_id: 遠征に出す艦隊（第1艦隊は遠征に出せない）。
        mission_id: 遠征番号。
    """

    name: ClassVar[str] = "expedition"
    priority: ClassVar[TaskPriority] = TaskPriority.EXPEDITION

    def __init__(self, fleet_id: int, mission_id: int) -> None:
        self.fleet_id = fleet_id
        self.mission_id = mission_id

    def safety_fleet_id(self, ctx: TaskContext) -> int | None:
        """遠征に出す艦隊を損傷判定の対象にする。"""
        return self.fleet_id

    def preconditions(self, ctx: TaskContext) -> SafetyVerdict:
        """艦隊が遠征に出せる状態かを見る。"""
        reasons: list[str] = []
        if self.fleet_id == 1:
            reasons.append("第1艦隊は遠征に出せません")

        fleet = ctx.game_state.fleets.get(self.fleet_id)
        if fleet is None:
            reasons.append(f"第{self.fleet_id}艦隊の情報がありません")
        else:
            if not fleet.ship_ids:
                reasons.append(f"第{self.fleet_id}艦隊が空です")
            if fleet.mission.is_active:
                reasons.append(
                    f"第{self.fleet_id}艦隊は既に遠征中です"
                    f"（遠征{fleet.mission.mission_id}）"
                )
        if reasons:
            return SafetyVerdict.stop(reasons, {"fleet_id": self.fleet_id})
        return SafetyVerdict.ok({"fleet_id": self.fleet_id})

    def perform(self, ctx: TaskContext) -> TaskResult:
        """遠征画面へ移動して出撃させる。"""
        interface = ctx.interface
        self.step(ctx, interface.navigate(Screen.EXPEDITION))
        self.step(
            ctx,
            interface.click(
                f"mission_{self.mission_id}",
                Screen.EXPEDITION,
                f"遠征{self.mission_id}を選択",
            ),
        )
        self.step(ctx, interface.click("mission_decide", Screen.EXPEDITION, "決定"))
        self.step(
            ctx,
            interface.click(
                f"fleet_{self.fleet_id}",
                Screen.EXPEDITION,
                f"第{self.fleet_id}艦隊を選択",
            ),
        )
        self.step(ctx, interface.click("mission_start", Screen.EXPEDITION, "出撃"))
        self.step(ctx, interface.wait_for_state(Screen.HOME))
        return TaskResult.succeeded(
            f"第{self.fleet_id}艦隊を遠征{self.mission_id}へ送りました",
            {"fleet_id": self.fleet_id, "mission_id": self.mission_id},
        )

    def verify(self, ctx: TaskContext) -> TaskResult:
        """API 側でも遠征中になっているかを確認する。"""
        if not ctx.verifiable:
            return super().verify(ctx)

        fleet = ctx.game_state.fleets.get(self.fleet_id)
        if fleet is None or not fleet.mission.is_active:
            return TaskResult.failure(
                f"第{self.fleet_id}艦隊が遠征中になっていません"
            )
        if fleet.mission.mission_id != self.mission_id:
            return TaskResult.failure(
                "違う遠征に出ています:"
                f" 期待 {self.mission_id} / 実際 {fleet.mission.mission_id}"
            )
        return TaskResult.succeeded(
            "遠征を確認しました", {"complete_at": fleet.mission.complete_at}
        )

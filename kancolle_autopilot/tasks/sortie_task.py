"""出撃するタスク。"""

from __future__ import annotations

import logging
from typing import ClassVar

from automation.interface import Screen
from core.task_queue import TaskPriority
from safety.verdict import SafetyVerdict
from tasks.base_task import BaseTask, TaskContext, TaskResult

logger = logging.getLogger(__name__)


class SortieTask(BaseTask):
    """指定した海域へ出撃する。

    大破・状態不明の判定は :meth:`safety_fleet_id` を通じて
    :class:`~safety.safety_manager.SafetyManager` が行う。ここでは
    「出撃できる状況か」だけを見る。
    """

    name: ClassVar[str] = "sortie"
    priority: ClassVar[TaskPriority] = TaskPriority.SORTIE

    def __init__(self, fleet_id: int, map_area: int, map_no: int) -> None:
        self.fleet_id = fleet_id
        self.map_area = map_area
        self.map_no = map_no

    @property
    def map_label(self) -> str:
        """``"5-5"`` 形式の海域表記。"""
        return f"{self.map_area}-{self.map_no}"

    def safety_fleet_id(self, ctx: TaskContext) -> int | None:
        """出撃する艦隊を損傷判定の対象にする。"""
        return self.fleet_id

    def preconditions(self, ctx: TaskContext) -> SafetyVerdict:
        """既に出撃中でないか、艦隊が使えるかを見る。"""
        reasons: list[str] = []
        state = ctx.game_state

        if state.sortie is not None and state.sortie.is_active:
            reasons.append(f"既に出撃中です（{state.sortie.map_label}）")

        fleet = state.fleets.get(self.fleet_id)
        if fleet is None:
            reasons.append(f"第{self.fleet_id}艦隊の情報がありません")
        else:
            if not fleet.ship_ids:
                reasons.append(f"第{self.fleet_id}艦隊が空です")
            if fleet.mission.is_active:
                reasons.append(f"第{self.fleet_id}艦隊は遠征中です")

        if reasons:
            return SafetyVerdict.stop(reasons, {"map": self.map_label})
        return SafetyVerdict.ok({"map": self.map_label})

    def perform(self, ctx: TaskContext) -> TaskResult:
        """出撃画面へ移動して出撃する。"""
        interface = ctx.interface
        self.step(ctx, interface.navigate(Screen.SORTIE_SELECT))
        self.step(
            ctx,
            interface.click(
                f"area_{self.map_area}", Screen.SORTIE_SELECT, f"{self.map_area}海域"
            ),
        )
        # 海域はエリアを選んだ後の番号で指す。"map_1-5" のような表記は
        # 画面上の一意な位置に対応しないため、座標へ落とせない。
        self.step(
            ctx,
            interface.click(
                f"map_{self.map_no}", Screen.SORTIE_SELECT, f"{self.map_label}を選択"
            ),
        )
        self.step(ctx, interface.click("sortie_decide", Screen.SORTIE_SELECT, "決定"))
        self.step(
            ctx,
            interface.click(
                f"fleet_{self.fleet_id}",
                Screen.SORTIE_SELECT,
                f"第{self.fleet_id}艦隊を選択",
            ),
        )
        self.step(ctx, interface.click("sortie_start", Screen.SORTIE_SELECT, "出撃"))
        self.step(ctx, interface.wait_for_state(Screen.SORTIE_MAP))
        return TaskResult.succeeded(
            f"{self.map_label}へ第{self.fleet_id}艦隊で出撃しました",
            {"map": self.map_label, "fleet_id": self.fleet_id},
        )

    def verify(self, ctx: TaskContext) -> TaskResult:
        """API 側でも出撃が始まっているかを確認する。"""
        if not ctx.verifiable:
            return super().verify(ctx)

        sortie = ctx.game_state.sortie
        if sortie is None or not sortie.is_active:
            return TaskResult.failure("出撃が始まっていません")
        if sortie.map_label != self.map_label:
            return TaskResult.failure(
                f"違う海域に出撃しています: 期待 {self.map_label} / 実際 {sortie.map_label}"
            )
        return TaskResult.succeeded("出撃を確認しました", {"map": sortie.map_label})

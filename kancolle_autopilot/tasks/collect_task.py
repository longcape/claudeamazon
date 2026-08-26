"""時間が来たものを受け取るタスク。

遠征の帰投と建造の完成は、時間が経てば状態が変わるが、**受け取りには操作が
要る**。放っておくと艦隊もドックも塞がったままになるので、常駐ループが
気づいて回収する。

入渠はここに含めない。時間が来れば艦は自動的にドックから出るので、
受け取りという操作が存在しない。
"""

from __future__ import annotations

import logging
from typing import ClassVar

from automation.interface import Screen
from core.state import FleetMissionState
from core.task_queue import TaskPriority
from safety.verdict import SafetyVerdict
from tasks.base_task import BaseTask, TaskContext, TaskResult

logger = logging.getLogger(__name__)


class CollectExpeditionTask(BaseTask):
    """帰投した遠征を受け取る。

    Args:
        fleet_id: 受け取る艦隊。
    """

    name: ClassVar[str] = "collect_expedition"
    priority: ClassVar[TaskPriority] = TaskPriority.SAFETY_TASK

    def __init__(self, fleet_id: int) -> None:
        self.fleet_id = fleet_id

    def preconditions(self, ctx: TaskContext) -> SafetyVerdict:
        """帰投済みであることを確かめる。"""
        fleet = ctx.game_state.fleets.get(self.fleet_id)
        if fleet is None:
            return SafetyVerdict.stop([f"第{self.fleet_id}艦隊の情報がありません"])
        if fleet.mission.state is not FleetMissionState.RETURNED:
            return SafetyVerdict.stop(
                [
                    f"第{self.fleet_id}艦隊は受け取り待ちではありません"
                    f"（{fleet.mission.state.name}）"
                ]
            )
        return SafetyVerdict.ok({"fleet_id": self.fleet_id})

    def perform(self, ctx: TaskContext) -> TaskResult:
        """母港で受け取る。"""
        interface = ctx.interface
        self.step(ctx, interface.navigate(Screen.HOME))
        self.step(
            ctx,
            interface.click(
                f"expedition_return_{self.fleet_id}",
                Screen.HOME,
                f"第{self.fleet_id}艦隊の帰投",
            ),
        )
        self.step(ctx, interface.wait_for_state(Screen.HOME))
        return TaskResult.succeeded(
            f"第{self.fleet_id}艦隊の遠征を受け取りました", {"fleet_id": self.fleet_id}
        )

    def verify(self, ctx: TaskContext) -> TaskResult:
        """艦隊が空いたことを確かめる。"""
        if not ctx.verifiable:
            return super().verify(ctx)

        fleet = ctx.game_state.fleets.get(self.fleet_id)
        if fleet is None or fleet.mission.state is not FleetMissionState.IDLE:
            return TaskResult.failure(f"第{self.fleet_id}艦隊がまだ塞がっています")
        return TaskResult.succeeded("受け取りを確認しました")


class CollectBuildTask(BaseTask):
    """完成した建造艦を受け取る。

    Args:
        dock_id: 受け取るドック。
    """

    name: ClassVar[str] = "collect_build"
    priority: ClassVar[TaskPriority] = TaskPriority.SAFETY_TASK

    def __init__(self, dock_id: int) -> None:
        self.dock_id = dock_id

    def preconditions(self, ctx: TaskContext) -> SafetyVerdict:
        """完成していることと、艦を受け入れる余地があることを確かめる。"""
        dock = ctx.game_state.build_docks.get(self.dock_id)
        if dock is None:
            return SafetyVerdict.stop([f"ドック{self.dock_id}の情報がありません"])
        if not dock.is_complete:
            return SafetyVerdict.stop(
                [f"ドック{self.dock_id}は受け取り待ちではありません"]
            )

        remaining = ctx.game_state.player.remaining_ship_slots(
            len(ctx.game_state.ships)
        )
        if remaining is not None and remaining <= 0:
            # 受け取れないまま操作すると、その場で解体を迫られる。
            return SafetyVerdict.stop(["艦娘の保有枠に空きがありません"])

        return SafetyVerdict.ok({"dock_id": self.dock_id, "slots_left": remaining})

    def perform(self, ctx: TaskContext) -> TaskResult:
        """工廠で受け取る。"""
        interface = ctx.interface
        self.step(ctx, interface.navigate(Screen.BUILD))
        self.step(
            ctx,
            interface.click(
                f"dock_{self.dock_id}", Screen.BUILD, f"ドック{self.dock_id}"
            ),
        )
        self.step(ctx, interface.click("receive_ship", Screen.BUILD, "受け取り"))
        self.step(ctx, interface.wait_for_state(Screen.BUILD))
        return TaskResult.succeeded(
            f"ドック{self.dock_id}の建造艦を受け取りました", {"dock_id": self.dock_id}
        )

    def verify(self, ctx: TaskContext) -> TaskResult:
        """ドックが空いたことを確かめる。"""
        if not ctx.verifiable:
            return super().verify(ctx)

        dock = ctx.game_state.build_docks.get(self.dock_id)
        if dock is None or dock.state != 0:
            return TaskResult.failure(f"ドック{self.dock_id}がまだ塞がっています")
        return TaskResult.succeeded("受け取りを確認しました")

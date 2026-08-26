"""入渠のタスク。

高速修復材（バケツ）を使うかどうかは制約に従う。``use_buckets`` が禁止
されていれば、ドックが空くまで待つ側に倒す。バケツは有限で、使い切ると
「入渠待ちで何もできない」状態になるため、指示で明示的に許可されるまで
温存する側を既定にしている。
"""

from __future__ import annotations

import logging
from typing import ClassVar

from automation.interface import Screen
from core.state import DamageState
from core.task_queue import TaskPriority
from safety.verdict import SafetyVerdict
from tasks.base_task import BaseTask, TaskContext, TaskResult
from tasks.constraints import USE_BUCKETS

logger = logging.getLogger(__name__)


class RepairTask(BaseTask):
    """艦を入渠させる。

    Args:
        ship_id: 修復する艦の所有 ID。
        dock_id: 使うドック。``None`` なら空きを探す。
        prefer_fast: バケツを優先して使う。``use_buckets`` が禁止されて
            いれば無視される。
    """

    name: ClassVar[str] = "repair"
    priority: ClassVar[TaskPriority] = TaskPriority.SAFETY_TASK

    def __init__(
        self,
        ship_id: int,
        dock_id: int | None = None,
        prefer_fast: bool = False,
    ) -> None:
        self.ship_id = ship_id
        self.dock_id = dock_id
        self.prefer_fast = prefer_fast
        self._used_fast = False

    @property
    def used_fast_repair(self) -> bool:
        """バケツを使ったなら ``True``。"""
        return self._used_fast

    def use_fast_repair(self, ctx: TaskContext) -> bool:
        """バケツを使うかどうかを決める。"""
        if not self.prefer_fast:
            return False
        if self.constraints.forbids(USE_BUCKETS):
            logger.info("高速修復材の使用は禁止されています")
            return False
        buckets = ctx.game_state.resources.buckets
        if buckets is None:
            # 残量が分からないなら使わない。
            logger.info("高速修復材の残量が不明なため使いません")
            return False
        return buckets > 0

    def find_free_dock(self, ctx: TaskContext) -> int | None:
        """空いている入渠ドックの ID を返す。"""
        docks = ctx.game_state.repair_docks
        if self.dock_id is not None:
            dock = docks.get(self.dock_id)
            return self.dock_id if dock is not None and dock.state == 0 else None
        for dock_id in sorted(docks):
            if docks[dock_id].state == 0:
                return dock_id
        return None

    def preconditions(self, ctx: TaskContext) -> SafetyVerdict:
        """修復対象とドックを確かめる。"""
        reasons: list[str] = []
        details: dict[str, object] = {"ship_id": self.ship_id}

        ship = ctx.game_state.ships.get(self.ship_id)
        if ship is None:
            reasons.append(f"艦 #{self.ship_id} の情報がありません")
        elif ship.damage_state is DamageState.UNKNOWN:
            reasons.append(f"艦 #{self.ship_id} の損傷状態が不明です")
        elif ship.damage_state is DamageState.NORMAL:
            reasons.append(f"艦 #{self.ship_id} は無傷です")

        if self._assigned_to_active_fleet(ctx):
            reasons.append(f"艦 #{self.ship_id} は出撃中の艦隊にいます")

        fast = self.use_fast_repair(ctx)
        details["fast_repair"] = fast
        if not fast:
            if not ctx.game_state.repair_docks:
                reasons.append("入渠ドックの情報がありません")
            else:
                dock_id = self.find_free_dock(ctx)
                if dock_id is None:
                    reasons.append("空いている入渠ドックがありません")
                else:
                    details["dock_id"] = dock_id

        if reasons:
            return SafetyVerdict.stop(reasons, details)
        return SafetyVerdict.ok(details)

    def perform(self, ctx: TaskContext) -> TaskResult:
        """入渠画面で修復する。"""
        interface = ctx.interface
        self._used_fast = self.use_fast_repair(ctx)

        self.step(ctx, interface.navigate(Screen.REPAIR))

        if not self._used_fast:
            dock_id = self.find_free_dock(ctx)
            if dock_id is None:
                return TaskResult.failure("空いている入渠ドックがなくなりました")
            self.step(
                ctx,
                interface.click(f"dock_{dock_id}", Screen.REPAIR, f"ドック{dock_id}"),
            )
        else:
            dock_id = None

        self.step(
            ctx,
            interface.click(
                f"ship_{self.ship_id}", Screen.REPAIR, f"艦 #{self.ship_id} を選択"
            ),
        )

        if self._used_fast:
            self.step(
                ctx, interface.click("use_fast_repair", Screen.REPAIR, "高速修復")
            )
            message = f"艦 #{self.ship_id} をバケツで修復しました"
        else:
            self.step(ctx, interface.click("repair_start", Screen.REPAIR, "入渠開始"))
            message = f"艦 #{self.ship_id} を入渠させました（ドック{dock_id}）"

        self.step(ctx, interface.wait_for_state(Screen.REPAIR))
        return TaskResult.succeeded(
            message, {"ship_id": self.ship_id, "fast_repair": self._used_fast}
        )

    def verify(self, ctx: TaskContext) -> TaskResult:
        """入渠中になったか、または回復したかを確かめる。"""
        if not ctx.verifiable:
            return super().verify(ctx)

        ship = ctx.game_state.ships.get(self.ship_id)
        if self._used_fast:
            if ship is None or ship.damage_state is not DamageState.NORMAL:
                return TaskResult.failure("バケツを使ったのに回復していません")
            return TaskResult.succeeded("回復を確認しました")

        busy = [
            dock_id
            for dock_id, dock in ctx.game_state.repair_docks.items()
            if dock.is_busy and dock.ship_id == self.ship_id
        ]
        if not busy:
            return TaskResult.failure(f"艦 #{self.ship_id} が入渠中になっていません")
        return TaskResult.succeeded("入渠を確認しました", {"dock_id": busy[0]})

    def _assigned_to_active_fleet(self, ctx: TaskContext) -> bool:
        """出撃中の艦隊に編成されていれば ``True``。"""
        sortie = ctx.game_state.sortie
        if sortie is None or not sortie.is_active:
            return False
        return any(
            self.ship_id in fleet.ship_ids
            for fleet in ctx.game_state.fleets.values()
        )

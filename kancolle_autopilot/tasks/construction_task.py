"""建造タスク。

開発指示書 §4 の「最低値建造（30/30/30/30）」を既定とする。

資材の使い方について 1 点だけ踏み込んだ判断をしている。**建造で資材を
使った結果、安全閾値を割り込むなら実行しない。** 実行前の残量だけを見て
判定すると、建造直後に緊急停止が入る。止まるのは正しいが、止まる前に
資材を使ってしまっては意味がない。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import ClassVar, Mapping

from automation.interface import Screen
from core.state import ResourceKind
from core.task_queue import TaskPriority
from safety.verdict import SafetyVerdict
from tasks.base_task import BaseTask, TaskContext, TaskResult
from tasks.constraints import LARGE_BUILD, LARGE_BUILD_TOTAL

logger = logging.getLogger(__name__)

#: 最低値建造のレシピ。
MINIMUM_RECIPE_VALUE = 30


@dataclass(frozen=True)
class Recipe:
    """建造・開発のレシピ。"""

    fuel: int = MINIMUM_RECIPE_VALUE
    ammo: int = MINIMUM_RECIPE_VALUE
    steel: int = MINIMUM_RECIPE_VALUE
    bauxite: int = MINIMUM_RECIPE_VALUE

    def as_costs(self) -> dict[ResourceKind, int]:
        """資材 ID をキーにした消費量を返す。"""
        return {
            ResourceKind.FUEL: self.fuel,
            ResourceKind.AMMO: self.ammo,
            ResourceKind.STEEL: self.steel,
            ResourceKind.BAUXITE: self.bauxite,
        }

    def as_payload(self) -> dict[str, int]:
        """操作へ渡す形にする。"""
        return {
            "fuel": self.fuel,
            "ammo": self.ammo,
            "steel": self.steel,
            "bauxite": self.bauxite,
        }


#: 最低値建造（30/30/30/30）。
MINIMUM_RECIPE = Recipe()


class ConstructionTask(BaseTask):
    """建造ドックで艦を建造する。

    Args:
        recipe: 投入する資材。既定は最低値建造。
        dock_id: 使用する建造ドック。``None`` なら空きドックを探す。
    """

    name: ClassVar[str] = "construction"
    priority: ClassVar[TaskPriority] = TaskPriority.DAILY_TASK

    def __init__(self, recipe: Recipe = MINIMUM_RECIPE, dock_id: int | None = None) -> None:
        self.recipe = recipe
        self.dock_id = dock_id

    def find_free_dock(self, ctx: TaskContext) -> int | None:
        """空いている建造ドックの ID を返す（無ければ ``None``）。"""
        if self.dock_id is not None:
            dock = ctx.game_state.build_docks.get(self.dock_id)
            return self.dock_id if dock is not None and dock.state == 0 else None
        for dock_id in sorted(ctx.game_state.build_docks):
            if ctx.game_state.build_docks[dock_id].state == 0:
                return dock_id
        return None

    def remaining_after_build(
        self, ctx: TaskContext
    ) -> tuple[Mapping[ResourceKind, int], list[str]]:
        """建造後の残量と、不明な資材の一覧を返す。"""
        resources = ctx.game_state.resources
        remaining: dict[ResourceKind, int] = {}
        unknown: list[str] = []
        for kind, cost in self.recipe.as_costs().items():
            current = resources.get(kind)
            if current is None:
                unknown.append(kind.name)
                continue
            remaining[kind] = current - cost
        return remaining, unknown

    @property
    def total_cost(self) -> int:
        """レシピの資材合計。"""
        return sum(self.recipe.as_payload().values())

    def preconditions(self, ctx: TaskContext) -> SafetyVerdict:
        """ドックの空き、制約、建造後も閾値を保てるかを見る。"""
        reasons: list[str] = []
        details: dict[str, object] = {"recipe": self.recipe.as_payload()}

        if self.constraints.forbids(LARGE_BUILD) and self.total_cost > LARGE_BUILD_TOTAL:
            reasons.append(
                f"大型建造は禁止されています（合計 {self.total_cost} > {LARGE_BUILD_TOTAL}）"
            )

        if not ctx.game_state.build_docks:
            reasons.append("建造ドックの情報がありません")
        else:
            dock_id = self.find_free_dock(ctx)
            if dock_id is None:
                reasons.append("空いている建造ドックがありません")
            else:
                details["dock_id"] = dock_id

        remaining, unknown = self.remaining_after_build(ctx)
        if unknown:
            reasons.append("残量が不明な資材があります: " + ", ".join(unknown))

        thresholds = ctx.safety.resource_guard.thresholds
        # 資源効率は閾値を「上げる」方向にしか効かない。下限そのものは
        # ResourceGuard が持つ絶対の値で、指示で緩められては困る。
        margin = self.constraints.resource_margin
        limits = {
            ResourceKind.FUEL: int(thresholds.min_fuel * margin),
            ResourceKind.AMMO: int(thresholds.min_ammo * margin),
            ResourceKind.STEEL: int(thresholds.min_steel * margin),
            ResourceKind.BAUXITE: int(thresholds.min_bauxite * margin),
        }
        details["resource_margin"] = margin
        for kind, value in remaining.items():
            if value < limits[kind]:
                reasons.append(
                    f"建造すると{kind.name}が下限を割ります"
                    f"（{value} < {limits[kind]}）"
                )
        details["remaining_after_build"] = {
            kind.name: value for kind, value in remaining.items()
        }

        if reasons:
            return SafetyVerdict.stop(reasons, details)
        return SafetyVerdict.ok(details)

    def perform(self, ctx: TaskContext) -> TaskResult:
        """工廠へ移動して建造する。"""
        dock_id = self.find_free_dock(ctx)
        if dock_id is None:
            # preconditions を通っていれば起きないが、状態が入れ替わる
            # 可能性があるので実行直前にもう一度見る。
            return TaskResult.failure("空いている建造ドックがなくなりました")

        interface = ctx.interface
        self.step(ctx, interface.navigate(Screen.ARSENAL))
        self.step(ctx, interface.navigate(Screen.BUILD))
        self.step(
            ctx, interface.click(f"dock_{dock_id}", Screen.BUILD, f"ドック{dock_id}")
        )
        self.step(
            ctx,
            interface.click(
                "recipe_input",
                Screen.BUILD,
                "レシピ入力 "
                + "/".join(str(value) for value in self.recipe.as_payload().values()),
            ),
        )
        self.step(ctx, interface.click("build_start", Screen.BUILD, "建造開始"))
        self.step(ctx, interface.wait_for_state(Screen.BUILD))
        return TaskResult.succeeded(
            f"ドック{dock_id}で建造を開始しました",
            {"dock_id": dock_id, "recipe": self.recipe.as_payload()},
        )

    def verify(self, ctx: TaskContext) -> TaskResult:
        """ドックが建造中になったかを確認する。"""
        if not ctx.verifiable:
            return super().verify(ctx)

        busy = [
            dock_id
            for dock_id, dock in ctx.game_state.build_docks.items()
            if dock.is_busy
        ]
        if not busy:
            return TaskResult.failure("建造中のドックがありません")
        return TaskResult.succeeded("建造を確認しました", {"busy_docks": busy})

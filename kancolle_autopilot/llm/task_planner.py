"""検証済みの計画を、予約とタスクへ落とす。

開発指示書 §17 が求める順序をここで守る。

    自然言語 → Parser → Structured Task → Validation → SafetyManager → TaskQueue

:mod:`llm.parser` が 2 番目まで、:mod:`llm.schema` が 3〜4 番目、この
モジュールが 5〜6 番目にあたる。**LLM の出力がここへ直接届くことはない。**
届くのは検証を通った :class:`~llm.schema.TaskPlan` だけ。

制約（大破進撃禁止など）はタスクの payload に載せて渡す。上位で保持して
おいても、実行するタスクが読めなければ意味がないため。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any, Mapping

from core.gametime import JST
from core.scheduler import Reservation, Scheduler, TaskSpec
from core.state import utcnow
from core.task_queue import Task, TaskQueue, priority_for
from llm.schema import PlannedTask, TaskPlan
from monitor.game_state import GameState
from safety.safety_manager import SafetyManager

logger = logging.getLogger(__name__)

#: 目標だけが与えられたときに補うタスク。
GOAL_TASK_NAME = "sortie"


@dataclass(frozen=True)
class PlanApplication:
    """計画を適用した結果。"""

    queued: tuple[str, ...] = ()
    reservation: Reservation | None = None
    rejected: tuple[str, ...] = ()

    @property
    def accepted(self) -> bool:
        """何かしら受け付けられたなら ``True``。"""
        return bool(self.queued) or self.reservation is not None

    def describe(self) -> str:
        """人間向けの要約。"""
        lines: list[str] = []
        if self.reservation is not None:
            lines.append(f"予約: {self.reservation.describe()}")
        if self.queued:
            lines.append(f"投入: {len(self.queued)} 件")
        for reason in self.rejected:
            lines.append(f"却下: {reason}")
        return "\n".join(lines) or "適用するものがありませんでした"


def _payload_for(plan: TaskPlan, task: PlannedTask) -> dict[str, Any]:
    """タスクへ渡す payload を組み立てる。

    制約と最適化方針は全タスクに載せる。読むかどうかは各タスクの判断。
    """
    payload: dict[str, Any] = dict(task.params)
    payload["constraints"] = list(plan.constraints.prohibit)
    payload["resource_efficiency"] = plan.resource_efficiency
    payload["disposable_ship_strategy"] = plan.disposable_ship_strategy
    if not plan.goal.is_empty:
        payload["goal"] = {
            "map": plan.goal.map,
            "objective": plan.goal.objective,
            "rank_points": plan.goal.rank_points,
            "count": plan.goal.count,
        }
    return payload


def expand_tasks(plan: TaskPlan) -> tuple[PlannedTask, ...]:
    """計画から、実際に投入するタスクの並びを作る。

    タスクが 1 つも指定されておらず目標だけがある場合（「5-5 のゲージを
    割って」など）、出撃タスクを補う。目標を持ったまま何も実行しない、
    という状態にしないため。
    """
    if plan.tasks:
        return plan.tasks
    if plan.goal.is_empty:
        return ()
    params: dict[str, Any] = {}
    if plan.goal.map is not None:
        params["map"] = plan.goal.map
    logger.info("目標のみの計画なので %s を補います", GOAL_TASK_NAME)
    return (PlannedTask(name=GOAL_TASK_NAME, params=params),)


def resolve_run_at(plan: TaskPlan, now: datetime) -> datetime | None:
    """予約の発火時刻を求める。

    時刻は JST として解釈する。日付が指定されていなければ、``now`` 以降で
    最も近いその時刻にする（すでに過ぎていれば翌日）。

    Returns:
        発火時刻。予約でなければ ``None``。
    """
    if not plan.schedule.is_scheduled or plan.schedule.time is None:
        return None

    hour, minute = (int(part) for part in plan.schedule.time.split(":"))
    local_now = now.astimezone(JST)

    if plan.schedule.date is not None:
        target_date = date.fromisoformat(plan.schedule.date)
    else:
        target_date = local_now.date()

    run_at = datetime.combine(target_date, time(hour, minute), tzinfo=JST)
    if plan.schedule.date is None and run_at <= local_now:
        # 今日の分が過ぎていれば翌日にする。
        run_at += timedelta(days=1)
    return run_at


def plan_to_specs(plan: TaskPlan) -> list[TaskSpec]:
    """計画を :class:`~core.scheduler.TaskSpec` の並びへ変換する。

    予約に載せる場合も、キューへ直接入れる場合も、ここを通す。
    """
    return [
        TaskSpec(
            name=task.name,
            priority=priority_for(task.name),
            payload=_payload_for(plan, task),
        )
        for task in expand_tasks(plan)
    ]


@dataclass
class TaskPlanner:
    """計画を予約とキューへ落とす。

    Example:
        >>> planner = TaskPlanner(scheduler, queue, safety, state)
        >>> planner.apply(plan)
    """

    scheduler: Scheduler
    queue: TaskQueue
    safety: SafetyManager
    game_state: GameState

    def apply(self, plan: TaskPlan, now: datetime | None = None) -> PlanApplication:
        """計画を適用する。

        予約は安全判定を待たずに登録する（実行時に改めて判定される）。
        いま投入するタスクは、安全判定が ``STOP`` なら 1 件も入れない。

        Args:
            plan: 検証済みの計画。
            now: 現在時刻。

        Returns:
            適用結果。
        """
        moment = now or utcnow()
        tasks = expand_tasks(plan)
        if not tasks:
            return PlanApplication(rejected=("投入するタスクがありません",))

        run_at = resolve_run_at(plan, moment)
        if run_at is not None:
            reservation = self.scheduler.reserve(
                run_at, plan_to_specs(plan), name=plan.schedule.type
            )
            logger.info("計画を予約しました: %s", reservation.describe())
            return PlanApplication(reservation=reservation)

        verdict = self.safety.evaluate(self.game_state, now=moment)
        if verdict.should_stop:
            logger.warning("安全判定により計画を却下しました: %s", verdict.describe())
            return PlanApplication(
                rejected=(f"安全判定により却下: {verdict.describe()}",)
            )

        queued = [
            self.queue.push(
                Task(
                    name=task.name,
                    priority=priority_for(task.name),
                    payload=_payload_for(plan, task),
                )
            ).task_id
            for task in tasks
        ]
        logger.info("計画を投入しました: %d 件", len(queued))
        return PlanApplication(queued=tuple(queued))

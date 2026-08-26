"""BaseTask のテスト。"""

from __future__ import annotations

from typing import ClassVar

import pytest

from automation.interface import Screen
from automation.simulation import SimulationInterface
from core.state import Resources
from core.task_queue import TaskPriority
from safety.verdict import SafetyVerdict
from tasks.base_task import BaseTask, TaskContext, TaskResult
from tests.task_helpers import T0, make_context, make_state


class NoopTask(BaseTask):
    """クリック 1 回だけの最小タスク。"""

    name: ClassVar[str] = "noop"
    priority: ClassVar[TaskPriority] = TaskPriority.BACKGROUND

    def perform(self, ctx: TaskContext) -> TaskResult:
        self.step(ctx, ctx.interface.click("noop_button", Screen.HOME))
        return TaskResult.succeeded("完了")


class BlockedTask(NoopTask):
    """事前条件で必ず止まるタスク。"""

    name: ClassVar[str] = "blocked"

    def preconditions(self, ctx: TaskContext) -> SafetyVerdict:
        return SafetyVerdict.stop(["テスト用の事前条件"])


class ReportingFailureTask(NoopTask):
    """手順自体は通るが、失敗を返すタスク。"""

    name: ClassVar[str] = "reporting_failure"

    def perform(self, ctx: TaskContext) -> TaskResult:
        return TaskResult.failure("想定外の画面でした")


class FleetTask(NoopTask):
    """艦隊を安全判定の対象にするタスク。"""

    name: ClassVar[str] = "fleet"

    def __init__(self, fleet_id: int) -> None:
        self.fleet_id = fleet_id

    def safety_fleet_id(self, ctx: TaskContext) -> int | None:
        return self.fleet_id


def test_successful_task(): 
    ctx = make_context()
    result = NoopTask().execute(ctx)
    assert result.ok is True
    assert [action.action.target for action in result.actions] == ["noop_button"]


def test_safety_stop_prevents_execution() -> None:
    """安全判定が STOP なら手順に入らない。"""
    ctx = make_context()
    ctx.game_state.resources = Resources(**{**vars(ctx.game_state.resources), "fuel": 1})
    result = NoopTask().execute(ctx)
    assert result.ok is False
    assert "安全判定により中止" in result.message
    assert ctx.performed == []


def test_precondition_stop_prevents_execution() -> None:
    ctx = make_context()
    result = BlockedTask().execute(ctx)
    assert result.ok is False
    assert "事前条件を満たしません" in result.message
    assert ctx.performed == []


def test_precondition_failure_does_not_latch_stop() -> None:
    """事前条件で止まるのは正常系。緊急停止はしない。"""
    ctx = make_context()
    BlockedTask().execute(ctx)
    assert ctx.safety.is_stopped is False


def test_action_failure_latches_emergency_stop() -> None:
    """操作に失敗したら即座に緊急停止する（§15）。"""
    interface = SimulationInterface(screen=Screen.BUILD)  # HOME ではない
    ctx = make_context(interface=interface)
    result = NoopTask().execute(ctx)

    assert result.ok is False
    assert "操作に失敗しました" in result.message
    assert ctx.safety.is_stopped is True


def test_reported_failure_latches_emergency_stop() -> None:
    ctx = make_context()
    result = ReportingFailureTask().execute(ctx)
    assert result.ok is False
    assert ctx.safety.is_stopped is True


def test_verify_is_skipped_in_simulation() -> None:
    ctx = make_context()
    result = NoopTask().execute(ctx)
    assert result.ok is True


def test_damaged_fleet_blocks_task() -> None:
    """安全判定の対象艦隊に大破がいれば実行しない。"""
    ctx = make_context()
    result = FleetTask(fleet_id=1).execute(ctx)
    assert result.ok is False
    assert "大破" in result.message


def test_healthy_fleet_allows_task() -> None:
    ctx = make_context()
    assert FleetTask(fleet_id=2).execute(ctx).ok is True


def test_to_task_carries_name_and_priority() -> None:
    task = NoopTask().to_task({"x": 1})
    assert task.name == "noop"
    assert task.priority is TaskPriority.BACKGROUND
    assert task.payload == {"x": 1}


def test_task_result_helpers() -> None:
    assert TaskResult.succeeded("ok").ok is True
    assert TaskResult.failure("ng").ok is False

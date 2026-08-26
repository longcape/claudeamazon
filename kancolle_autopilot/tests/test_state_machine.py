"""StateMachine のテスト。"""

from __future__ import annotations

import pytest

from core.state_machine import (
    InvalidTransition,
    InvalidTransitionPolicy,
    StateMachine,
    SystemState,
)


@pytest.fixture
def machine() -> StateMachine:
    """不正遷移を例外にする（テストではずれを即座に検出したい）。"""
    return StateMachine(on_invalid=InvalidTransitionPolicy.RAISE)


def test_starts_idle(machine: StateMachine) -> None:
    assert machine.state is SystemState.IDLE


def test_normal_cycle(machine: StateMachine) -> None:
    """起動から 1 タスク実行までの通常経路。"""
    path = [
        SystemState.INITIALIZING,
        SystemState.SYNCING,
        SystemState.SAFETY_CHECK,
        SystemState.EXECUTING_TASK,
        SystemState.WAITING_RESULT,
        SystemState.SYNCING,
        SystemState.SAFETY_CHECK,
        SystemState.IDLE,
    ]
    for target in path:
        assert machine.transition(target, "テスト") is True
    assert machine.state is SystemState.IDLE


def test_invalid_transition_raises(machine: StateMachine) -> None:
    with pytest.raises(InvalidTransition):
        machine.transition(SystemState.EXECUTING_TASK, "いきなり実行")


def test_invalid_transition_stops_by_default() -> None:
    """既定では例外ではなく緊急停止へ倒す。"""
    machine = StateMachine()
    assert machine.transition(SystemState.EXECUTING_TASK, "いきなり実行") is False
    assert machine.state is SystemState.EMERGENCY_STOP
    assert machine.is_stopped is True


def test_same_state_transition_is_noop(machine: StateMachine) -> None:
    assert machine.transition(SystemState.IDLE) is True
    assert machine.history == ()


def test_emergency_stop_from_any_state(machine: StateMachine) -> None:
    machine.transition(SystemState.INITIALIZING)
    machine.transition(SystemState.SYNCING)
    machine.emergency_stop("資材が下限を割りました")
    assert machine.state is SystemState.EMERGENCY_STOP


def test_cannot_return_directly_from_emergency_stop(machine: StateMachine) -> None:
    """緊急停止からは RECOVERING を経由させる。"""
    machine.emergency_stop("停止")
    with pytest.raises(InvalidTransition):
        machine.transition(SystemState.SYNCING)


def test_recover_path(machine: StateMachine) -> None:
    machine.emergency_stop("停止")
    assert machine.recover("人手で確認済み") is True
    assert machine.state is SystemState.RECOVERING
    assert machine.transition(SystemState.SYNCING) is True


def test_recover_outside_stop_is_ignored(machine: StateMachine) -> None:
    assert machine.recover() is False
    assert machine.state is SystemState.IDLE


def test_shutdown_is_terminal(machine: StateMachine) -> None:
    machine.shutdown("終了")
    assert machine.is_terminated is True
    assert machine.allowed_targets() == frozenset()
    with pytest.raises(InvalidTransition):
        machine.transition(SystemState.IDLE)


def test_emergency_stop_after_shutdown_is_ignored(machine: StateMachine) -> None:
    machine.shutdown()
    machine.emergency_stop("遅れて届いた停止要求")
    assert machine.state is SystemState.SHUTDOWN


def test_can_reports_allowed_targets(machine: StateMachine) -> None:
    assert machine.can(SystemState.INITIALIZING) is True
    assert machine.can(SystemState.EXECUTING_TASK) is False
    # 緊急停止と終了はどこからでも可能。
    assert machine.can(SystemState.EMERGENCY_STOP) is True
    assert machine.can(SystemState.SHUTDOWN) is True


def test_execution_failure_goes_to_recovering(machine: StateMachine) -> None:
    for target in (
        SystemState.INITIALIZING,
        SystemState.SYNCING,
        SystemState.SAFETY_CHECK,
        SystemState.EXECUTING_TASK,
    ):
        machine.transition(target)
    assert machine.transition(SystemState.RECOVERING, "操作結果を確認できない") is True


def test_history_records_transitions(machine: StateMachine) -> None:
    machine.transition(SystemState.INITIALIZING, "起動")
    machine.transition(SystemState.SYNCING, "同期")
    assert [t.target for t in machine.history] == [
        SystemState.INITIALIZING,
        SystemState.SYNCING,
    ]
    assert machine.history[0].reason == "起動"
    assert "IDLE -> INITIALIZING" in machine.history[0].describe()


def test_history_records_invalid_attempt() -> None:
    """不正な遷移も履歴に残す（あとから原因を追えるように）。"""
    machine = StateMachine()
    machine.transition(SystemState.EXECUTING_TASK, "いきなり実行")
    invalid = [t for t in machine.history if not t.valid]
    assert len(invalid) == 1
    assert invalid[0].target is SystemState.EXECUTING_TASK
    assert "(不正)" in invalid[0].describe()

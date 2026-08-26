"""TaskParser / TaskPlanner のテスト。

追加指示書 §20 の自律テスト例を、そのままケースとして持つ。
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from core.gametime import JST
from core.scheduler import Scheduler
from core.task_queue import TaskPriority, TaskQueue
from llm.parser import ParseError, StubClient, TaskParser
from llm.schema import PlannedTask, TaskPlan, validate_plan
from llm.task_planner import TaskPlanner, expand_tasks, resolve_run_at
from monitor.api_parser import APIParser
from monitor.game_state import GameState
from safety.lock_guard import Blacklist, DismantlePolicy, LockGuard
from safety.safety_manager import SafetyManager
from tests.helpers import load_fixture

T0 = datetime(2024, 5, 2, 3, 0, tzinfo=timezone.utc)  # JST 12:00


@pytest.fixture
def state() -> GameState:
    state = GameState(clock=lambda: T0)
    state.apply_all(APIParser().parse_record(load_fixture("port.json"), T0))
    return state


@pytest.fixture
def planner(state: GameState) -> TaskPlanner:
    return TaskPlanner(
        scheduler=Scheduler(),
        queue=TaskQueue(),
        safety=SafetyManager(
            lock_guard=LockGuard(
                Blacklist(allow_empty=True, source="test"), DismantlePolicy()
            )
        ),
        game_state=state,
    )


def parser_for(*payloads: dict) -> TaskParser:
    return TaskParser(StubClient([json.dumps(p, ensure_ascii=False) for p in payloads]))


# ======================================================================
# 変換
# ======================================================================


def test_parse_returns_validated_plan() -> None:
    parser = parser_for({"tasks": [{"name": "daily"}]})
    plan = parser.parse("デイリー消化して")
    assert isinstance(plan, TaskPlan)
    assert plan.tasks[0].name == "daily"


def test_instruction_reaches_the_model() -> None:
    client = StubClient([json.dumps({"tasks": [{"name": "daily"}]})])
    TaskParser(client).parse("  デイリー消化して  ")
    system, user = client.prompts[0]
    assert user == "デイリー消化して"
    assert "JSON" in system


def test_empty_instruction_is_rejected() -> None:
    with pytest.raises(ParseError, match="指示が空です"):
        parser_for({"tasks": []}).parse("   ")


def test_non_json_response_is_rejected() -> None:
    parser = TaskParser(StubClient(["わかりました、周回します！"]))
    with pytest.raises(ParseError, match="JSON として読めません"):
        parser.parse("周回して")


def test_schema_violation_is_rejected() -> None:
    """スキーマ検証は API 側任せにしない。"""
    parser = parser_for({"tasks": [{"name": "run_shell", "params": {"cmd": "ls"}}]})
    with pytest.raises(ParseError, match="スキーマに合いません"):
        parser.parse("何か実行して")


def test_client_error_propagates() -> None:
    parser = TaskParser(StubClient(error=ParseError("応答が拒否されました")))
    with pytest.raises(ParseError, match="拒否"):
        parser.parse("周回して")


# ======================================================================
# 追加指示書 §20 の自律テスト例
# ======================================================================


def test_case_1_break_the_gauge(planner: TaskPlanner) -> None:
    """「5-5ゲージを割って」"""
    plan = parser_for(
        {"tasks": [], "goal": {"map": "5-5", "objective": "destroy_gauge"}}
    ).parse("5-5ゲージを割って")

    result = planner.apply(plan, now=T0)
    assert result.accepted is True

    task = planner.queue.pop()
    assert task.name == "sortie"
    assert task.payload["map"] == "5-5"
    assert task.payload["goal"]["objective"] == "destroy_gauge"


def test_case_2_farm_rank_points(planner: TaskPlanner) -> None:
    """「戦果50くらい稼いで。資源節約重視。」"""
    plan = parser_for(
        {
            "tasks": [{"name": "sortie", "params": {"map": "1-5"}}],
            "goal": {"objective": "farm_rank_points", "rank_points": 50},
            "optimization": {"resource_efficiency": "high"},
        }
    ).parse("戦果50くらい稼いで。資源節約重視。")

    planner.apply(plan, now=T0)
    task = planner.queue.pop()
    assert task.payload["resource_efficiency"] == "high"
    assert task.payload["goal"]["rank_points"] == 50


def test_case_3_constraints_reach_the_task(planner: TaskPlanner) -> None:
    """「大破進撃は禁止。捨て艦戦法は許可。」"""
    plan = parser_for(
        {
            "tasks": [{"name": "sortie"}],
            "constraints": {"prohibit": ["advance_with_heavy_damage"]},
            "strategy_options": {"disposable_ship_strategy": "allowed"},
        }
    ).parse("大破進撃は禁止。捨て艦戦法は許可。")

    planner.apply(plan, now=T0)
    task = planner.queue.pop()
    assert task.payload["constraints"] == ["advance_with_heavy_damage"]
    assert task.payload["disposable_ship_strategy"] == "allowed"


def test_case_4_scheduled_playlist(planner: TaskPlanner) -> None:
    """「明日の10:52からデイリー、その後遠征、最後に戦果周回。」"""
    plan = parser_for(
        {
            "tasks": [
                {"name": "daily"},
                {"name": "expedition"},
                {"name": "sortie"},
            ],
            "schedule": {"type": "once", "time": "10:52"},
        }
    ).parse("明日の10:52からデイリー、その後遠征、最後に戦果周回。")

    result = planner.apply(plan, now=T0)
    assert result.reservation is not None
    assert planner.queue.is_empty is True  # 予約なので今は投入しない

    specs = result.reservation.specs
    assert [spec.name for spec in specs] == ["daily", "expedition", "sortie"]
    assert specs[0].priority is TaskPriority.DAILY_TASK
    # JST 12:00 に「10:52」を指定 → すでに過ぎているので翌日
    assert result.reservation.run_at == datetime(2024, 5, 3, 10, 52, tzinfo=JST)


# ======================================================================
# 予約時刻の解決
# ======================================================================


def test_future_time_today() -> None:
    plan = validate_plan(
        {"tasks": [{"name": "daily"}], "schedule": {"type": "once", "time": "23:00"}}
    )
    assert resolve_run_at(plan, T0) == datetime(2024, 5, 2, 23, 0, tzinfo=JST)


def test_past_time_rolls_to_tomorrow() -> None:
    plan = validate_plan(
        {"tasks": [{"name": "daily"}], "schedule": {"type": "once", "time": "09:00"}}
    )
    assert resolve_run_at(plan, T0) == datetime(2024, 5, 3, 9, 0, tzinfo=JST)


def test_explicit_date_is_used_as_is() -> None:
    plan = validate_plan(
        {
            "tasks": [{"name": "daily"}],
            "schedule": {"type": "once", "time": "05:30", "date": "2024-05-10"},
        }
    )
    assert resolve_run_at(plan, T0) == datetime(2024, 5, 10, 5, 30, tzinfo=JST)


def test_unscheduled_plan_has_no_run_at() -> None:
    assert resolve_run_at(validate_plan({"tasks": [{"name": "daily"}]}), T0) is None


# ======================================================================
# 適用
# ======================================================================


def test_goal_only_plan_gets_a_sortie(planner: TaskPlanner) -> None:
    """目標だけの計画は、実行するものが無いまま終わらせない。"""
    plan = validate_plan({"tasks": [], "goal": {"map": "1-6"}})
    assert [task.name for task in expand_tasks(plan)] == ["sortie"]


def test_tasks_keep_their_order(planner: TaskPlanner) -> None:
    plan = validate_plan(
        {"tasks": [{"name": "daily"}, {"name": "expedition"}, {"name": "sortie"}]}
    )
    planner.apply(plan, now=T0)
    assert [planner.queue.pop().name for _ in range(3)] == [
        "daily",
        "expedition",
        "sortie",
    ]


def test_safety_stop_rejects_immediate_tasks(planner: TaskPlanner) -> None:
    """いま投入するタスクは安全判定を通す。"""
    planner.safety.trigger_emergency_stop("資材の急減", at=T0)
    result = planner.apply(validate_plan({"tasks": [{"name": "daily"}]}), now=T0)

    assert result.accepted is False
    assert "安全判定により却下" in result.rejected[0]
    assert planner.queue.is_empty is True


def test_safety_stop_does_not_block_reservations(planner: TaskPlanner) -> None:
    """予約は登録できる。実行時に改めて判定される。"""
    planner.safety.trigger_emergency_stop("資材の急減", at=T0)
    plan = validate_plan(
        {"tasks": [{"name": "daily"}], "schedule": {"type": "once", "time": "23:00"}}
    )
    assert planner.apply(plan, now=T0).reservation is not None


def test_reservation_survives_a_restart(planner: TaskPlanner, tmp_path) -> None:
    planner.scheduler.state_path = tmp_path / "schedule.json"
    plan = validate_plan(
        {"tasks": [{"name": "daily"}], "schedule": {"type": "once", "time": "23:00"}}
    )
    planner.apply(plan, now=T0)

    restored = Scheduler.load(tmp_path / "schedule.json")
    assert [spec.name for spec in restored.pending()[0].specs] == ["daily"]


def test_describe_result(planner: TaskPlanner) -> None:
    result = planner.apply(validate_plan({"tasks": [{"name": "daily"}]}), now=T0)
    assert "投入: 1 件" in result.describe()

"""構造化タスクのスキーマ検証のテスト。"""

from __future__ import annotations

import pytest

from llm.schema import (
    PLAN_JSON_SCHEMA,
    SchemaError,
    TaskPlan,
    validate_plan,
)


def minimal(**overrides) -> dict:
    base = {"tasks": [{"name": "daily"}]}
    base.update(overrides)
    return base


# ======================================================================
# 受理
# ======================================================================


def test_minimal_plan() -> None:
    plan = validate_plan(minimal())
    assert [task.name for task in plan.tasks] == ["daily"]
    assert plan.resource_efficiency == "normal"
    assert plan.disposable_ship_strategy == "forbidden"


def test_task_params_are_kept() -> None:
    plan = validate_plan({"tasks": [{"name": "sortie", "params": {"map": "1-5"}}]})
    assert plan.tasks[0].params == {"map": "1-5"}


def test_goal_only_plan() -> None:
    """追加指示書 §6: 「5-5ゲージを割って」相当。"""
    plan = validate_plan(
        {"tasks": [], "goal": {"map": "5-5", "objective": "destroy_gauge"}}
    )
    assert plan.tasks == ()
    assert plan.goal.map == "5-5"
    assert plan.goal.objective == "destroy_gauge"


def test_rank_points_goal() -> None:
    """追加指示書 §7: 「戦果 +50」相当。"""
    plan = validate_plan(
        {
            "tasks": [],
            "goal": {"objective": "farm_rank_points", "rank_points": 50},
            "optimization": {"resource_efficiency": "high"},
        }
    )
    assert plan.goal.rank_points == 50
    assert plan.resource_efficiency == "high"


def test_constraints() -> None:
    """追加指示書 §8 の制約条件。"""
    plan = validate_plan(
        minimal(
            constraints={"prohibit": ["advance_with_heavy_damage"]},
            strategy_options={"disposable_ship_strategy": "allowed"},
        )
    )
    assert plan.constraints.forbids("advance_with_heavy_damage") is True
    assert plan.constraints.forbids("use_buckets") is False
    assert plan.disposable_ship_strategy == "allowed"


def test_schedule() -> None:
    plan = validate_plan(minimal(schedule={"type": "once", "time": "10:52"}))
    assert plan.schedule.is_scheduled is True
    assert plan.schedule.time == "10:52"


def test_schedule_with_date() -> None:
    plan = validate_plan(
        minimal(schedule={"type": "once", "time": "05:30", "date": "2026-08-27"})
    )
    assert plan.schedule.date == "2026-08-27"


def test_describe_is_readable() -> None:
    text = validate_plan(
        minimal(schedule={"type": "once", "time": "10:52"})
    ).describe()
    assert "予定: once 10:52" in text
    assert "タスク: daily" in text


# ======================================================================
# 拒否
# ======================================================================


def test_unknown_top_level_key() -> None:
    with pytest.raises(SchemaError, match="未知のキー: shell"):
        validate_plan(minimal(shell="rm -rf /"))


def test_unknown_task_name() -> None:
    """語彙外のタスク名は通さない。"""
    with pytest.raises(SchemaError, match="tasks\\[0\\].name"):
        validate_plan({"tasks": [{"name": "exec_python"}]})


def test_unknown_task_key() -> None:
    with pytest.raises(SchemaError, match="tasks\\[0\\]: 未知のキー"):
        validate_plan({"tasks": [{"name": "daily", "command": "ls"}]})


def test_unknown_objective() -> None:
    with pytest.raises(SchemaError, match="goal.objective"):
        validate_plan({"tasks": [], "goal": {"objective": "delete_everything"}})


def test_unknown_prohibition() -> None:
    with pytest.raises(SchemaError, match="constraints.prohibit"):
        validate_plan(minimal(constraints={"prohibit": ["breathe"]}))


def test_missing_tasks_key() -> None:
    with pytest.raises(SchemaError, match="tasks は必須"):
        validate_plan({"goal": {"map": "1-5"}})


def test_empty_plan_is_rejected() -> None:
    """タスクも目標も無い計画は受け取らない。"""
    with pytest.raises(SchemaError, match="実行するタスクも目標もありません"):
        validate_plan({"tasks": []})


def test_non_object_input() -> None:
    with pytest.raises(SchemaError, match="オブジェクト"):
        validate_plan(["daily"])


def test_tasks_must_be_array() -> None:
    with pytest.raises(SchemaError, match="tasks: 配列"):
        validate_plan({"tasks": "daily"})


@pytest.mark.parametrize("value", ["25:00", "1052", "10時52分", "10:5"])
def test_bad_time_format(value) -> None:
    with pytest.raises(SchemaError, match="HH:MM"):
        validate_plan(minimal(schedule={"type": "once", "time": value}))


def test_bad_date_format() -> None:
    with pytest.raises(SchemaError, match="YYYY-MM-DD"):
        validate_plan(
            minimal(schedule={"type": "once", "time": "10:52", "date": "8/27"})
        )


def test_schedule_without_time() -> None:
    with pytest.raises(SchemaError, match="time が必要"):
        validate_plan(minimal(schedule={"type": "once"}))


@pytest.mark.parametrize("value", ["5-5-5", "五-五", "55", ""])
def test_bad_map_format(value) -> None:
    with pytest.raises(SchemaError, match="goal.map"):
        validate_plan({"tasks": [], "goal": {"map": value}})


def test_negative_rank_points() -> None:
    with pytest.raises(SchemaError, match="正の整数"):
        validate_plan({"tasks": [], "goal": {"rank_points": -5}})


def test_bool_is_not_an_integer() -> None:
    with pytest.raises(SchemaError, match="整数"):
        validate_plan({"tasks": [], "goal": {"count": True}})


def test_unknown_efficiency() -> None:
    with pytest.raises(SchemaError, match="resource_efficiency"):
        validate_plan(minimal(optimization={"resource_efficiency": "maximum"}))


def test_unknown_optimization_key() -> None:
    with pytest.raises(SchemaError, match="optimization: 未知のキー"):
        validate_plan(minimal(optimization={"speed": "fast"}))


# ======================================================================
# API へ渡すスキーマ
# ======================================================================


def test_json_schema_rejects_extra_properties() -> None:
    assert PLAN_JSON_SCHEMA["additionalProperties"] is False
    assert PLAN_JSON_SCHEMA["required"] == ["tasks"]


def test_json_schema_enumerates_task_names() -> None:
    names = PLAN_JSON_SCHEMA["properties"]["tasks"]["items"]["properties"]["name"]
    assert "daily" in names["enum"]
    assert "exec_python" not in names["enum"]

"""構造化タスクのスキーマと検証。

開発指示書 §18 の「LLM 出力は必ず schema validation する」を担う。
**このモジュールは LLM を呼ばない。** 外から来た辞書が受け入れ可能な形か
どうかだけを判定する。LLM の出力も、Discord から来た JSON も、テストの
リテラルも、同じここを通る。

許容する語彙は列挙で固定する。「それらしい文字列」を通すと、下流の
タスク実装が知らない値を受け取って、その場で落ちるか、黙って無視するか
のどちらかになる。どちらも避けたい。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

logger = logging.getLogger(__name__)

#: 実行できるタスク名。
TASK_NAMES: frozenset[str] = frozenset(
    {
        "daily",
        "expedition",
        "sortie",
        "advance",
        "supply",
        "repair",
        "construction",
        "dismantle",
    }
)

#: 目標の種類（追加指示書 §6・§7）。
OBJECTIVES: frozenset[str] = frozenset(
    {"destroy_gauge", "farm_rank_points", "clear_map", "farm_drops"}
)

#: 禁止できる行動（追加指示書 §8）。
PROHIBITIONS: frozenset[str] = frozenset(
    {"advance_with_heavy_damage", "use_buckets", "dismantle_ships", "large_build"}
)

#: 資源効率の重み。
EFFICIENCY_LEVELS: frozenset[str] = frozenset({"low", "normal", "high"})

#: 戦法の許可状態。
STRATEGY_STATES: frozenset[str] = frozenset({"allowed", "forbidden"})

#: スケジュールの種類。
SCHEDULE_TYPES: frozenset[str] = frozenset({"once", "daily", "none"})

#: ``5-5`` 形式の海域表記。
MAP_PATTERN = re.compile(r"^\d{1,2}-\d{1,2}$")

#: ``10:52`` 形式の時刻。
TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")

#: ``2026-08-27`` 形式の日付。
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SchemaError(Exception):
    """構造化タスクとして受け入れられない。"""


@dataclass(frozen=True)
class Schedule:
    """実行予定。"""

    type: str = "none"
    time: str | None = None
    date: str | None = None

    @property
    def is_scheduled(self) -> bool:
        """時刻指定があるなら ``True``。"""
        return self.type != "none" and self.time is not None


@dataclass(frozen=True)
class PlannedTask:
    """投入するタスク 1 件。"""

    name: str
    params: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Goal:
    """達成したい目標（追加指示書 §6・§7）。"""

    map: str | None = None
    objective: str | None = None
    rank_points: int | None = None
    count: int | None = None

    @property
    def is_empty(self) -> bool:
        """何も指定されていなければ ``True``。"""
        return all(
            value is None
            for value in (self.map, self.objective, self.rank_points, self.count)
        )


@dataclass(frozen=True)
class Constraints:
    """守るべき制約（追加指示書 §8）。"""

    prohibit: tuple[str, ...] = ()

    def forbids(self, action: str) -> bool:
        """その行動が禁止されていれば ``True``。"""
        return action in self.prohibit


@dataclass(frozen=True)
class TaskPlan:
    """検証済みの構造化タスク。

    ここまで来た値は、下流が知っている語彙だけで構成されている。
    """

    tasks: tuple[PlannedTask, ...] = ()
    schedule: Schedule = Schedule()
    goal: Goal = Goal()
    constraints: Constraints = Constraints()
    resource_efficiency: str = "normal"
    disposable_ship_strategy: str = "forbidden"

    @property
    def is_empty(self) -> bool:
        """実行するものが何も無ければ ``True``。"""
        return not self.tasks and self.goal.is_empty

    def describe(self) -> str:
        """人間向けの要約。"""
        lines: list[str] = []
        if self.schedule.is_scheduled:
            when = f"{self.schedule.date} " if self.schedule.date else ""
            lines.append(f"予定: {self.schedule.type} {when}{self.schedule.time}")
        if self.tasks:
            lines.append("タスク: " + " → ".join(task.name for task in self.tasks))
        if not self.goal.is_empty:
            parts = [
                f"{name}={value}"
                for name, value in (
                    ("map", self.goal.map),
                    ("objective", self.goal.objective),
                    ("rank_points", self.goal.rank_points),
                    ("count", self.goal.count),
                )
                if value is not None
            ]
            lines.append("目標: " + " ".join(parts))
        if self.constraints.prohibit:
            lines.append("禁止: " + ", ".join(self.constraints.prohibit))
        lines.append(f"資源効率: {self.resource_efficiency}")
        lines.append(f"捨て艦戦法: {self.disposable_ship_strategy}")
        return "\n".join(lines)


#: LLM へ渡す JSON Schema。``output_config.format`` にそのまま入れる。
PLAN_JSON_SCHEMA: Mapping[str, Any] = {
    "type": "object",
    "properties": {
        "tasks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "enum": sorted(TASK_NAMES)},
                    "params": {"type": "object"},
                },
                "required": ["name"],
                "additionalProperties": False,
            },
        },
        "schedule": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": sorted(SCHEDULE_TYPES)},
                "time": {"type": ["string", "null"]},
                "date": {"type": ["string", "null"]},
            },
            "required": ["type"],
            "additionalProperties": False,
        },
        "goal": {
            "type": "object",
            "properties": {
                "map": {"type": ["string", "null"]},
                "objective": {
                    "type": ["string", "null"],
                    "enum": sorted(OBJECTIVES) + [None],
                },
                "rank_points": {"type": ["integer", "null"]},
                "count": {"type": ["integer", "null"]},
            },
            "additionalProperties": False,
        },
        "constraints": {
            "type": "object",
            "properties": {
                "prohibit": {
                    "type": "array",
                    "items": {"type": "string", "enum": sorted(PROHIBITIONS)},
                }
            },
            "additionalProperties": False,
        },
        "optimization": {
            "type": "object",
            "properties": {
                "resource_efficiency": {
                    "type": "string",
                    "enum": sorted(EFFICIENCY_LEVELS),
                }
            },
            "additionalProperties": False,
        },
        "strategy_options": {
            "type": "object",
            "properties": {
                "disposable_ship_strategy": {
                    "type": "string",
                    "enum": sorted(STRATEGY_STATES),
                }
            },
            "additionalProperties": False,
        },
    },
    "required": ["tasks"],
    "additionalProperties": False,
}

#: 受け入れるトップレベルのキー。
_TOP_LEVEL_KEYS = frozenset(PLAN_JSON_SCHEMA["properties"])


def _require_mapping(value: Any, where: str) -> Mapping[str, Any]:
    """辞書であることを確かめる。"""
    if not isinstance(value, Mapping):
        raise SchemaError(f"{where}: オブジェクトである必要があります")
    return value


def _reject_unknown(value: Mapping[str, Any], allowed: frozenset[str], where: str) -> None:
    """未知のキーを拒否する。"""
    unknown = set(value) - allowed
    if unknown:
        raise SchemaError(f"{where}: 未知のキー: " + ", ".join(sorted(unknown)))


def _as_optional_int(value: Any, where: str) -> int | None:
    """整数または ``None`` として取り出す。"""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise SchemaError(f"{where}: 整数である必要があります")
    if value <= 0:
        raise SchemaError(f"{where}: 正の整数である必要があります（実際: {value}）")
    return value


def _as_choice(value: Any, allowed: frozenset[str], where: str) -> str:
    """列挙のいずれかとして取り出す。"""
    if not isinstance(value, str) or value not in allowed:
        raise SchemaError(
            f"{where}: {', '.join(sorted(allowed))} のいずれかである必要があります"
            f"（実際: {value!r}）"
        )
    return value


def _validate_schedule(raw: Any) -> Schedule:
    """``schedule`` を検証する。"""
    data = _require_mapping(raw, "schedule")
    _reject_unknown(data, frozenset({"type", "time", "date"}), "schedule")

    schedule_type = _as_choice(data.get("type", "none"), SCHEDULE_TYPES, "schedule.type")
    time_value = data.get("time")
    if time_value is not None:
        if not isinstance(time_value, str) or not TIME_PATTERN.match(time_value):
            raise SchemaError(f"schedule.time: HH:MM 形式が必要です（実際: {time_value!r}）")
    date_value = data.get("date")
    if date_value is not None:
        if not isinstance(date_value, str) or not DATE_PATTERN.match(date_value):
            raise SchemaError(
                f"schedule.date: YYYY-MM-DD 形式が必要です（実際: {date_value!r}）"
            )

    if schedule_type != "none" and time_value is None:
        raise SchemaError(f"schedule.type={schedule_type} には time が必要です")
    return Schedule(type=schedule_type, time=time_value, date=date_value)


def _validate_tasks(raw: Any) -> tuple[PlannedTask, ...]:
    """``tasks`` を検証する。"""
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        raise SchemaError("tasks: 配列である必要があります")

    tasks: list[PlannedTask] = []
    for index, entry in enumerate(raw):
        data = _require_mapping(entry, f"tasks[{index}]")
        _reject_unknown(data, frozenset({"name", "params"}), f"tasks[{index}]")
        name = _as_choice(data.get("name"), TASK_NAMES, f"tasks[{index}].name")
        params = data.get("params") or {}
        _require_mapping(params, f"tasks[{index}].params")
        tasks.append(PlannedTask(name=name, params=dict(params)))
    return tuple(tasks)


def _validate_goal(raw: Any) -> Goal:
    """``goal`` を検証する。"""
    data = _require_mapping(raw, "goal")
    _reject_unknown(
        data, frozenset({"map", "objective", "rank_points", "count"}), "goal"
    )

    map_value = data.get("map")
    if map_value is not None:
        if not isinstance(map_value, str) or not MAP_PATTERN.match(map_value):
            raise SchemaError(f"goal.map: 1-5 のような表記が必要です（実際: {map_value!r}）")

    objective = data.get("objective")
    if objective is not None:
        objective = _as_choice(objective, OBJECTIVES, "goal.objective")

    return Goal(
        map=map_value,
        objective=objective,
        rank_points=_as_optional_int(data.get("rank_points"), "goal.rank_points"),
        count=_as_optional_int(data.get("count"), "goal.count"),
    )


def _validate_constraints(raw: Any) -> Constraints:
    """``constraints`` を検証する。"""
    data = _require_mapping(raw, "constraints")
    _reject_unknown(data, frozenset({"prohibit"}), "constraints")

    prohibit = data.get("prohibit") or []
    if not isinstance(prohibit, Sequence) or isinstance(prohibit, (str, bytes)):
        raise SchemaError("constraints.prohibit: 配列である必要があります")
    return Constraints(
        prohibit=tuple(
            _as_choice(entry, PROHIBITIONS, "constraints.prohibit[]")
            for entry in prohibit
        )
    )


def validate_plan(raw: Any) -> TaskPlan:
    """外から来た辞書を :class:`TaskPlan` へ変換する。

    Args:
        raw: 検証対象。LLM の出力、外部から届いた JSON など。

    Returns:
        検証済みの計画。

    Raises:
        SchemaError: 受け入れられない場合。未知のキー、未知の語彙、
            型の不一致はすべてここで弾く。
    """
    data = _require_mapping(raw, "計画")
    _reject_unknown(data, _TOP_LEVEL_KEYS, "計画")

    if "tasks" not in data:
        raise SchemaError("計画: tasks は必須です")

    optimization = _require_mapping(data.get("optimization", {}), "optimization")
    _reject_unknown(optimization, frozenset({"resource_efficiency"}), "optimization")
    strategy = _require_mapping(data.get("strategy_options", {}), "strategy_options")
    _reject_unknown(
        strategy, frozenset({"disposable_ship_strategy"}), "strategy_options"
    )

    plan = TaskPlan(
        tasks=_validate_tasks(data["tasks"]),
        schedule=_validate_schedule(data.get("schedule", {})),
        goal=_validate_goal(data.get("goal", {})),
        constraints=_validate_constraints(data.get("constraints", {})),
        resource_efficiency=_as_choice(
            optimization.get("resource_efficiency", "normal"),
            EFFICIENCY_LEVELS,
            "optimization.resource_efficiency",
        ),
        disposable_ship_strategy=_as_choice(
            strategy.get("disposable_ship_strategy", "forbidden"),
            STRATEGY_STATES,
            "strategy_options.disposable_ship_strategy",
        ),
    )

    if plan.is_empty:
        raise SchemaError("計画: 実行するタスクも目標もありません")

    logger.info("計画を受理しました: %s", plan.describe().replace("\n", " / "))
    return plan

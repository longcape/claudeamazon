"""キュー上のタスクを、実行できる :class:`~tasks.base_task.BaseTask` にする。

:class:`~core.task_queue.Task` は「名前と payload」しか持たない。予約から
来たものも、LLM 由来の計画から来たものも、Discord から来たものも同じ形に
なる。そこから実際のタスク実装を組み立てるのがここ。

**payload の未知のキーは無視する。** 制約や目標のように、全タスクへ一律に
載せている項目があるため。逆に、実行に必要な項目が欠けている場合は
:class:`TaskBuildError` にする。既定値で埋めて動かすと、意図しない艦隊で
出撃しうる。
"""

from __future__ import annotations

import logging
from typing import Any, Mapping, Sequence

from core.task_queue import Task
from tasks.base_task import BaseTask
from tasks.construction_task import ConstructionTask, Recipe
from tasks.daily_task import DailyTask
from tasks.dismantle_task import DismantleTask
from tasks.expedition_task import ExpeditionTask
from tasks.sortie_task import SortieTask

logger = logging.getLogger(__name__)

#: 艦隊を指定しなかった場合の既定値。
DEFAULT_SORTIE_FLEET = 1
DEFAULT_EXPEDITION_FLEET = 2


class TaskBuildError(Exception):
    """payload からタスクを組み立てられなかった。"""


def _as_int(payload: Mapping[str, Any], key: str, default: int | None = None) -> int:
    """payload から整数を取り出す。

    Raises:
        TaskBuildError: 欠けている、または整数でない場合。
    """
    value = payload.get(key, default)
    if value is None:
        raise TaskBuildError(f"{key} が指定されていません")
    if isinstance(value, bool) or not isinstance(value, int):
        try:
            return int(str(value))
        except ValueError as exc:
            raise TaskBuildError(f"{key} が整数ではありません: {value!r}") from exc
    return value


def parse_map(payload: Mapping[str, Any]) -> tuple[int, int]:
    """payload から海域を取り出す。

    ``{"map": "1-5"}`` と ``{"map_area": 1, "map_no": 5}`` の両方を受ける。

    Raises:
        TaskBuildError: 海域を決められない場合。
    """
    label = payload.get("map")
    if isinstance(label, str) and "-" in label:
        area, _, number = label.partition("-")
        try:
            return int(area), int(number)
        except ValueError as exc:
            raise TaskBuildError(f"海域の指定が不正です: {label!r}") from exc
    if "map_area" in payload and "map_no" in payload:
        return _as_int(payload, "map_area"), _as_int(payload, "map_no")
    raise TaskBuildError("出撃先が指定されていません（map または map_area/map_no）")


def _build_sortie(payload: Mapping[str, Any]) -> BaseTask:
    """出撃タスクを組み立てる。"""
    area, number = parse_map(payload)
    return SortieTask(
        fleet_id=_as_int(payload, "fleet_id", DEFAULT_SORTIE_FLEET),
        map_area=area,
        map_no=number,
    )


def _build_expedition(payload: Mapping[str, Any]) -> BaseTask:
    """遠征タスクを組み立てる。"""
    return ExpeditionTask(
        fleet_id=_as_int(payload, "fleet_id", DEFAULT_EXPEDITION_FLEET),
        mission_id=_as_int(payload, "mission_id"),
    )


def _build_daily(payload: Mapping[str, Any]) -> BaseTask:
    """デイリー確認タスクを組み立てる。"""
    quest_ids = payload.get("quest_ids") or ()
    if not isinstance(quest_ids, Sequence) or isinstance(quest_ids, (str, bytes)):
        raise TaskBuildError("quest_ids は配列である必要があります")
    return DailyTask([int(quest_id) for quest_id in quest_ids])


def _build_construction(payload: Mapping[str, Any]) -> BaseTask:
    """建造タスクを組み立てる。"""
    raw = payload.get("recipe")
    if raw is None:
        recipe = Recipe()
    elif isinstance(raw, Mapping):
        recipe = Recipe(
            fuel=int(raw.get("fuel", 30)),
            ammo=int(raw.get("ammo", 30)),
            steel=int(raw.get("steel", 30)),
            bauxite=int(raw.get("bauxite", 30)),
        )
    elif isinstance(raw, Sequence) and not isinstance(raw, (str, bytes)):
        if len(raw) != 4:
            raise TaskBuildError("recipe は 4 つの数値である必要があります")
        recipe = Recipe(*(int(value) for value in raw))
    else:
        raise TaskBuildError(f"recipe の形式が不正です: {raw!r}")

    dock_id = payload.get("dock_id")
    return ConstructionTask(
        recipe, dock_id=int(dock_id) if dock_id is not None else None
    )


def _build_dismantle(payload: Mapping[str, Any]) -> BaseTask:
    """解体タスクを組み立てる。"""
    ship_ids = payload.get("ship_ids") or ()
    if not isinstance(ship_ids, Sequence) or isinstance(ship_ids, (str, bytes)):
        raise TaskBuildError("ship_ids は配列である必要があります")
    if not ship_ids:
        raise TaskBuildError("解体候補が指定されていません")
    return DismantleTask([int(ship_id) for ship_id in ship_ids])


#: タスク名と組み立て関数の対応。
BUILDERS = {
    "sortie": _build_sortie,
    "expedition": _build_expedition,
    "daily": _build_daily,
    "construction": _build_construction,
    "dismantle": _build_dismantle,
}


def build_task(task: Task) -> BaseTask:
    """キュー上のタスクから実装を組み立てる。

    Args:
        task: キューから取り出したタスク。

    Returns:
        実行できるタスク。

    Raises:
        TaskBuildError: 未知の名前、または payload が足りない場合。
    """
    builder = BUILDERS.get(task.name)
    if builder is None:
        raise TaskBuildError(
            f"未知のタスクです: {task.name}"
            f"（使えるのは {', '.join(sorted(BUILDERS))}）"
        )
    built = builder(task.payload)
    logger.debug("タスクを組み立てました: %s", task.describe())
    return built

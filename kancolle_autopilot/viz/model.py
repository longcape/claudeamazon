"""可視化に渡すデータを組み立てる。

追加指示書 §9・§14・§16 が求める表示（Game View / AI Decision View /
GameState View / Event Log / Timeline）の材料を、HTML から扱いやすい形に
まとめる。**ここでは描画しない。** 描画は :mod:`viz.report` の仕事。

分けているのは、何を見せるかと、どう見せるかを別々に直せるようにする
ため。表示の体裁を変えるたびに、状態の要約まで触りたくない。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from automation.interface import Screen
from automation.screen_detector import (
    LAYOUT,
    IndexedTarget,
    Region,
    StaticTarget,
)
from monitor.game_state import GameState
from recording.decision_log import Decision
from recording.timeline import Timeline, TimelineEvent
from sandbox.environment import SHIP_LIST_ORIGIN, SHIP_LIST_STEP_Y

logger = logging.getLogger(__name__)

#: 画面の描画サイズ。配置表がこの範囲に収まる想定。
SCREEN_WIDTH = 760
SCREEN_HEIGHT = 560


def screen_widgets(screen: Screen) -> list[dict[str, Any]]:
    """その画面にある操作対象と位置を返す。

    番号付きの対象は展開する。艦一覧のように動的に置かれるものは、
    サンドボックスの原点をもとに枠だけ示す（中身は実行時にしか
    決まらない）。
    """
    widgets: list[dict[str, Any]] = []

    def add(name: str, region: Region, kind: str = "static") -> None:
        widgets.append(
            {
                "name": name,
                "x": region.x,
                "y": region.y,
                "w": region.width,
                "h": region.height,
                "kind": kind,
            }
        )

    for (where, prefix), entry in LAYOUT.items():
        if where is not screen:
            continue
        if isinstance(entry, StaticTarget):
            add(prefix, entry.region)
            continue
        for index in range(1, entry.count + 1):
            region = entry.resolve(str(index))
            if region is not None:
                add(f"{prefix}_{index}", region, "indexed")

    origin = SHIP_LIST_ORIGIN.get(screen)
    if origin is not None:
        for index in range(4):
            add(f"（艦一覧 {index + 1}）", origin.shifted(0, index * SHIP_LIST_STEP_Y), "list")

    return sorted(widgets, key=lambda widget: (widget["y"], widget["x"]))


def all_screens() -> dict[str, list[dict[str, Any]]]:
    """すべての画面の配置を返す。"""
    return {
        screen.value: screen_widgets(screen)
        for screen in Screen
        if screen_widgets(screen)
    }


def event_view(index: int, event: TimelineEvent) -> dict[str, Any]:
    """タイムラインの 1 件を、表示用の辞書にする。"""
    return {
        "i": index,
        "kind": event.kind.value,
        "label": event.label,
        "at": event.at.isoformat(),
        "ms": event.at.timestamp() * 1000.0,
        "task_id": event.task_id,
        "screen": event.screen,
        "detail": {key: str(value) for key, value in event.detail.items()},
    }


def decision_view(decision: Decision) -> dict[str, Any]:
    """判断 1 件を表示用にする。"""
    return {
        "decision": decision.decision,
        "reason_code": decision.reason_code,
        "constraints": list(decision.constraints),
        "selected_action": decision.selected_action,
        "expected": decision.expected_result,
        "actual": decision.actual_result,
        "matched": decision.matched_expectation,
        "task_id": decision.task_id,
        "at": decision.at.isoformat(),
        "ms": decision.at.timestamp() * 1000.0,
        "input": {key: str(value) for key, value in decision.input_state_summary.items()},
    }


def snapshot_view(state: GameState) -> dict[str, Any]:
    """状態のスナップショットを表示用にする。

    全部を出すと読めないので、判断に効く面だけを並べる。詳しく見たい
    ときは記録そのものを当たる。
    """
    resources = state.resources
    return {
        "資材": {
            "燃料": resources.fuel,
            "弾薬": resources.ammo,
            "鋼材": resources.steel,
            "ボーキ": resources.bauxite,
            "バケツ": resources.buckets,
        },
        "艦": [
            {
                "id": ship.instance_id,
                "lv": ship.level,
                "hp": f"{ship.hp}/{ship.max_hp}",
                "状態": ship.damage_state.label,
                "cond": ship.cond,
                "ロック": {True: "済", False: "未", None: "不明"}[ship.locked],
            }
            for ship in sorted(state.ships.values(), key=lambda s: s.instance_id)
        ],
        "艦隊": {
            f"第{fleet.fleet_id}": {
                "編成": fleet.ship_ids,
                "遠征": fleet.mission.mission_id if fleet.mission.is_active else None,
            }
            for fleet in sorted(state.fleets.values(), key=lambda f: f.fleet_id)
        },
        "出撃": state.sortie.map_label if state.sortie else None,
        "直近ドロップ": state.last_drop.name if state.last_drop else None,
    }


@dataclass(frozen=True)
class ReportData:
    """レポートに埋め込むデータ一式。"""

    title: str
    events: list[dict[str, Any]]
    decisions: list[dict[str, Any]]
    screens: dict[str, list[dict[str, Any]]]
    snapshots: dict[str, dict[str, Any]]

    @property
    def counts(self) -> dict[str, int]:
        """種別ごとの件数。"""
        counts: dict[str, int] = {}
        for event in self.events:
            counts[event["kind"]] = counts.get(event["kind"], 0) + 1
        return counts

    @property
    def mismatched(self) -> int:
        """期待と結果がずれた判断の数。"""
        return sum(1 for entry in self.decisions if entry["matched"] is False)

    def to_dict(self) -> dict[str, Any]:
        """埋め込む JSON。"""
        return {
            "title": self.title,
            "events": self.events,
            "decisions": self.decisions,
            "screens": self.screens,
            "snapshots": self.snapshots,
            "width": SCREEN_WIDTH,
            "height": SCREEN_HEIGHT,
        }


def build_data(
    timeline: Timeline,
    decisions: Sequence[Decision] = (),
    snapshots: Mapping[int, GameState] | None = None,
    title: str = "セッション記録",
) -> ReportData:
    """記録から表示用のデータを組み立てる。"""
    return ReportData(
        title=title,
        events=[event_view(index, event) for index, event in enumerate(timeline)],
        decisions=[decision_view(decision) for decision in decisions],
        screens=all_screens(),
        snapshots={
            str(index): snapshot_view(state)
            for index, state in (snapshots or {}).items()
        },
    )

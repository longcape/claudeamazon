"""イベントを適用してゲームの現在状態を再構築する。

:class:`GameState` は「今どうなっているか」だけを持つ。操作の判断は
一切行わず、安全判定は :mod:`safety` 配下、実行判断は Task 側が担う
（開発指示書 §4「GUI 操作モジュールから直接ゲーム判断を行ってはいけない」）。

履歴に依存する判断はここで行い、**派生イベント**として返す。

* 母港へ戻った → :attr:`~monitor.api_parser.EventType.SORTIE_ENDED`
* 未所持艦がドロップした →
  :attr:`~monitor.api_parser.EventType.UNKNOWN_SHIP_DROPPED`

``apply`` の戻り値は派生イベントのリストで、呼び出し側（Phase 2 の
イベントバス）がそのまま再配信できる形にしている。
"""

from __future__ import annotations

import copy
import logging
from dataclasses import dataclass, field, replace as dataclass_replace
from datetime import datetime, timedelta
from typing import Any, Iterable, Mapping, Sequence

from core.state import (
    BuildDock,
    DamageState,
    DropRecord,
    Fleet,
    PlayerInfo,
    Quest,
    RepairDock,
    Resources,
    Ship,
    Sortie,
    utcnow,
)
from monitor.api_parser import Event, EventType

logger = logging.getLogger(__name__)


@dataclass
class GameState:
    """ゲームの現在状態。

    Attributes:
        encyclopedia_master_ids: 所持したことがある艦種マスタ ID。
            未所持艦判定に使う。所有艦一覧から自動的に育つが、
            過去に解体した艦は含まれないため「未所持」と誤判定しうる。
            誤判定の向きは常に「保護しすぎる側」で、保護漏れは起きない。
    """

    resources: Resources = field(default_factory=Resources)
    ships: dict[int, Ship] = field(default_factory=dict)
    fleets: dict[int, Fleet] = field(default_factory=dict)
    repair_docks: dict[int, RepairDock] = field(default_factory=dict)
    build_docks: dict[int, BuildDock] = field(default_factory=dict)
    quests: dict[int, Quest] = field(default_factory=dict)
    player: PlayerInfo = field(default_factory=PlayerInfo)
    sortie: Sortie | None = None
    last_drop: DropRecord | None = None
    last_expedition_result: dict[str, Any] | None = None
    encyclopedia_master_ids: set[int] = field(default_factory=set)
    last_event_at: datetime | None = None
    last_resource_update_at: datetime | None = None

    # ------------------------------------------------------------------
    # 適用
    # ------------------------------------------------------------------

    def apply(self, event: Event) -> list[Event]:
        """イベントを 1 件適用する。

        Args:
            event: :mod:`monitor.api_parser` が生成したイベント。

        Returns:
            適用の結果として導出された派生イベント（無ければ空リスト）。
        """
        handler = _HANDLERS.get(event.type)
        self.last_event_at = event.occurred_at
        if handler is None:
            logger.debug("状態へ反映しないイベントです: %s", event.type)
            return []
        try:
            return handler(self, event)
        except Exception:  # noqa: BLE001 - 監視プロセスを落とさない
            logger.exception("状態更新に失敗しました: %s", event.type)
            return []

    def apply_all(self, events: Iterable[Event]) -> list[Event]:
        """イベント列をまとめて適用する。

        Returns:
            すべての派生イベントを順に並べたリスト。
        """
        derived: list[Event] = []
        for event in events:
            derived.extend(self.apply(event))
        return derived

    def snapshot(self) -> "GameState":
        """現在状態のディープコピーを返す（§15 の State Snapshot 用）。"""
        return copy.deepcopy(self)

    # ------------------------------------------------------------------
    # 問い合わせ
    # ------------------------------------------------------------------

    def is_known_master(self, master_id: int | None) -> bool | None:
        """艦種を所持したことがあるか。

        Args:
            master_id: 艦種マスタ ID。

        Returns:
            所持済みなら ``True``、未所持なら ``False``。
            ``master_id`` が不明な場合は判定不能を表す ``None``。
        """
        if master_id is None:
            return None
        return master_id in self.encyclopedia_master_ids

    def fleet_ships(self, fleet_id: int) -> list[Ship | None]:
        """艦隊に編成されている艦を並び順で返す。

        Returns:
            艦のリスト。編成 ID に対応する艦が未取得の場合は
            その位置が ``None`` になる（状態不明を潰さないため）。
        """
        fleet = self.fleets.get(fleet_id)
        if fleet is None:
            return []
        return [self.ships.get(ship_id) for ship_id in fleet.ship_ids]

    def heavily_damaged_ships(self, fleet_id: int | None = None) -> list[Ship]:
        """大破している艦を返す。

        Args:
            fleet_id: 艦隊を指定する場合はその ID。``None`` なら全所有艦。
        """
        if fleet_id is None:
            targets: Iterable[Ship | None] = self.ships.values()
        else:
            targets = self.fleet_ships(fleet_id)
        return [
            ship
            for ship in targets
            if ship is not None and ship.damage_state is DamageState.HEAVY
        ]

    def unknown_damage_ships(self, fleet_id: int) -> list[int]:
        """損傷状態が判定できない艦の編成 ID を返す。

        艦データが未取得の場合も含む。安全判定側はこれが空でない限り
        「艦隊の状態を把握できていない」と扱うべき。
        """
        fleet = self.fleets.get(fleet_id)
        if fleet is None:
            return []
        unknown: list[int] = []
        for ship_id in fleet.ship_ids:
            ship = self.ships.get(ship_id)
            if ship is None or ship.is_damage_unknown:
                unknown.append(ship_id)
        return unknown

    def is_stale(self, max_age_seconds: float, now: datetime | None = None) -> bool:
        """一定時間イベントが来ていないなら ``True``。

        一度もイベントを受け取っていない場合も ``True`` を返す
        （「状態不明」を正常とみなさないため）。
        """
        if self.last_event_at is None:
            return True
        current = now or utcnow()
        return current - self.last_event_at > timedelta(seconds=max_age_seconds)

    def seed_encyclopedia(self, master_ids: Iterable[int]) -> None:
        """既知の艦種マスタ ID を外部から追加する。

        解体済みの艦を「未所持」と誤判定しないよう、永続化した図鑑
        情報を起動時に流し込むための入口。
        """
        self.encyclopedia_master_ids.update(
            master_id for master_id in master_ids if master_id is not None
        )

    # ------------------------------------------------------------------
    # 内部ヘルパ
    # ------------------------------------------------------------------

    def _merge_ship(self, incoming: Ship) -> None:
        """既存の艦へ差分をマージする（``None`` の項目は上書きしない）。"""
        current = self.ships.get(incoming.instance_id)
        if current is None:
            self.ships[incoming.instance_id] = incoming
        else:
            merged = dataclass_replace(
                current,
                **{
                    name: value
                    for name, value in vars(incoming).items()
                    if value is not None and name != "instance_id"
                },
            )
            self.ships[incoming.instance_id] = merged
        if incoming.master_id is not None:
            self.encyclopedia_master_ids.add(incoming.master_id)


# ----------------------------------------------------------------------
# イベント種別ごとの適用処理
# ----------------------------------------------------------------------


def _apply_resources(state: GameState, event: Event) -> list[Event]:
    updates = event.payload.get("resources") or {}
    if not updates:
        return []
    state.resources = state.resources.merged_with(updates)
    state.last_resource_update_at = event.occurred_at
    return []


def _apply_player(state: GameState, event: Event) -> list[Event]:
    incoming = event.payload.get("player")
    if not isinstance(incoming, PlayerInfo):
        return []
    state.player = dataclass_replace(
        state.player,
        **{
            name: value
            for name, value in vars(incoming).items()
            if value is not None
        },
    )
    return []


def _apply_ships(state: GameState, event: Event) -> list[Event]:
    ships = event.payload.get("ships") or []
    if not isinstance(ships, Sequence):
        return []

    if event.payload.get("replace"):
        incoming = {ship.instance_id: ship for ship in ships}
        removed = sorted(set(state.ships) - set(incoming))
        state.ships = incoming
        for ship in ships:
            if ship.master_id is not None:
                state.encyclopedia_master_ids.add(ship.master_id)
        if removed:
            logger.info("所有艦から消えた艦を検出しました: %s", removed)
            return [
                Event(
                    EventType.SHIP_REMOVED,
                    {"ship_ids": removed, "reason": "not_in_port_list"},
                    event.occurred_at,
                    event.source_path,
                )
            ]
        return []

    for ship in ships:
        state._merge_ship(ship)
    return []


def _apply_ship_removed(state: GameState, event: Event) -> list[Event]:
    for ship_id in event.payload.get("ship_ids") or []:
        state.ships.pop(ship_id, None)
    return []


def _apply_fleets(state: GameState, event: Event) -> list[Event]:
    for fleet in event.payload.get("fleets") or []:
        if isinstance(fleet, Fleet):
            state.fleets[fleet.fleet_id] = fleet
    return []


def _apply_repair_docks(state: GameState, event: Event) -> list[Event]:
    for dock in event.payload.get("repair_docks") or []:
        if isinstance(dock, RepairDock):
            state.repair_docks[dock.dock_id] = dock
    return []


def _apply_construction(state: GameState, event: Event) -> list[Event]:
    for dock in event.payload.get("build_docks") or []:
        if isinstance(dock, BuildDock):
            state.build_docks[dock.dock_id] = dock
    return []


def _apply_quests(state: GameState, event: Event) -> list[Event]:
    # 任務一覧はページ単位で届くため、置き換えずに ID でマージする。
    for quest in event.payload.get("quests") or []:
        if isinstance(quest, Quest):
            state.quests[quest.quest_id] = quest
    return []


def _apply_sortie_started(state: GameState, event: Event) -> list[Event]:
    map_area = event.payload.get("map_area")
    map_no = event.payload.get("map_no")
    if map_area is None or map_no is None:
        return []
    if state.sortie is not None and state.sortie.is_active:
        logger.warning(
            "前回の出撃が終了しないまま新しい出撃を検出しました: %s",
            state.sortie.map_label,
        )
    state.sortie = Sortie(
        map_area=map_area,
        map_no=map_no,
        started_at=event.occurred_at,
        cell_no=event.payload.get("cell_no"),
        boss_cell_no=event.payload.get("boss_cell_no"),
    )
    return []


def _apply_map_advanced(state: GameState, event: Event) -> list[Event]:
    if state.sortie is None or not state.sortie.is_active:
        logger.warning("出撃中でないのに進撃イベントを受け取りました")
        return []
    state.sortie.cell_no = event.payload.get("cell_no", state.sortie.cell_no)
    boss_cell = event.payload.get("boss_cell_no")
    if boss_cell is not None:
        state.sortie.boss_cell_no = boss_cell
    return []


def _apply_port_refreshed(state: GameState, event: Event) -> list[Event]:
    # 母港応答が来た＝出撃は終了している。
    if state.sortie is None or not state.sortie.is_active:
        return []
    state.sortie.ended_at = event.occurred_at
    return [
        Event(
            EventType.SORTIE_ENDED,
            {
                "map_area": state.sortie.map_area,
                "map_no": state.sortie.map_no,
                "map_label": state.sortie.map_label,
                "started_at": state.sortie.started_at,
            },
            event.occurred_at,
            event.source_path,
        )
    ]


def _apply_drop(state: GameState, event: Event) -> list[Event]:
    master_id = event.payload.get("master_id")
    is_new: bool | None
    known = state.is_known_master(master_id)
    is_new = None if known is None else not known

    state.last_drop = DropRecord(
        master_id=master_id,
        name=event.payload.get("name"),
        ship_type=event.payload.get("ship_type"),
        occurred_at=event.occurred_at,
        is_new=is_new,
    )

    if is_new is False:
        return []

    # 未所持（True）と判定不能（None）はどちらも通常ルーチンを止める。
    # 判定不能を「所持済み」に倒すと保護漏れになるため、同じ扱いにする。
    logger.info(
        "保護が必要なドロップを検出しました: master_id=%s name=%s is_new=%s",
        master_id,
        event.payload.get("name"),
        is_new,
    )
    return [
        Event(
            EventType.UNKNOWN_SHIP_DROPPED,
            {
                "master_id": master_id,
                "name": event.payload.get("name"),
                "ship_type": event.payload.get("ship_type"),
                "is_new": is_new,
            },
            event.occurred_at,
            event.source_path,
        )
    ]


def _apply_expedition_completed(state: GameState, event: Event) -> list[Event]:
    state.last_expedition_result = dict(event.payload)
    materials = event.payload.get("materials") or {}
    if materials:
        # 遠征報酬は「増加量」ではなく受領後の値ではないため、
        # 資材の絶対値は次の母港応答で確定させる。ここでは記録のみ。
        logger.debug("遠征報酬を記録しました: %s", materials)
    return []


_HANDLERS: Mapping[EventType, Any] = {
    EventType.RESOURCE_UPDATED: _apply_resources,
    EventType.PLAYER_UPDATED: _apply_player,
    EventType.SHIP_UPDATED: _apply_ships,
    EventType.SHIP_REMOVED: _apply_ship_removed,
    EventType.FLEET_UPDATED: _apply_fleets,
    EventType.REPAIR_DOCK_UPDATED: _apply_repair_docks,
    EventType.CONSTRUCTION_UPDATED: _apply_construction,
    EventType.MISSION_UPDATED: _apply_quests,
    EventType.SORTIE_STARTED: _apply_sortie_started,
    EventType.MAP_ADVANCED: _apply_map_advanced,
    EventType.PORT_REFRESHED: _apply_port_refreshed,
    EventType.DROP_DETECTED: _apply_drop,
    EventType.EXPEDITION_COMPLETED: _apply_expedition_completed,
}

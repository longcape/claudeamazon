"""GameState のテスト。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from tests.helpers import load_fixture
from core.state import DamageState, FleetMissionState, Ship
from monitor.api_parser import APIParser, Event, EventType
from monitor.game_state import GameState

T0 = datetime(2024, 1, 1, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def parser() -> APIParser:
    return APIParser()


@pytest.fixture
def state_at_port(parser: APIParser) -> GameState:
    """母港応答を 1 回適用した状態（受信時刻を T0 に固定）。"""
    state = GameState(clock=lambda: T0)
    state.apply_all(parser.parse_record(load_fixture("port.json"), T0))
    return state


def feed(state: GameState, parser: APIParser, name: str, when: datetime) -> list[Event]:
    """フィクスチャを 1 件適用し、派生イベントを返す。"""
    return state.apply_all(parser.parse_record(load_fixture(name), when))


# -- 状態の再構築 ---------------------------------------------------------


def test_port_rebuilds_resources(state_at_port: GameState) -> None:
    assert state_at_port.resources.fuel == 25000
    assert state_at_port.resources.buckets == 120
    assert state_at_port.resources.is_complete is True


def test_port_rebuilds_ships(state_at_port: GameState) -> None:
    assert set(state_at_port.ships) == {101, 102, 103}
    assert state_at_port.ships[103].damage_state is DamageState.HEAVY
    assert state_at_port.ships[101].damage_state is DamageState.NORMAL


def test_port_rebuilds_fleets(state_at_port: GameState) -> None:
    assert state_at_port.fleets[1].ship_ids == [101, 103]
    assert state_at_port.fleets[2].mission.state is FleetMissionState.UNDERWAY


def test_port_records_encyclopedia(state_at_port: GameState) -> None:
    """所有艦の艦種は「所持済み」として記録される。"""
    assert state_at_port.encyclopedia_master_ids == {131, 2, 20}


def test_fleet_ships_keeps_position_for_missing_ship(
    state_at_port: GameState,
) -> None:
    """艦データが欠けていても編成位置を潰さない。"""
    del state_at_port.ships[103]
    assert state_at_port.fleet_ships(1) == [state_at_port.ships[101], None]


def test_heavily_damaged_ships(state_at_port: GameState) -> None:
    assert [ship.instance_id for ship in state_at_port.heavily_damaged_ships(1)] == [103]
    assert state_at_port.heavily_damaged_ships(2) == []


def test_unknown_damage_ships_includes_missing_ship(
    state_at_port: GameState,
) -> None:
    del state_at_port.ships[103]
    assert state_at_port.unknown_damage_ships(1) == [103]


# -- 差分更新 -------------------------------------------------------------


def test_partial_ship_update_does_not_erase_known_fields(
    state_at_port: GameState,
) -> None:
    """``None`` の項目で既存値を上書きしない。"""
    state_at_port.apply(
        Event(
            EventType.SHIP_UPDATED,
            {"ships": [Ship(instance_id=101, hp=45)], "replace": False},
            T0,
        )
    )
    ship = state_at_port.ships[101]
    assert ship.hp == 45
    assert ship.level == 99
    assert ship.locked is True


def test_replace_emits_ship_removed_for_disappeared_ships(
    state_at_port: GameState,
) -> None:
    """母港一覧から消えた艦を検出する（解体・改装消滅の検知）。"""
    derived = state_at_port.apply(
        Event(
            EventType.SHIP_UPDATED,
            {"ships": [Ship(instance_id=101, master_id=131)], "replace": True},
            T0,
        )
    )
    assert len(derived) == 1
    assert derived[0].type is EventType.SHIP_REMOVED
    assert derived[0].payload["ship_ids"] == [102, 103]


def test_destroyship_removes_ship(
    state_at_port: GameState, parser: APIParser
) -> None:
    feed(state_at_port, parser, "destroyship.json", T0)
    assert 102 not in state_at_port.ships


def test_questlist_merges_across_pages(state_at_port: GameState) -> None:
    """任務はページ単位で届くため、置き換えずにマージする。"""
    from core.state import Quest, QuestState

    state_at_port.apply(
        Event(EventType.MISSION_UPDATED, {"quests": [Quest(quest_id=201)]}, T0)
    )
    state_at_port.apply(
        Event(
            EventType.MISSION_UPDATED,
            {"quests": [Quest(quest_id=402, state=QuestState.IN_PROGRESS)]},
            T0,
        )
    )
    assert set(state_at_port.quests) == {201, 402}


# -- 出撃 -----------------------------------------------------------------


def test_sortie_lifecycle(state_at_port: GameState, parser: APIParser) -> None:
    """出撃開始 → 母港応答で SORTIE_ENDED が導出される。"""
    feed(state_at_port, parser, "map_start.json", T0 + timedelta(seconds=10))
    assert state_at_port.sortie is not None
    assert state_at_port.sortie.map_label == "5-5"
    assert state_at_port.sortie.is_active is True

    derived = feed(state_at_port, parser, "port.json", T0 + timedelta(minutes=5))
    ended = [event for event in derived if event.type is EventType.SORTIE_ENDED]
    assert len(ended) == 1
    assert ended[0].payload["map_label"] == "5-5"
    assert state_at_port.sortie.is_active is False


def test_port_without_active_sortie_emits_nothing(
    state_at_port: GameState, parser: APIParser
) -> None:
    derived = feed(state_at_port, parser, "port.json", T0 + timedelta(minutes=1))
    assert [event for event in derived if event.type is EventType.SORTIE_ENDED] == []


def test_map_advance_updates_cell(state_at_port: GameState, parser: APIParser) -> None:
    feed(state_at_port, parser, "map_start.json", T0)
    state_at_port.apply(
        Event(EventType.MAP_ADVANCED, {"cell_no": 15, "boss_cell_no": 15}, T0)
    )
    assert state_at_port.sortie.cell_no == 15
    assert state_at_port.sortie.at_boss is True


# -- ドロップ保護 ---------------------------------------------------------


def test_unknown_drop_emits_protection_event(
    state_at_port: GameState, parser: APIParser
) -> None:
    """未所持艦のドロップは保護イベントを生む。"""
    derived = feed(state_at_port, parser, "battleresult_drop.json", T0)
    protection = [
        event for event in derived if event.type is EventType.UNKNOWN_SHIP_DROPPED
    ]
    assert len(protection) == 1
    assert protection[0].payload["is_new"] is True
    assert state_at_port.last_drop.is_new is True


def test_known_drop_emits_no_protection_event(
    state_at_port: GameState, parser: APIParser
) -> None:
    derived = feed(state_at_port, parser, "battleresult_known_drop.json", T0)
    assert [
        event for event in derived if event.type is EventType.UNKNOWN_SHIP_DROPPED
    ] == []
    assert state_at_port.last_drop.is_new is False


def test_undecidable_drop_is_treated_as_needing_protection(
    state_at_port: GameState,
) -> None:
    """艦種が特定できないドロップは「所持済み」に倒さない。"""
    derived = state_at_port.apply(
        Event(EventType.DROP_DETECTED, {"master_id": None, "name": None}, T0)
    )
    assert len(derived) == 1
    assert derived[0].type is EventType.UNKNOWN_SHIP_DROPPED
    assert derived[0].payload["is_new"] is None
    assert state_at_port.last_drop.is_new is None


def test_is_known_master_returns_none_for_unknown_input(
    state_at_port: GameState,
) -> None:
    assert state_at_port.is_known_master(None) is None
    assert state_at_port.is_known_master(131) is True
    assert state_at_port.is_known_master(999) is False


def test_seed_encyclopedia_prevents_false_new_drop(
    state_at_port: GameState, parser: APIParser
) -> None:
    """図鑑情報を流し込めば、過去に解体した艦を誤検知しない。"""
    state_at_port.seed_encyclopedia([543])
    derived = feed(state_at_port, parser, "battleresult_drop.json", T0)
    assert [
        event for event in derived if event.type is EventType.UNKNOWN_SHIP_DROPPED
    ] == []


# -- 鮮度・スナップショット -----------------------------------------------


def test_is_stale_when_no_events() -> None:
    """一度もイベントが無い状態は「不明」であり stale 扱い。"""
    assert GameState().is_stale(300, T0) is True


def test_is_stale_uses_receive_time_not_log_timestamp(parser: APIParser) -> None:
    """古い時刻を主張するログでも、受信していれば stale にしない。

    専ブラの時計がずれていたり、過去ログを再生したりしたときに
    誤って緊急停止しないようにするため。
    """
    old = datetime(2020, 1, 1, tzinfo=timezone.utc)
    state = GameState(clock=lambda: T0)
    state.apply_all(parser.parse_record(load_fixture("port.json"), old))
    assert state.last_event_at == old
    assert state.last_observed_at == T0
    assert state.is_stale(300, T0) is False


def test_is_stale_boundary(state_at_port: GameState) -> None:
    assert state_at_port.is_stale(300, T0 + timedelta(seconds=299)) is False
    assert state_at_port.is_stale(300, T0 + timedelta(seconds=301)) is True


def test_snapshot_is_independent(state_at_port: GameState) -> None:
    snapshot = state_at_port.snapshot()
    state_at_port.ships[101].level = 1
    assert snapshot.ships[101].level == 99


def test_apply_never_raises_on_broken_payload(state_at_port: GameState) -> None:
    """壊れたペイロードでも監視プロセスを落とさない。"""
    assert state_at_port.apply(Event(EventType.FLEET_UPDATED, {"fleets": 5}, T0)) == []
    assert state_at_port.apply(Event(EventType.SHIP_UPDATED, {"ships": None}, T0)) == []

"""APIParser のテスト。"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from tests.helpers import load_fixture, load_fixture_text
from core.state import FleetMissionState, QuestState, ResourceKind
from monitor.api_parser import (
    APIParser,
    EventType,
    extract_body,
    normalize_path,
)

FIXED_TIME = datetime(2024, 1, 1, tzinfo=timezone.utc)


@pytest.fixture
def parser() -> APIParser:
    return APIParser()


def events_by_type(events, event_type):
    return [event for event in events if event.type is event_type]


def one(events, event_type):
    matched = events_by_type(events, event_type)
    assert len(matched) == 1, f"{event_type} が {len(matched)} 件でした"
    return matched[0]


# -- パス正規化 -----------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("/kcsapi/api_port/port", "api_port/port"),
        ("kcsapi/api_port/port", "api_port/port"),
        ("api_port/port", "api_port/port"),
        ("http://203.104.209.71/kcsapi/api_port/port?k=1", "api_port/port"),
        ("  /kcsapi/api_get_member/material  ", "api_get_member/material"),
        ("", ""),
        (None, ""),
    ],
)
def test_normalize_path(raw, expected) -> None:
    assert normalize_path(raw) == expected


# -- 本文の取り出し -------------------------------------------------------


def test_extract_body_from_svdata_string() -> None:
    body = extract_body('svdata={"api_result":1,"api_data":{"x":1}}')
    assert body == {"x": 1}


def test_extract_body_from_plain_json_string() -> None:
    assert extract_body('{"api_result":1,"api_data":{"x":2}}') == {"x": 2}


def test_extract_body_wraps_array_api_data() -> None:
    assert extract_body({"api_result": 1, "api_data": [1, 2]}) == {"api_data": [1, 2]}


def test_extract_body_accepts_bare_data() -> None:
    assert extract_body({"api_material": []}) == {"api_material": []}


def test_extract_body_returns_none_for_broken_json() -> None:
    assert extract_body('svdata={"api_result":1,') is None


def test_extract_body_returns_none_for_non_mapping() -> None:
    assert extract_body(42) is None


# -- 母港 -----------------------------------------------------------------


def test_port_produces_expected_event_types(parser: APIParser) -> None:
    events = parser.parse_record(load_fixture("port.json"), FIXED_TIME)
    produced = {event.type for event in events}
    assert {
        EventType.PORT_REFRESHED,
        EventType.RESOURCE_UPDATED,
        EventType.SHIP_UPDATED,
        EventType.FLEET_UPDATED,
        EventType.REPAIR_DOCK_UPDATED,
        EventType.PLAYER_UPDATED,
        EventType.EXPEDITION_STARTED,
    } <= produced


def test_port_parses_resources(parser: APIParser) -> None:
    event = one(
        parser.parse_record(load_fixture("port.json"), FIXED_TIME),
        EventType.RESOURCE_UPDATED,
    )
    resources = event.payload["resources"]
    assert resources[ResourceKind.FUEL] == 25000
    assert resources[ResourceKind.FAST_REPAIR] == 120


def test_port_parses_ships_with_lock_state(parser: APIParser) -> None:
    event = one(
        parser.parse_record(load_fixture("port.json"), FIXED_TIME),
        EventType.SHIP_UPDATED,
    )
    assert event.payload["replace"] is True
    ships = {ship.instance_id: ship for ship in event.payload["ships"]}
    assert ships[101].locked is True
    assert ships[102].locked is False
    assert ships[102].level == 1
    assert ships[101].exp == 1000000


def test_port_parses_fleets_and_skips_empty_slots(parser: APIParser) -> None:
    event = one(
        parser.parse_record(load_fixture("port.json"), FIXED_TIME),
        EventType.FLEET_UPDATED,
    )
    fleets = {fleet.fleet_id: fleet for fleet in event.payload["fleets"]}
    assert fleets[1].ship_ids == [101, 103]
    assert fleets[2].mission.state is FleetMissionState.UNDERWAY
    assert fleets[2].mission.mission_id == 5
    assert fleets[2].mission.complete_at is not None


def test_port_emits_expedition_for_active_fleet_only(parser: APIParser) -> None:
    events = events_by_type(
        parser.parse_record(load_fixture("port.json"), FIXED_TIME),
        EventType.EXPEDITION_STARTED,
    )
    assert [event.payload["fleet_id"] for event in events] == [2]


def test_port_parses_repair_docks(parser: APIParser) -> None:
    event = one(
        parser.parse_record(load_fixture("port.json"), FIXED_TIME),
        EventType.REPAIR_DOCK_UPDATED,
    )
    docks = {dock.dock_id: dock for dock in event.payload["repair_docks"]}
    assert docks[2].is_busy is True
    assert docks[2].ship_id == 103
    assert docks[1].is_busy is False


def test_port_parses_player(parser: APIParser) -> None:
    event = one(
        parser.parse_record(load_fixture("port.json"), FIXED_TIME),
        EventType.PLAYER_UPDATED,
    )
    assert event.payload["player"].ship_capacity == 330


# -- その他の API ---------------------------------------------------------


def test_material_list(parser: APIParser) -> None:
    event = one(
        parser.parse_record(load_fixture("material.json"), FIXED_TIME),
        EventType.RESOURCE_UPDATED,
    )
    assert event.payload["resources"][ResourceKind.FUEL] == 900


def test_map_start(parser: APIParser) -> None:
    event = one(
        parser.parse_record(load_fixture("map_start.json"), FIXED_TIME),
        EventType.SORTIE_STARTED,
    )
    assert event.payload["map_area"] == 5
    assert event.payload["map_no"] == 5
    assert event.payload["boss_cell_no"] == 15


def test_battle_result_with_drop(parser: APIParser) -> None:
    events = parser.parse_record(load_fixture("battleresult_drop.json"), FIXED_TIME)
    assert one(events, EventType.BATTLE_RESULT).payload["rank"] == "S"
    drop = one(events, EventType.DROP_DETECTED)
    assert drop.payload["master_id"] == 543
    assert drop.payload["name"] == "黄平"


def test_battle_result_without_drop(parser: APIParser) -> None:
    body = load_fixture("battleresult_drop.json")["body"]
    del body["api_data"]["api_get_ship"]
    events = parser.parse("api_req_sortie/battleresult", body, FIXED_TIME)
    assert events_by_type(events, EventType.DROP_DETECTED) == []


def test_questlist_skips_placeholder_entries(parser: APIParser) -> None:
    event = one(
        parser.parse_record(load_fixture("questlist.json"), FIXED_TIME),
        EventType.MISSION_UPDATED,
    )
    quests = {quest.quest_id: quest for quest in event.payload["quests"]}
    assert set(quests) == {201, 303}
    assert quests[201].state is QuestState.IN_PROGRESS
    assert quests[303].state is QuestState.COMPLETE
    assert event.payload["page_count"] == 3


def test_mission_result(parser: APIParser) -> None:
    event = one(
        parser.parse_record(load_fixture("mission_result.json"), FIXED_TIME),
        EventType.EXPEDITION_COMPLETED,
    )
    assert event.payload["name"] == "輸送護衛任務"
    assert event.payload["clear_result"] == 1


def test_destroyship_uses_request_body(parser: APIParser) -> None:
    """解体対象の艦 ID は応答ではなくリクエスト側にある。"""
    events = parser.parse_record(load_fixture("destroyship.json"), FIXED_TIME)
    assert one(events, EventType.SHIP_REMOVED).payload["ship_ids"] == [102]
    resources = one(events, EventType.RESOURCE_UPDATED).payload["resources"]
    assert resources[ResourceKind.FUEL] == 25010


# -- 頑健性 ---------------------------------------------------------------


def test_unknown_path_is_ignored(parser: APIParser) -> None:
    assert parser.parse("api_req_hoge/fuga", {"api_data": {}}, FIXED_TIME) == []


def test_broken_body_returns_no_events(parser: APIParser) -> None:
    """壊れた JSON でも例外を投げない（§6）。"""
    record = load_fixture_text("broken.json")
    assert parser.parse_record(record, FIXED_TIME) == []


def test_record_without_path_returns_no_events(parser: APIParser) -> None:
    assert parser.parse_record({"body": {}}, FIXED_TIME) == []


def test_record_without_body_returns_no_events(parser: APIParser) -> None:
    assert parser.parse_record({"path": "api_port/port"}, FIXED_TIME) == []


def test_malformed_entries_do_not_crash(parser: APIParser) -> None:
    """艦データの型が壊れていても、取れるものだけ拾う。"""
    body = {
        "api_data": {
            "api_ship": [{"api_id": "not-a-number"}, {"api_id": 7, "api_lv": None}],
            "api_material": [{"api_id": 1, "api_value": "x"}],
        }
    }
    events = parser.parse("api_port/port", body, FIXED_TIME)
    ships = one(events, EventType.SHIP_UPDATED).payload["ships"]
    assert [ship.instance_id for ship in ships] == [7]
    assert ships[0].level is None
    assert events_by_type(events, EventType.RESOURCE_UPDATED) == []


def test_occurred_at_falls_back_to_record_time(parser: APIParser) -> None:
    events = parser.parse_record(load_fixture("port.json"))
    assert events[0].occurred_at == datetime.fromtimestamp(
        1700000000, tz=timezone.utc
    )

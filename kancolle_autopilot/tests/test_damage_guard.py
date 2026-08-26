"""DamageGuard のテスト。"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from tests.helpers import load_fixture
from core.state import DamageState
from monitor.api_parser import APIParser
from monitor.game_state import GameState
from safety.damage_guard import DamageGuard, DamagePolicy
from safety.verdict import SafetyLevel

T0 = datetime(2024, 1, 1, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def state() -> GameState:
    """母港応答を適用した状態。

    第1艦隊 = [101(無傷), 103(大破・cond22)]、第2艦隊 = [102(無傷・cond40)]。
    """
    state = GameState(clock=lambda: T0)
    state.apply_all(APIParser().parse_record(load_fixture("port.json"), T0))
    return state


def test_heavy_damage_stops(state: GameState) -> None:
    verdict = DamageGuard().check_fleet(state, 1)
    assert verdict.should_stop is True
    assert any("大破" in reason for reason in verdict.reasons)
    assert verdict.details["heavy_ship_ids"] == [103]


def test_healthy_fleet_is_ok(state: GameState) -> None:
    assert DamageGuard().check_fleet(state, 2).is_ok is True


def test_missing_fleet_stops(state: GameState) -> None:
    """把握していない艦隊は「問題なし」にしない。"""
    verdict = DamageGuard().check_fleet(state, 4)
    assert verdict.should_stop is True
    assert "情報がありません" in verdict.reasons[0]


def test_empty_fleet_stops(state: GameState) -> None:
    state.fleets[2].ship_ids = []
    assert DamageGuard().check_fleet(state, 2).should_stop is True


def test_missing_ship_data_stops(state: GameState) -> None:
    """編成されているのに艦データが無い場合は状態不明として停止。"""
    del state.ships[102]
    verdict = DamageGuard().check_fleet(state, 2)
    assert verdict.should_stop is True
    assert verdict.details["unknown_ship_ids"] == [102]


def test_unknown_hp_stops(state: GameState) -> None:
    state.ships[102].hp = None
    verdict = DamageGuard().check_fleet(state, 2)
    assert verdict.should_stop is True
    assert state.ships[102].damage_state is DamageState.UNKNOWN


def test_medium_damage_is_warning_only(state: GameState) -> None:
    state.ships[102].hp = 7  # 7/15 = 46.7% → 中破
    verdict = DamageGuard().check_fleet(state, 2)
    assert verdict.level is SafetyLevel.WARNING
    assert verdict.should_stop is False
    assert verdict.details["medium_ship_ids"] == [102]


def test_medium_damage_can_be_ignored(state: GameState) -> None:
    state.ships[102].hp = 7
    guard = DamageGuard(DamagePolicy(warn_on_medium_damage=False))
    assert guard.check_fleet(state, 2).is_ok is True


def test_fatigue_is_warning_only(state: GameState) -> None:
    state.ships[102].cond = 20
    verdict = DamageGuard().check_fleet(state, 2)
    assert verdict.level is SafetyLevel.WARNING
    assert verdict.details["fatigued_ship_ids"] == [102]


def test_fatigue_threshold_is_configurable(state: GameState) -> None:
    state.ships[102].cond = 35
    assert DamageGuard().check_fleet(state, 2).is_ok is True
    strict = DamageGuard(DamagePolicy(min_cond=40))
    assert strict.check_fleet(state, 2).level is SafetyLevel.WARNING


def test_policy_from_config_mapping() -> None:
    policy = DamagePolicy.from_mapping({"min_cond": 45, "min_fuel": 1000})
    assert policy.min_cond == 45


def test_check_all_fleets_merges_worst_level(state: GameState) -> None:
    verdict = DamageGuard().check_all_fleets(state)
    assert verdict.should_stop is True  # 第1艦隊の大破が効く


def test_check_all_fleets_stops_without_fleet_data() -> None:
    assert DamageGuard().check_all_fleets(GameState()).should_stop is True

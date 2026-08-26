"""SafetyManager のテスト。"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from tests.helpers import load_fixture
from core.config_manager import ConfigManager
from core.state import Resources, Ship
from monitor.api_parser import APIParser, Event, EventType
from monitor.game_state import GameState
from safety.lock_guard import Blacklist, DismantlePolicy, LockGuard
from safety.safety_manager import SafetyManager
from safety.verdict import SafetyLevel

T0 = datetime(2024, 1, 1, 12, 0, tzinfo=timezone.utc)
EMPTY_OK = Blacklist(allow_empty=True, source="test")


@pytest.fixture
def state() -> GameState:
    state = GameState(clock=lambda: T0)
    state.apply_all(APIParser().parse_record(load_fixture("port.json"), T0))
    return state


@pytest.fixture
def manager() -> SafetyManager:
    return SafetyManager(
        lock_guard=LockGuard(EMPTY_OK, DismantlePolicy(protect_newest_count=1))
    )


# -- 生成 -----------------------------------------------------------------


def test_from_config_builds_guards(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps({"safety": {"min_fuel": 4321, "log_stale_seconds": 60}}),
        encoding="utf-8",
    )
    manager = SafetyManager.from_config(ConfigManager(config_path).load())
    assert manager.resource_guard.thresholds.min_fuel == 4321
    assert manager.log_stale_seconds == 60
    # 設定ファイルの隣に blacklist.json が無いので未設定になる。
    assert manager.lock_guard.blacklist.is_configured is False


def test_from_config_reads_blacklist_relative_to_config(tmp_path: Path) -> None:
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "blacklist.json").write_text(
        json.dumps({"entries": [{"master_id": 163, "name": "まるゆ"}]}),
        encoding="utf-8",
    )
    config_path = tmp_path / "config.json"
    config_path.write_text("{}", encoding="utf-8")
    manager = SafetyManager.from_config(ConfigManager(config_path).load())
    assert manager.lock_guard.blacklist.contains(163) is True


# -- 総合判定 -------------------------------------------------------------


def test_healthy_state_is_ok(state: GameState, manager: SafetyManager) -> None:
    assert manager.evaluate(state, now=T0).is_ok is True
    assert manager.may_execute(state, now=T0) is True


def test_low_resources_stop(state: GameState, manager: SafetyManager) -> None:
    state.resources = Resources(**{**vars(state.resources), "fuel": 10})
    assert manager.evaluate(state, now=T0).should_stop is True


def test_stale_log_stops(state: GameState, manager: SafetyManager) -> None:
    """ログが止まっている＝状態不明として停止する。"""
    verdict = manager.evaluate(state, now=T0 + timedelta(seconds=301))
    assert verdict.should_stop is True
    assert any("更新されていません" in reason for reason in verdict.reasons)


def test_fresh_log_does_not_stop(state: GameState, manager: SafetyManager) -> None:
    assert manager.evaluate(state, now=T0 + timedelta(seconds=299)).is_ok is True


def test_never_updated_state_stops(manager: SafetyManager) -> None:
    assert manager.evaluate(GameState(), now=T0).should_stop is True


def test_damaged_fleet_stops_when_fleet_specified(
    state: GameState, manager: SafetyManager
) -> None:
    assert manager.evaluate(state, fleet_id=1, now=T0).should_stop is True
    assert manager.evaluate(state, fleet_id=2, now=T0).is_ok is True


def test_fatigue_surfaces_as_warning(
    state: GameState, manager: SafetyManager
) -> None:
    state.ships[102].cond = 10
    verdict = manager.evaluate(state, fleet_id=2, now=T0)
    assert verdict.level is SafetyLevel.WARNING
    assert verdict.should_stop is False


# -- 緊急停止のラッチ -----------------------------------------------------


def test_emergency_stop_latches(state: GameState, manager: SafetyManager) -> None:
    """一度停止したら、状態が正常に見えても自動復帰しない。"""
    manager.trigger_emergency_stop("操作結果を確認できません", at=T0)
    assert manager.is_stopped is True
    assert manager.evaluate(state, now=T0).should_stop is True

    manager.clear_emergency_stop()
    assert manager.is_stopped is False
    assert manager.evaluate(state, now=T0).is_ok is True


def test_latched_reasons_are_reported(manager: SafetyManager) -> None:
    manager.trigger_emergency_stop("想定外の画面", at=T0)
    assert "想定外の画面" in manager.latched_reasons[0]


# -- 未確認ドロップの保護 -------------------------------------------------


def drop_event(master_id: int | None, name: str | None = None) -> Event:
    return Event(
        EventType.UNKNOWN_SHIP_DROPPED,
        {"master_id": master_id, "name": name, "is_new": True},
        T0,
    )


def test_pending_protection_stops_execution(
    state: GameState, manager: SafetyManager
) -> None:
    manager.observe([drop_event(543, "黄平")])
    verdict = manager.evaluate(state, now=T0)
    assert verdict.should_stop is True
    assert any("保護が完了していません" in reason for reason in verdict.reasons)


def test_protection_clears_once_locked_ship_appears(
    state: GameState, manager: SafetyManager
) -> None:
    """ロック済みの当該艦種を所有した時点で保護要求は解消する。"""
    manager.observe([drop_event(543, "黄平")])
    state.ships[104] = Ship(instance_id=104, master_id=543, locked=True)
    assert manager.evaluate(state, now=T0).is_ok is True
    assert manager.pending_protections == ()


def test_unlocked_new_ship_does_not_clear_protection(
    state: GameState, manager: SafetyManager
) -> None:
    manager.observe([drop_event(543, "黄平")])
    state.ships[104] = Ship(instance_id=104, master_id=543, locked=False)
    assert manager.evaluate(state, now=T0).should_stop is True


def test_undecidable_drop_needs_manual_clear(
    state: GameState, manager: SafetyManager
) -> None:
    """艦種不明のドロップは自動では解消しない。"""
    manager.observe([drop_event(None)])
    assert manager.evaluate(state, now=T0).should_stop is True

    manager.clear_protection()
    assert manager.evaluate(state, now=T0).is_ok is True


def test_observe_ignores_other_events(manager: SafetyManager) -> None:
    manager.observe([Event(EventType.PORT_REFRESHED, {}, T0)])
    assert manager.pending_protections == ()


# -- 解体の最終承認 -------------------------------------------------------


def test_approve_dismantle_returns_eligible_ships(
    state: GameState, manager: SafetyManager
) -> None:
    state.fleets[2].ship_ids = []
    approved, rejected = manager.approve_dismantle(state, [101, 102, 103], now=T0)
    assert approved == [102]
    assert len(rejected) == 2


def test_approve_dismantle_blocked_by_overall_stop(
    state: GameState, manager: SafetyManager
) -> None:
    """全体が STOP なら、条件を満たす艦でも 1 隻も承認しない。"""
    state.fleets[2].ship_ids = []
    manager.trigger_emergency_stop("資材の急減", at=T0)
    approved, rejected = manager.approve_dismantle(state, [102], now=T0)
    assert approved == []
    assert "全体の安全判定が STOP" in rejected[0]


def test_approve_dismantle_blocked_by_pending_protection(
    state: GameState, manager: SafetyManager
) -> None:
    state.fleets[2].ship_ids = []
    manager.observe([drop_event(543, "黄平")])
    approved, _ = manager.approve_dismantle(state, [102], now=T0)
    assert approved == []

"""LockGuard のテスト。"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from tests.helpers import load_fixture
from core.state import DropRecord
from monitor.api_parser import APIParser
from monitor.game_state import GameState
from safety.lock_guard import (
    Blacklist,
    DismantlePolicy,
    LockGuard,
    load_blacklist,
)

T0 = datetime(2024, 1, 1, 12, 0, tzinfo=timezone.utc)

#: 空でも使用してよいブラックリスト（判定ロジックそのものを見るため）。
EMPTY_OK = Blacklist(allow_empty=True, source="test")


@pytest.fixture
def state() -> GameState:
    """母港応答を適用した状態。

    #101 Lv99 ロック / #102 Lv1 未ロック / #103 Lv45 ロック・入渠中。
    """
    state = GameState(clock=lambda: T0)
    state.apply_all(APIParser().parse_record(load_fixture("port.json"), T0))
    # #102 を編成から外し、素の候補にする。
    state.fleets[2].ship_ids = []
    return state


@pytest.fixture
def guard() -> LockGuard:
    return LockGuard(EMPTY_OK, DismantlePolicy(max_level=1, protect_newest_count=1))


# -- ブラックリストの読み込み ---------------------------------------------


def test_missing_blacklist_is_unconfigured(tmp_path: Path) -> None:
    blacklist = load_blacklist(tmp_path / "absent.json")
    assert blacklist.is_configured is False


def test_broken_blacklist_is_unconfigured(tmp_path: Path) -> None:
    path = tmp_path / "blacklist.json"
    path.write_text("{ broken", encoding="utf-8")
    assert load_blacklist(path).is_configured is False


def test_shipped_blacklist_template_is_unconfigured() -> None:
    """同梱テンプレートは空なので、そのままでは解体を通さない。"""
    blacklist = load_blacklist(Path(__file__).parents[1] / "data" / "blacklist.json")
    assert blacklist.is_configured is False


def test_blacklist_entries_are_loaded(tmp_path: Path) -> None:
    path = tmp_path / "blacklist.json"
    path.write_text(
        json.dumps({"entries": [{"master_id": 163, "name": "まるゆ"}]}),
        encoding="utf-8",
    )
    blacklist = load_blacklist(path)
    assert blacklist.is_configured is True
    assert blacklist.contains(163) is True
    assert blacklist.label(163) == "まるゆ"


def test_invalid_entries_are_skipped(tmp_path: Path) -> None:
    path = tmp_path / "blacklist.json"
    path.write_text(
        json.dumps({"entries": [{"master_id": "163"}, {"master_id": 200}, "x"]}),
        encoding="utf-8",
    )
    assert load_blacklist(path).master_ids == frozenset({200})


# -- 判定 -----------------------------------------------------------------


def test_unconfigured_blacklist_rejects_everything(state: GameState) -> None:
    """ブラックリスト未設定なら、条件を満たす艦でも通さない。"""
    verdict = LockGuard(Blacklist(source="none")).evaluate(state, 102)
    assert verdict.should_stop is True
    assert "ブラックリストが未設定" in verdict.reasons[0]


def test_eligible_ship_is_approved(state: GameState, guard: LockGuard) -> None:
    assert guard.evaluate(state, 102).is_ok is True


def test_locked_ship_is_rejected(state: GameState, guard: LockGuard) -> None:
    verdict = guard.evaluate(state, 101)
    assert verdict.should_stop is True
    assert "ロックされています" in verdict.reasons


def test_unknown_lock_state_is_rejected(state: GameState, guard: LockGuard) -> None:
    """ロック状態が不明な艦は未ロック扱いにしない。"""
    state.ships[102].locked = None
    verdict = guard.evaluate(state, 102)
    assert verdict.should_stop is True
    assert "ロック状態が不明です" in verdict.reasons


def test_level_over_limit_is_rejected(state: GameState, guard: LockGuard) -> None:
    state.ships[102].level = 2
    assert guard.evaluate(state, 102).should_stop is True


def test_unknown_level_is_rejected(state: GameState, guard: LockGuard) -> None:
    state.ships[102].level = None
    assert "レベルが不明です" in guard.evaluate(state, 102).reasons


def test_blacklisted_master_is_rejected(state: GameState) -> None:
    guard = LockGuard(
        Blacklist(master_ids=frozenset({2}), names={2: "まるゆ"}, source="test"),
        DismantlePolicy(),
    )
    verdict = guard.evaluate(state, 102)
    assert verdict.should_stop is True
    assert "まるゆ" in verdict.reasons[0]


def test_unknown_master_is_rejected(state: GameState, guard: LockGuard) -> None:
    state.ships[102].master_id = None
    assert "艦種が特定できません" in guard.evaluate(state, 102).reasons


def test_newest_ship_is_protected(state: GameState) -> None:
    """入手が新しい艦は条件を満たしていても保護する。"""
    state.ships[103].locked = False
    state.ships[103].level = 1
    state.fleets[1].ship_ids = []
    state.repair_docks[2].state = 0
    guard = LockGuard(EMPTY_OK, DismantlePolicy(protect_newest_count=1))
    assert "直近に入手した艦です" in guard.evaluate(state, 103).reasons


def test_protect_newest_count_zero_disables_protection(state: GameState) -> None:
    guard = LockGuard(EMPTY_OK, DismantlePolicy(protect_newest_count=0))
    assert guard.protected_newest_ids(state) == frozenset()


def test_ship_in_fleet_is_rejected(state: GameState, guard: LockGuard) -> None:
    state.fleets[1].ship_ids = [101, 102]
    assert "第1艦隊に編成されています" in guard.evaluate(state, 102).reasons


def test_ship_in_repair_dock_is_rejected(state: GameState, guard: LockGuard) -> None:
    state.repair_docks[2].ship_id = 102
    assert "入渠中です" in guard.evaluate(state, 102).reasons


def test_missing_ship_is_rejected(state: GameState, guard: LockGuard) -> None:
    assert guard.evaluate(state, 999).should_stop is True


def test_pending_drop_protection_blocks_dismantle(
    state: GameState, guard: LockGuard
) -> None:
    """未確認ドロップの保護が済むまで艦の増減を触らせない。"""
    state.last_drop = DropRecord(master_id=543, name="黄平", is_new=True)
    assert "未確認ドロップの保護が完了していません" in guard.evaluate(state, 102).reasons


def test_resolved_drop_does_not_block(state: GameState, guard: LockGuard) -> None:
    state.last_drop = DropRecord(master_id=2, name="二番艦", is_new=False)
    assert guard.evaluate(state, 102).is_ok is True


def test_approve_splits_candidates(state: GameState, guard: LockGuard) -> None:
    approved, rejected = guard.approve(state, [101, 102, 103])
    assert [decision.ship_id for decision in approved] == [102]
    assert [decision.ship_id for decision in rejected] == [101, 103]
    assert rejected[0].reasons


def test_policy_from_config_mapping() -> None:
    policy = DismantlePolicy.from_mapping(
        {"max_dismantle_level": 3, "protect_newest_count": 5}
    )
    assert policy.max_level == 3
    assert policy.protect_newest_count == 5


# -- 結果照合 -------------------------------------------------------------


def test_verify_result_accepts_expected_removal(state: GameState) -> None:
    before = state.snapshot()
    del state.ships[102]
    assert LockGuard().verify_result(before, state, [102]).is_ok is True


def test_verify_result_detects_unexpected_removal(state: GameState) -> None:
    """想定外の艦が消えたら停止する。"""
    before = state.snapshot()
    del state.ships[102]
    del state.ships[101]
    verdict = LockGuard().verify_result(before, state, [102])
    assert verdict.should_stop is True
    assert "想定外の艦が消えました: [101]" in verdict.reasons


def test_verify_result_detects_failed_removal(state: GameState) -> None:
    before = state.snapshot()
    verdict = LockGuard().verify_result(before, state, [102])
    assert verdict.should_stop is True
    assert "破棄したはずの艦が残っています: [102]" in verdict.reasons

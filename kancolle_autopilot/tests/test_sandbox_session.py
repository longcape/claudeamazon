"""SandboxSession のテスト。AI Core とサンドボックスを繋いだ状態を見る。"""

from __future__ import annotations

import pytest

from core.state import ResourceKind
from monitor.api_parser import EventType
from safety.safety_manager import SafetyManager
from sandbox.session import SandboxSession
from tasks.construction_task import ConstructionTask
from tasks.dismantle_task import DismantleTask
from tasks.expedition_task import ExpeditionTask
from tasks.sortie_task import SortieTask


@pytest.fixture
def session() -> SandboxSession:
    session = SandboxSession.create(seed=7)
    session.bootstrap()
    return session


# ======================================================================
# 同期
# ======================================================================


def test_bootstrap_builds_ai_view(session: SandboxSession) -> None:
    """AI 側の状態が、ゲームの真の状態と一致する。"""
    assert len(session.game_state.ships) == len(session.game.ships)
    assert session.game_state.resources.fuel == session.game.resource(
        ResourceKind.FUEL
    )
    assert session.game_state.fleets[1].ship_ids == session.game.fleets[1].ship_ids


def test_ai_core_never_sees_sandbox_types(session: SandboxSession) -> None:
    """AI Core の状態にサンドボックス固有の型が混ざらない。"""
    from core.state import Ship

    assert all(isinstance(ship, Ship) for ship in session.game_state.ships.values())


def test_verification_is_enabled_for_sandbox(session: SandboxSession) -> None:
    """押せばゲームが動くので、結果照合を省略しない。"""
    assert session.interface.simulated is True
    assert session.interface.affects_game_state is True


# ======================================================================
# タスク実行
# ======================================================================


def test_sortie_task_moves_the_game(session: SandboxSession) -> None:
    result = session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))

    assert result.ok is True
    assert session.game.sortie is not None
    assert session.game.sortie.map_key == "1-5"
    # AI 側でも出撃が見えている（結果照合が通った証拠）。
    assert session.game_state.sortie.map_label == "1-5"


def test_sortie_task_verification_catches_a_no_op(session: SandboxSession) -> None:
    """操作は通ったのにゲームが動かなければ、照合で落ちて緊急停止する。"""
    # 選択状態を消す細工をして、確定操作を無効にする。
    original = session.environment._commit
    session.environment._commit = lambda target: []  # type: ignore[assignment]
    try:
        result = session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    finally:
        session.environment._commit = original  # type: ignore[assignment]

    assert result.ok is False
    assert "結果を確認できません" in result.message
    assert session.safety.is_stopped is True


def test_expedition_task_and_return(session: SandboxSession) -> None:
    assert session.run(ExpeditionTask(fleet_id=2, mission_id=5)).ok is True
    assert session.game_state.fleets[2].mission.is_active is True

    before = session.game.resource(ResourceKind.STEEL)
    assert session.complete_all_expeditions() == [2]
    assert session.game.resource(ResourceKind.STEEL) > before
    assert session.game_state.fleets[2].mission.is_active is False


def test_construction_task_starts_a_build(session: SandboxSession) -> None:
    # 建造ドックの状態を AI 側へ流し込む。
    session.environment.records.append(session.game.kdock_record())
    session.sync()

    result = session.run(ConstructionTask())
    assert result.ok is True
    assert session.game.build_docks[1]["state"] == 2


def test_dismantle_respects_locks(session: SandboxSession) -> None:
    """ロック艦は AI 側でもゲーム側でも弾かれる。"""
    session.game.fleets[2].ship_ids = []
    session.environment.records.append(session.game.port_record())
    session.sync()

    result = session.run(DismantleTask([101, 105]))
    assert result.ok is True
    assert 101 in session.game.ships  # ロック艦は残る
    assert 105 not in session.game.ships


# ======================================================================
# 戦闘の周回
# ======================================================================


def test_fight_through_completes_a_sortie(session: SandboxSession) -> None:
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    ranks = session.fight_through()

    assert ranks
    assert all(rank in "SABCDE" for rank in ranks)
    assert session.game.sortie is None
    assert session.game_state.sortie.is_active is False
    assert session.game.rank_points > 0


def test_sortie_consumes_resources(session: SandboxSession) -> None:
    before = session.game_state.resources.fuel
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    session.fight_through()
    assert session.game_state.resources.fuel < before


def test_unknown_drop_triggers_protection() -> None:
    """未所持艦が出たら、AI 側で保護待ちになり以降が止まる。"""
    session = SandboxSession.create(seed=3)
    session.bootstrap()
    # 5-5 のドロップ枠には未所持の艦種が含まれる。
    session.game.maps["5-5"].enemy_strength = 1.0
    session.game.maps["5-5"].drop_pool = (1004,)  # 未所持
    session.game.battle.drop_rate = 1.0

    session.run(SortieTask(fleet_id=1, map_area=5, map_no=5))
    session.fight_through()

    assert session.safety.pending_protections
    verdict = session.safety.evaluate(session.game_state, now=session.game.clock())
    assert verdict.should_stop is True


def test_protection_clears_after_locking() -> None:
    """該当艦種をロックすれば保護待ちが解ける。"""
    session = SandboxSession.create(seed=3)
    session.bootstrap()
    session.game.maps["1-5"].drop_pool = (1004,)
    session.game.battle.drop_rate = 1.0

    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    session.fight_through()
    assert session.safety.pending_protections

    dropped = [
        ship.instance_id
        for ship in session.game.ships.values()
        if ship.master_id == 1004
    ]
    session.environment.records.extend(session.game.set_lock(dropped[0], True))
    session.sync()

    assert session.safety.evaluate(
        session.game_state, now=session.game.clock()
    ).is_ok is True


def test_known_drop_does_not_trigger_protection(session: SandboxSession) -> None:
    session.game.maps["1-5"].drop_pool = (1001,)  # 所持済み
    session.game.battle.drop_rate = 1.0
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    session.fight_through()
    assert session.safety.pending_protections == ()


def test_sync_reports_derived_events(session: SandboxSession) -> None:
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    session.environment.records.extend(session.game.return_to_port())
    derived = session.sync()
    assert EventType.SORTIE_ENDED in {event.type for event in derived}


# ======================================================================
# 安全側の連携
# ======================================================================


def test_low_resources_stop_further_tasks(session: SandboxSession) -> None:
    session.game.resources[ResourceKind.FUEL] = 10
    session.environment.records.append(session.game.port_record())
    session.sync()

    result = session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    assert result.ok is False
    assert "安全判定により中止" in result.message


def test_heavy_damage_blocks_next_sortie(session: SandboxSession) -> None:
    for ship in session.game.fleet_ships(1):
        ship.hp = 1
    session.environment.records.append(session.game.port_record())
    session.sync()

    result = session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    assert result.ok is False
    assert "大破" in result.message


def test_unconfigured_blacklist_blocks_dismantle() -> None:
    session = SandboxSession.create(seed=1, safety=SafetyManager())
    session.bootstrap()
    session.game.fleets[2].ship_ids = []
    result = session.run(DismantleTask([105]))
    assert result.ok is False
    assert 105 in session.game.ships


def test_summary_reports_progress(session: SandboxSession) -> None:
    summary = session.summary()
    assert summary["戦果"] == 0
    assert summary["ゲージ"]["5-5"] == "5/5"

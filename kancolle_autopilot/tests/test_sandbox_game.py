"""SandboxGame / BattleModel のテスト。"""

from __future__ import annotations

import random

import pytest

from core.state import ResourceKind
from sandbox.battle import BattleModel, CombatShip
from sandbox.game import MISSIONS, MapGauge, SandboxGame
from sandbox.scenario import new_game


@pytest.fixture
def game() -> SandboxGame:
    return new_game(seed=7)


# ======================================================================
# 戦闘モデル
# ======================================================================


def strong() -> list[CombatShip]:
    return [CombatShip(i, level=90, hp=40, max_hp=40) for i in range(1, 7)]


def weak() -> list[CombatShip]:
    return [CombatShip(1, level=1, hp=2, max_hp=16)]


def test_overwhelming_force_wins() -> None:
    model = BattleModel(rng=random.Random(1))
    assert model.resolve(strong(), enemy_strength=20.0, at_boss=False).rank == "S"


def test_hopeless_fight_loses() -> None:
    model = BattleModel(rng=random.Random(1))
    assert model.resolve(weak(), enemy_strength=500.0, at_boss=False).rank == "E"


def test_empty_fleet_is_defeat() -> None:
    assert BattleModel().resolve([], 10.0, False).rank == "E"


def test_same_seed_gives_same_result() -> None:
    """種を固定すれば戦闘は完全に再現できる。"""
    first = BattleModel(rng=random.Random(42)).resolve(strong(), 200.0, True, (1,))
    second = BattleModel(rng=random.Random(42)).resolve(strong(), 200.0, True, (1,))
    assert first.rank == second.rank
    assert first.damage == second.damage
    assert first.drop_master_id == second.drop_master_id


def test_boss_gives_more_rank_points() -> None:
    model = BattleModel(rng=random.Random(3))
    normal = model.resolve(strong(), 20.0, at_boss=False)
    model = BattleModel(rng=random.Random(3))
    boss = model.resolve(strong(), 20.0, at_boss=True)
    assert boss.rank_points > normal.rank_points


def test_resource_consumption_scales_with_fleet_size() -> None:
    outcome = BattleModel(rng=random.Random(1)).resolve(strong(), 20.0, False)
    assert outcome.resource_consumption[ResourceKind.FUEL] == 12 * 6


def test_damage_never_exceeds_current_hp() -> None:
    model = BattleModel(rng=random.Random(5))
    ships = [CombatShip(1, level=1, hp=5, max_hp=40)]
    outcome = model.resolve(ships, 400.0, False)
    assert outcome.damage.get(1, 0) <= 5


def test_gauge_broken_only_at_boss() -> None:
    model = BattleModel(rng=random.Random(2))
    assert model.resolve(strong(), 20.0, at_boss=False).gauge_broken is False


# ======================================================================
# ゲージ
# ======================================================================


def test_gauge_reduces_and_reports_break() -> None:
    gauge = MapGauge(maximum=2, current=2)
    assert gauge.reduce() is False
    assert gauge.reduce() is True
    assert gauge.is_broken is True
    assert gauge.reduce() is False  # 割り切った後は減らない


# ======================================================================
# ゲーム操作
# ======================================================================


def test_initial_state(game: SandboxGame) -> None:
    assert len(game.ships) == 6
    assert game.fleets[1].ship_ids == [101, 102, 103, 104]
    assert game.resource(ResourceKind.FUEL) == 25000


def test_port_record_round_trips_through_parser(game: SandboxGame) -> None:
    """サンドボックスの出力を、実ゲームと同じパーサで読める。"""
    from monitor.api_parser import APIParser
    from monitor.game_state import GameState

    state = GameState()
    state.apply_all(APIParser().parse_record(game.port_record()))

    assert len(state.ships) == 6
    assert state.resources.fuel == 25000
    assert state.fleets[1].ship_ids == [101, 102, 103, 104]
    assert state.ships[101].locked is True
    assert state.ships[105].locked is False


def test_sortie_and_return(game: SandboxGame) -> None:
    game.start_sortie(1, "1-5")
    assert game.sortie is not None
    game.return_to_port()
    assert game.sortie is None


def test_sortie_rejects_unknown_map(game: SandboxGame) -> None:
    with pytest.raises(ValueError, match="未知の海域"):
        game.start_sortie(1, "9-9")


def test_sortie_rejects_empty_fleet(game: SandboxGame) -> None:
    with pytest.raises(ValueError, match="空です"):
        game.start_sortie(3, "1-5")


def test_double_sortie_is_rejected(game: SandboxGame) -> None:
    game.start_sortie(1, "1-5")
    with pytest.raises(ValueError, match="既に出撃中"):
        game.start_sortie(2, "1-6")


def test_advance_moves_to_boss(game: SandboxGame) -> None:
    game.start_sortie(1, "1-5")
    for _ in range(4):
        game.advance()
    assert game.at_boss is True


def test_advance_outside_sortie_is_rejected(game: SandboxGame) -> None:
    with pytest.raises(ValueError, match="出撃中ではありません"):
        game.advance()


def test_fight_consumes_resources_and_gives_points(game: SandboxGame) -> None:
    game.start_sortie(1, "1-5")
    before = game.resource(ResourceKind.FUEL)
    game.fight()
    assert game.resource(ResourceKind.FUEL) < before
    assert game.rank_points > 0


def test_boss_victory_breaks_gauge(game: SandboxGame) -> None:
    """5-5 のゲージはボス撃破で減る。"""
    game.start_sortie(1, "5-5")
    for _ in range(14):
        game.advance()
    assert game.at_boss is True

    before = game.maps["5-5"].gauge.current
    # 勝てる戦力になるまで敵を弱める（戦闘モデルではなくゲージを見たい）。
    game.maps["5-5"].enemy_strength = 1.0
    game.fight()
    assert game.maps["5-5"].gauge.current == before - 1


def test_gauge_break_records_cleared_map(game: SandboxGame) -> None:
    target = game.maps["5-5"]
    target.enemy_strength = 1.0
    target.gauge.current = 1
    game.start_sortie(1, "5-5")
    for _ in range(14):
        game.advance()
    game.fight()
    assert "5-5" in game.cleared_maps


def test_expedition_cycle(game: SandboxGame) -> None:
    game.start_expedition(2, 5)
    assert game.fleets[2].mission_state == 2

    before = game.resource(ResourceKind.STEEL)
    game.complete_expedition(2)
    reward = MISSIONS[5][1][ResourceKind.STEEL]
    assert game.resource(ResourceKind.STEEL) == before + reward
    assert game.fleets[2].mission_state == 0


def test_expedition_rejects_busy_fleet(game: SandboxGame) -> None:
    game.start_expedition(2, 5)
    with pytest.raises(ValueError, match="既に遠征中"):
        game.start_expedition(2, 2)


def test_expedition_rejects_unknown_mission(game: SandboxGame) -> None:
    with pytest.raises(ValueError, match="未知の遠征"):
        game.start_expedition(2, 999)


def test_build_consumes_resources(game: SandboxGame) -> None:
    before = game.resource(ResourceKind.FUEL)
    game.build(1, {"fuel": 30, "ammo": 30, "steel": 30, "bauxite": 30})
    assert game.resource(ResourceKind.FUEL) == before - 30
    assert game.build_docks[1]["state"] == 2


def test_build_rejects_busy_dock(game: SandboxGame) -> None:
    game.build(1, {"fuel": 30, "ammo": 30, "steel": 30, "bauxite": 30})
    with pytest.raises(ValueError, match="使えません"):
        game.build(1, {"fuel": 30, "ammo": 30, "steel": 30, "bauxite": 30})


def test_build_rejects_insufficient_resources(game: SandboxGame) -> None:
    game.resources[ResourceKind.BAUXITE] = 5
    with pytest.raises(ValueError, match="BAUXITE"):
        game.build(1, {"fuel": 30, "ammo": 30, "steel": 30, "bauxite": 30})


def test_receive_ship_adds_to_fleet_pool(game: SandboxGame) -> None:
    game.build(1, {"fuel": 30, "ammo": 30, "steel": 30, "bauxite": 30})
    game.build_docks[1]["complete_at"] = None  # 完成扱いにする
    before = len(game.ships)
    game.receive_ship(1)
    assert len(game.ships) == before + 1
    assert game.build_docks[1]["state"] == 0


def test_destroy_ship_rejects_locked(game: SandboxGame) -> None:
    """サンドボックス側にも保護を置く。AI の保護が効いたのか
    たまたま起きなかっただけなのかを区別するため。"""
    with pytest.raises(ValueError, match="ロックされています"):
        game.destroy_ships([101])


def test_destroy_ship_rejects_assigned(game: SandboxGame) -> None:
    game.ships[105].locked = False
    with pytest.raises(ValueError, match="編成中"):
        game.destroy_ships([105])


def test_destroy_ship_succeeds_for_free_ship(game: SandboxGame) -> None:
    game.fleets[2].ship_ids = []
    before = game.resource(ResourceKind.STEEL)
    game.destroy_ships([105])
    assert 105 not in game.ships
    assert game.resource(ResourceKind.STEEL) > before


def test_set_lock(game: SandboxGame) -> None:
    game.set_lock(105, True)
    assert game.ships[105].locked is True


def test_repair_cycle(game: SandboxGame) -> None:
    game.ships[101].hp = 5
    game.repair(1, 101)
    assert game.repair_docks[1]["state"] == 1
    game.finish_repair(1)
    assert game.ships[101].hp == game.ships[101].max_hp
    assert game.repair_docks[1]["state"] == 0


def test_supply_refills(game: SandboxGame) -> None:
    game.ships[101].fuel = 0
    game.supply(1)
    assert game.ships[101].fuel == game.ships[101].max_fuel

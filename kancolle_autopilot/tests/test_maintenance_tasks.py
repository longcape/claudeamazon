"""進撃・補給・入渠タスクのテスト。"""

from __future__ import annotations

import pytest

from core.state import DamageState, ResourceKind
from core.task_queue import Task, TaskPriority
from sandbox.session import SandboxSession
from tasks.advance_task import AdvanceTask
from tasks.constraints import ADVANCE_WITH_HEAVY_DAMAGE, USE_BUCKETS, TaskConstraints
from tasks.factory import TaskBuildError, build_task
from tasks.repair_task import RepairTask
from tasks.sortie_task import SortieTask
from tasks.supply_task import SupplyTask


@pytest.fixture
def session() -> SandboxSession:
    session = SandboxSession.create(seed=11)
    session.bootstrap()
    return session


def refresh(session: SandboxSession) -> None:
    """ゲームの状態を AI 側へ流し込む。"""
    session.environment.records.append(session.game.port_record())
    session.sync()


# ======================================================================
# 組み立て
# ======================================================================


def test_factory_builds_the_new_tasks() -> None:
    advance = build_task(Task("advance", TaskPriority.SORTIE, {"fleet_id": 2}))
    supply = build_task(Task("supply", TaskPriority.DAILY_TASK, {"fleet_id": 3}))
    repair = build_task(
        Task("repair", TaskPriority.SAFETY_TASK, {"ship_id": 101, "prefer_fast": True})
    )
    assert isinstance(advance, AdvanceTask) and advance.fleet_id == 2
    assert isinstance(supply, SupplyTask) and supply.fleet_id == 3
    assert isinstance(repair, RepairTask) and repair.prefer_fast is True


def test_repair_requires_a_ship() -> None:
    with pytest.raises(TaskBuildError, match="ship_id"):
        build_task(Task("repair", TaskPriority.SAFETY_TASK, {}))


def test_new_task_names_are_in_the_plan_vocabulary() -> None:
    from llm.schema import TASK_NAMES

    assert {"advance", "supply", "repair"} <= TASK_NAMES


# ======================================================================
# 進撃
# ======================================================================


def test_advance_outside_a_sortie_is_rejected(session: SandboxSession) -> None:
    result = session.run(AdvanceTask(fleet_id=1))
    assert result.ok is False
    assert "出撃中ではありません" in result.message


def test_advance_moves_to_the_next_cell(session: SandboxSession) -> None:
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    cell = session.game.sortie.cell

    result = session.run(AdvanceTask(fleet_id=1))
    assert result.ok is True
    assert result.details["advanced"] is True
    assert session.game.sortie.cell == cell + 1


def test_advance_retreats_on_heavy_damage(session: SandboxSession) -> None:
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    for ship in session.game.fleet_ships(1):
        ship.hp = 1
    session.environment.records.append(
        session.game.fleet_ships_record(1)
    )
    session.sync()

    result = session.run(AdvanceTask(fleet_id=1))
    assert result.details["advanced"] is False
    assert result.details["reason_code"] == "HEAVY_DAMAGE"
    assert session.game.sortie is None  # 母港へ戻っている


def test_advance_pushes_on_with_disposable_strategy(session: SandboxSession) -> None:
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    session.game.ships[102].hp = 1
    session.environment.records.append(session.game.fleet_ships_record(1))
    session.sync()

    task = AdvanceTask(fleet_id=1)
    task.constraints = TaskConstraints(disposable_ship_strategy="allowed")
    result = session.run(task)

    assert result.details["advanced"] is True
    assert result.details["sacrificed"] == [102]


def test_prohibition_beats_permission_in_the_task(session: SandboxSession) -> None:
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    session.game.ships[102].hp = 1
    session.environment.records.append(session.game.fleet_ships_record(1))
    session.sync()

    task = AdvanceTask(fleet_id=1)
    task.constraints = TaskConstraints(
        prohibit=frozenset({ADVANCE_WITH_HEAVY_DAMAGE}),
        disposable_ship_strategy="allowed",
    )
    assert session.run(task).details["reason_code"] == "PROHIBITED"


def test_sortie_fights_on_arrival(session: SandboxSession) -> None:
    """出撃した時点で最初のマスの戦闘が済んでいる。"""
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    assert session.game.last_battle_rank != ""


# ======================================================================
# 補給
# ======================================================================


def test_supply_refills_the_fleet(session: SandboxSession) -> None:
    for ship in session.game.fleet_ships(1):
        ship.fuel = 0
        ship.ammo = 0
    refresh(session)

    result = session.run(SupplyTask(fleet_id=1))
    assert result.ok is True
    assert all(ship.fuel == ship.max_fuel for ship in session.game.fleet_ships(1))


def test_supply_consumes_resources(session: SandboxSession) -> None:
    for ship in session.game.fleet_ships(1):
        ship.fuel = 0
    refresh(session)
    before = session.game.resource(ResourceKind.FUEL)

    session.run(SupplyTask(fleet_id=1))
    assert session.game.resource(ResourceKind.FUEL) < before


def test_supply_rejects_empty_fleet(session: SandboxSession) -> None:
    result = session.run(SupplyTask(fleet_id=3))
    assert result.ok is False
    assert "空です" in result.message


def test_supply_rejects_fleet_on_expedition(session: SandboxSession) -> None:
    session.environment.records.extend(session.game.start_expedition(2, 5))
    session.sync()
    result = session.run(SupplyTask(fleet_id=2))
    assert result.ok is False
    assert "遠征中" in result.message


def test_supply_rejects_during_a_sortie(session: SandboxSession) -> None:
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    result = session.run(SupplyTask(fleet_id=2))
    assert result.ok is False
    assert "出撃中" in result.message


# ======================================================================
# 入渠
# ======================================================================


def damage(session: SandboxSession, ship_id: int = 101, hp: int = 5) -> None:
    session.game.ships[ship_id].hp = hp
    refresh(session)


def test_repair_uses_a_dock(session: SandboxSession) -> None:
    damage(session)
    result = session.run(RepairTask(ship_id=101))

    assert result.ok is True
    assert result.details["fast_repair"] is False
    assert session.game.repair_docks[1]["state"] == 1


def test_repair_rejects_a_healthy_ship(session: SandboxSession) -> None:
    result = session.run(RepairTask(ship_id=101))
    assert result.ok is False
    assert "無傷" in result.message


def test_repair_without_a_free_dock(session: SandboxSession) -> None:
    damage(session)
    for dock_id in (1, 2):
        session.game.repair_docks[dock_id]["state"] = 1
    refresh(session)

    result = session.run(RepairTask(ship_id=101))
    assert result.ok is False
    assert "空いている入渠ドックがありません" in result.message


def test_fast_repair_restores_immediately(session: SandboxSession) -> None:
    damage(session)
    before = session.game.resource(ResourceKind.FAST_REPAIR)

    result = session.run(RepairTask(ship_id=101, prefer_fast=True))
    assert result.details["fast_repair"] is True
    assert session.game.ships[101].hp == session.game.ships[101].max_hp
    assert session.game.resource(ResourceKind.FAST_REPAIR) == before - 1


def test_bucket_prohibition_falls_back_to_a_dock(session: SandboxSession) -> None:
    """use_buckets が禁止されていればドックを使う。"""
    damage(session)
    before = session.game.resource(ResourceKind.FAST_REPAIR)

    task = RepairTask(ship_id=101, prefer_fast=True)
    task.constraints = TaskConstraints(prohibit=frozenset({USE_BUCKETS}))
    result = session.run(task)

    assert result.details["fast_repair"] is False
    assert session.game.resource(ResourceKind.FAST_REPAIR) == before
    assert session.game.repair_docks[1]["state"] == 1


def test_bucket_prohibition_without_a_dock_stops(session: SandboxSession) -> None:
    """バケツも使えず、ドックも空いていなければ実行しない。"""
    damage(session)
    for dock_id in (1, 2):
        session.game.repair_docks[dock_id]["state"] = 1
    refresh(session)

    task = RepairTask(ship_id=101, prefer_fast=True)
    task.constraints = TaskConstraints(prohibit=frozenset({USE_BUCKETS}))
    assert session.run(task).ok is False


def test_fast_repair_not_used_when_buckets_are_gone(session: SandboxSession) -> None:
    """残量が無ければバケツを使わない。

    実運用では ResourceGuard が先に止めるので（既定の下限は 20）、ここは
    判断そのものを直接見る。
    """
    from core.state import Resources

    damage(session)
    ctx = session.context()
    ctx.game_state.resources = Resources(
        **{**vars(ctx.game_state.resources), "fast_repair": 0}
    )
    assert RepairTask(ship_id=101, prefer_fast=True).use_fast_repair(ctx) is False


def test_fast_repair_not_used_when_buckets_are_unknown(
    session: SandboxSession,
) -> None:
    """残量が分からないなら使わない。"""
    from core.state import Resources

    ctx = session.context()
    ctx.game_state.resources = Resources(
        **{**vars(ctx.game_state.resources), "fast_repair": None}
    )
    assert RepairTask(ship_id=101, prefer_fast=True).use_fast_repair(ctx) is False


def test_repair_rejects_a_ship_in_an_active_sortie(session: SandboxSession) -> None:
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    session.game.ships[101].hp = 1
    session.environment.records.append(session.game.fleet_ships_record(1))
    session.sync()

    result = session.run(RepairTask(ship_id=101))
    assert result.ok is False
    assert "出撃中の艦隊" in result.message


def test_repair_clears_the_damage_guard(session: SandboxSession) -> None:
    """入渠は出撃を止めていた条件を解消する手段になる。"""
    damage(session, 101, hp=1)
    blocked = session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    assert blocked.ok is False

    session.run(RepairTask(ship_id=101, prefer_fast=True))
    assert session.game_state.ships[101].damage_state is DamageState.NORMAL
    assert session.run(SortieTask(fleet_id=1, map_area=1, map_no=5)).ok is True

"""制約が実行時に効くことのテスト。"""

from __future__ import annotations

import pytest

from core.state import Ship
from core.task_queue import Task, TaskPriority
from tasks.constraints import (
    ADVANCE_WITH_HEAVY_DAMAGE,
    DISMANTLE_SHIPS,
    EFFICIENCY_MARGIN,
    LARGE_BUILD,
    NO_CONSTRAINTS,
    TaskConstraints,
    decide_advance,
)
from tasks.construction_task import ConstructionTask, Recipe
from tasks.dismantle_task import DismantleTask
from tasks.factory import build_task
from tasks.sortie_task import SortieTask
from tests.task_helpers import add_build_docks, free_fleet, make_context, make_state


def ship(instance_id: int, hp: int, max_hp: int = 40) -> Ship:
    return Ship(instance_id=instance_id, master_id=1, hp=hp, max_hp=max_hp, level=50)


HEALTHY = [ship(1, 40), ship(2, 40)]
DAMAGED = [ship(1, 40), ship(2, 5)]  # #2 は大破（12.5%）


# ======================================================================
# payload からの読み取り
# ======================================================================


def test_defaults_are_the_safe_side() -> None:
    assert NO_CONSTRAINTS.disposable_allowed is False
    assert NO_CONSTRAINTS.resource_margin == 1.0
    assert NO_CONSTRAINTS.forbids(ADVANCE_WITH_HEAVY_DAMAGE) is False


def test_from_payload() -> None:
    constraints = TaskConstraints.from_payload(
        {
            "constraints": ["advance_with_heavy_damage"],
            "resource_efficiency": "high",
            "disposable_ship_strategy": "allowed",
        }
    )
    assert constraints.forbids(ADVANCE_WITH_HEAVY_DAMAGE) is True
    assert constraints.disposable_allowed is True
    assert constraints.resource_margin == 1.5


def test_missing_payload_gives_defaults() -> None:
    assert TaskConstraints.from_payload({}) == NO_CONSTRAINTS


def test_unknown_efficiency_falls_back_to_normal() -> None:
    constraints = TaskConstraints.from_payload({"resource_efficiency": "extreme"})
    assert constraints.resource_efficiency == "normal"


def test_efficiency_never_lowers_the_floor() -> None:
    """「節約重視」は厳しくする方向にしか働かない。"""
    assert min(EFFICIENCY_MARGIN.values()) == 1.0


def test_factory_attaches_constraints() -> None:
    task = build_task(
        Task(
            name="sortie",
            priority=TaskPriority.SORTIE,
            payload={
                "map": "1-5",
                "constraints": ["advance_with_heavy_damage"],
                "disposable_ship_strategy": "allowed",
            },
        )
    )
    assert task.constraints.disposable_allowed is True
    assert task.constraints.forbids(ADVANCE_WITH_HEAVY_DAMAGE) is True


# ======================================================================
# 進撃の判断
# ======================================================================


def test_advances_when_healthy() -> None:
    decision = decide_advance(HEALTHY)
    assert decision.advance is True
    assert decision.reason_code == "NO_HEAVY_DAMAGE"


def test_retreats_on_heavy_damage_by_default() -> None:
    """既定は撤退。許可が明示されていない限り進撃しない。"""
    decision = decide_advance(DAMAGED)
    assert decision.advance is False
    assert decision.reason_code == "HEAVY_DAMAGE"


def test_disposable_strategy_allows_advance() -> None:
    decision = decide_advance(
        DAMAGED, TaskConstraints(disposable_ship_strategy="allowed")
    )
    assert decision.advance is True
    assert decision.sacrificed == (2,)


def test_prohibition_beats_permission() -> None:
    """捨て艦を許可していても、大破進撃を禁止していれば撤退する。"""
    decision = decide_advance(
        DAMAGED,
        TaskConstraints(
            prohibit=frozenset({ADVANCE_WITH_HEAVY_DAMAGE}),
            disposable_ship_strategy="allowed",
        ),
    )
    assert decision.advance is False
    assert decision.reason_code == "PROHIBITED"


def test_missing_ship_data_retreats() -> None:
    decision = decide_advance([ship(1, 40), None])
    assert decision.advance is False
    assert decision.reason_code == "UNKNOWN_STATE"


def test_unknown_damage_retreats() -> None:
    decision = decide_advance([Ship(instance_id=1, hp=None, max_hp=40)])
    assert decision.advance is False
    assert decision.reason_code == "UNKNOWN_DAMAGE"


def test_empty_fleet_retreats() -> None:
    assert decide_advance([]).advance is False


def test_decision_describe() -> None:
    text = decide_advance(
        DAMAGED, TaskConstraints(disposable_ship_strategy="allowed")
    ).describe()
    assert "進撃" in text
    assert "捨て艦: [2]" in text


def test_sortie_task_uses_its_constraints() -> None:
    state = free_fleet(make_state())
    state.ships[102].hp = 1  # 第2艦隊の艦を大破させる
    ctx = make_context(state)

    task = SortieTask(fleet_id=2, map_area=1, map_no=5)
    assert task.advance_decision(ctx).advance is False

    task.constraints = TaskConstraints(disposable_ship_strategy="allowed")
    assert task.advance_decision(ctx).advance is True


# ======================================================================
# 解体・建造
# ======================================================================


def test_dismantle_is_blocked_by_constraint() -> None:
    state = make_state()
    state.fleets[2].ship_ids = []
    task = DismantleTask([102])
    task.constraints = TaskConstraints(prohibit=frozenset({DISMANTLE_SHIPS}))

    result = task.execute(make_context(state))
    assert result.ok is False
    assert "解体は禁止されています" in result.message


def test_dismantle_runs_without_the_constraint() -> None:
    state = make_state()
    state.fleets[2].ship_ids = []
    assert DismantleTask([102]).execute(make_context(state)).ok is True


def test_large_build_is_blocked_by_constraint() -> None:
    state = add_build_docks(make_state())
    task = ConstructionTask(Recipe(400, 400, 400, 400))
    task.constraints = TaskConstraints(prohibit=frozenset({LARGE_BUILD}))

    result = task.execute(make_context(state))
    assert result.ok is False
    assert "大型建造は禁止" in result.message


def test_small_build_is_allowed_under_the_constraint() -> None:
    state = add_build_docks(make_state())
    task = ConstructionTask()
    task.constraints = TaskConstraints(prohibit=frozenset({LARGE_BUILD}))
    assert task.execute(make_context(state)).ok is True


def test_resource_efficiency_raises_the_bar() -> None:
    """「資源節約重視」は建造の判断を厳しくする。"""
    from core.state import Resources

    state = add_build_docks(make_state())
    # 燃料 1400。下限 1000 なので通常なら建造できる（1370 > 1000）。
    state.resources = Resources(**{**vars(state.resources), "fuel": 1400})

    assert ConstructionTask().execute(make_context(state)).ok is True

    strict = ConstructionTask()
    strict.constraints = TaskConstraints(resource_efficiency="high")
    result = strict.execute(make_context(add_build_docks(make_state())))
    assert result.ok is True  # 資材が潤沢なら通る

    state2 = add_build_docks(make_state())
    state2.resources = Resources(**{**vars(state2.resources), "fuel": 1400})
    strict2 = ConstructionTask()
    strict2.constraints = TaskConstraints(resource_efficiency="high")
    blocked = strict2.execute(make_context(state2))
    assert blocked.ok is False
    assert "下限を割ります" in blocked.message


# ======================================================================
# サンドボックスでの通し
# ======================================================================


def sortie_with(payload: dict) -> tuple[int, list[str]]:
    """制約付きで 1-5 を回し、戦闘回数を返す。"""
    from core.orchestrator import Orchestrator
    from core.scheduler import Scheduler
    from core.task_queue import TaskQueue
    from sandbox.session import SandboxSession

    session = SandboxSession.create(seed=11)
    session.bootstrap()
    session.game.maps["1-5"].enemy_strength = 260.0  # 大破が出る強さ
    queue = TaskQueue()
    queue.push(
        Task("sortie", TaskPriority.SORTIE, {"map": "1-5", "fleet_id": 1, **payload})
    )
    orchestrator = Orchestrator(
        source=session,
        game_state=session.game_state,
        safety=session.safety,
        queue=queue,
        scheduler=Scheduler(),
        execute=session.run_and_resolve,
    )
    report = orchestrator.tick()
    return len(report.result.details["ranks"]), report.result.details["ranks"]


def test_default_retreats_early() -> None:
    battles, _ = sortie_with({})
    assert battles < 5


def test_disposable_strategy_pushes_on() -> None:
    """同じ乱数・同じ海域でも、許可があれば進み続ける。"""
    default_battles, _ = sortie_with({})
    allowed_battles, _ = sortie_with({"disposable_ship_strategy": "allowed"})
    assert allowed_battles > default_battles


def test_prohibition_overrides_permission_end_to_end() -> None:
    allowed, _ = sortie_with({"disposable_ship_strategy": "allowed"})
    both, _ = sortie_with(
        {
            "disposable_ship_strategy": "allowed",
            "constraints": ["advance_with_heavy_damage"],
        }
    )
    assert both < allowed


def test_ai_sees_damage_during_the_sortie() -> None:
    """戦闘結果には HP が無い。艦の状態を別途流していることの確認。"""
    from sandbox.session import SandboxSession

    session = SandboxSession.create(seed=11)
    session.bootstrap()
    session.game.maps["1-5"].enemy_strength = 400.0
    session.game.start_sortie(1, "1-5")
    before = [s.hp for s in session.game_state.fleet_ships(1)]

    session.environment.records.extend(session.game.fight())
    session.sync()

    after = [s.hp for s in session.game_state.fleet_ships(1)]
    assert after != before

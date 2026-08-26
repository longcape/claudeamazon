"""時間経過の反映と、受け取りタスクのテスト。"""

from __future__ import annotations

from datetime import timedelta

import pytest

from core.orchestrator import Orchestrator
from core.scheduler import Scheduler
from core.state import FleetMissionState, ResourceKind
from core.task_queue import Task, TaskPriority, TaskQueue
from sandbox.session import SandboxSession
from tasks.collect_task import CollectBuildTask, CollectExpeditionTask
from tasks.factory import TaskBuildError, build_task


@pytest.fixture
def session() -> SandboxSession:
    session = SandboxSession.create(seed=7)
    session.bootstrap()
    session.environment.records.append(session.game.kdock_record())
    session.sync()
    return session


def advance_clock(session: SandboxSession, hours: float) -> None:
    """サンドボックスの時計を進める。"""
    base = session.game.clock()
    moved = lambda: base + timedelta(hours=hours)  # noqa: E731
    session.game.clock = moved
    session.game_state.clock = moved


# ======================================================================
# 時間経過の反映
# ======================================================================


def test_settle_does_nothing_when_idle(session: SandboxSession) -> None:
    assert session.game.settle() == []


def test_repair_completes_on_its_own(session: SandboxSession) -> None:
    """入渠は時間が来れば自動的に終わる。受け取りの操作は無い。"""
    session.game.ships[101].hp = 1
    session.environment.records.extend(session.game.repair(1, 101))
    session.sync()
    assert session.game.repair_docks[1]["state"] == 1

    advance_clock(session, 3)
    session.sync()

    assert session.game.ships[101].hp == session.game.ships[101].max_hp
    assert session.game.repair_docks[1]["state"] == 0
    assert session.game_state.repair_docks[1].is_busy is False


def test_expedition_becomes_returned_but_waits(session: SandboxSession) -> None:
    """遠征は帰投済みになるだけ。受け取りには操作が要る。"""
    session.environment.records.extend(session.game.start_expedition(2, 21))
    session.sync()

    advance_clock(session, 1)
    session.sync()

    assert session.game.fleets[2].mission_state == 3
    assert (
        session.game_state.fleets[2].mission.state is FleetMissionState.RETURNED
    )
    assert session.game_state.returned_expeditions() == [2]


def test_build_becomes_complete_but_waits(session: SandboxSession) -> None:
    session.environment.records.extend(
        session.game.build(1, {"fuel": 30, "ammo": 30, "steel": 30, "bauxite": 30})
    )
    session.sync()

    advance_clock(session, 1)
    session.sync()

    assert session.game.build_docks[1]["state"] == 3
    assert session.game_state.completed_builds() == [1]


def test_settle_is_idempotent(session: SandboxSession) -> None:
    session.environment.records.extend(session.game.start_expedition(2, 21))
    session.sync()
    advance_clock(session, 1)

    assert session.game.settle() != []
    assert session.game.settle() == []


# ======================================================================
# 受け取りタスク
# ======================================================================


def test_collect_expedition(session: SandboxSession) -> None:
    session.environment.records.extend(session.game.start_expedition(2, 21))
    session.sync()
    advance_clock(session, 1)
    session.sync()

    before = session.game.resource(ResourceKind.BAUXITE)
    result = session.run(CollectExpeditionTask(fleet_id=2))

    assert result.ok is True
    assert session.game.fleets[2].mission_state == 0
    assert session.game.resource(ResourceKind.BAUXITE) > before


def test_collect_expedition_rejects_a_fleet_still_out(
    session: SandboxSession,
) -> None:
    session.environment.records.extend(session.game.start_expedition(2, 5))
    session.sync()

    result = session.run(CollectExpeditionTask(fleet_id=2))
    assert result.ok is False
    assert "受け取り待ちではありません" in result.message


def test_collect_build(session: SandboxSession) -> None:
    session.environment.records.extend(
        session.game.build(1, {"fuel": 30, "ammo": 30, "steel": 30, "bauxite": 30})
    )
    session.sync()
    advance_clock(session, 1)
    session.sync()

    before = len(session.game.ships)
    result = session.run(CollectBuildTask(dock_id=1))

    assert result.ok is True
    assert len(session.game.ships) == before + 1
    assert session.game.build_docks[1]["state"] == 0


def test_collect_build_rejects_an_unfinished_dock(session: SandboxSession) -> None:
    session.environment.records.extend(
        session.game.build(1, {"fuel": 30, "ammo": 30, "steel": 30, "bauxite": 30})
    )
    session.sync()

    result = session.run(CollectBuildTask(dock_id=1))
    assert result.ok is False
    assert "受け取り待ちではありません" in result.message


def test_collect_build_stops_when_ship_slots_are_full(
    session: SandboxSession,
) -> None:
    """枠が無いまま受け取ると、その場で解体を迫られる。"""
    session.environment.records.extend(
        session.game.build(1, {"fuel": 30, "ammo": 30, "steel": 30, "bauxite": 30})
    )
    session.sync()
    advance_clock(session, 1)
    session.sync()
    session.game_state.player.ship_capacity = len(session.game_state.ships)

    result = session.run(CollectBuildTask(dock_id=1))
    assert result.ok is False
    assert "保有枠に空きがありません" in result.message


def test_factory_builds_collect_tasks() -> None:
    assert isinstance(
        build_task(Task("collect_expedition", TaskPriority.SAFETY_TASK, {"fleet_id": 2})),
        CollectExpeditionTask,
    )
    assert isinstance(
        build_task(Task("collect_build", TaskPriority.SAFETY_TASK, {"dock_id": 1})),
        CollectBuildTask,
    )
    with pytest.raises(TaskBuildError, match="fleet_id"):
        build_task(Task("collect_expedition", TaskPriority.SAFETY_TASK, {}))


# ======================================================================
# 常駐ループでの回収
# ======================================================================


def build_orchestrator(
    session: SandboxSession, queue: TaskQueue | None = None
) -> Orchestrator:
    return Orchestrator(
        source=session,
        game_state=session.game_state,
        safety=session.safety,
        # 空のキューは falsy なので `or` は使えない（渡した物が捨てられる）。
        queue=queue if queue is not None else TaskQueue(),
        scheduler=Scheduler(),
        execute=session.run_and_resolve,
    )


def test_daemon_collects_a_returned_expedition(session: SandboxSession) -> None:
    session.environment.records.extend(session.game.start_expedition(2, 21))
    session.sync()
    advance_clock(session, 1)

    orchestrator = build_orchestrator(session)
    orchestrator.clock = session.game.clock
    report = orchestrator.tick()

    assert report.collected
    assert report.executed == "collect_expedition"
    assert session.game.fleets[2].mission_state == 0


def test_daemon_collects_a_finished_build(session: SandboxSession) -> None:
    session.environment.records.extend(
        session.game.build(1, {"fuel": 30, "ammo": 30, "steel": 30, "bauxite": 30})
    )
    session.sync()
    advance_clock(session, 1)

    orchestrator = build_orchestrator(session)
    orchestrator.clock = session.game.clock
    report = orchestrator.tick()

    assert report.executed == "collect_build"
    assert session.game.build_docks[1]["state"] == 0


def test_collection_is_not_queued_twice(session: SandboxSession) -> None:
    """毎周同じ受け取りを積まない。"""
    session.environment.records.extend(session.game.start_expedition(2, 21))
    session.sync()
    advance_clock(session, 1)
    session.sync()

    queue = TaskQueue()
    orchestrator = build_orchestrator(session, queue)
    orchestrator.clock = session.game.clock

    assert len(orchestrator._enqueue_collections()) == 1
    assert orchestrator._enqueue_collections() == ()
    assert len(queue) == 1


def test_nothing_to_collect_reports_nothing(session: SandboxSession) -> None:
    report = build_orchestrator(session).tick()
    assert report.collected == ()
    assert report.did_work is False


def test_repair_needs_no_collection(session: SandboxSession) -> None:
    """入渠は自動で終わるので、受け取りタスクは積まれない。"""
    session.game.ships[101].hp = 1
    session.environment.records.extend(session.game.repair(1, 101))
    session.sync()
    advance_clock(session, 3)

    orchestrator = build_orchestrator(session)
    orchestrator.clock = session.game.clock
    report = orchestrator.tick()

    assert report.collected == ()
    assert session.game.ships[101].hp == session.game.ships[101].max_hp

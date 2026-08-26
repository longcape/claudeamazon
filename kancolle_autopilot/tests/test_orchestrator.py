"""タスク組み立てと常駐ループのテスト。"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone

import pytest

from core.orchestrator import Orchestrator, TickReport
from core.scheduler import Scheduler, TaskSpec
from core.state_machine import StateMachine, SystemState
from core.task_queue import Task, TaskPriority, TaskQueue
from notify.dispatcher import NotificationDispatcher
from notify.notifier import RecordingNotifier
from sandbox.session import SandboxSession
from tasks.construction_task import ConstructionTask
from tasks.daily_task import DailyTask
from tasks.dismantle_task import DismantleTask
from tasks.expedition_task import ExpeditionTask
from tasks.factory import TaskBuildError, build_task, parse_map
from tasks.sortie_task import SortieTask

T0 = datetime(2024, 5, 2, 12, 0, tzinfo=timezone.utc)


# ======================================================================
# タスクの組み立て
# ======================================================================


def make(name: str, **payload) -> Task:
    return Task(name=name, priority=TaskPriority.BACKGROUND, payload=payload)


def test_build_sortie_from_map_label() -> None:
    task = build_task(make("sortie", map="5-5", fleet_id=2))
    assert isinstance(task, SortieTask)
    assert (task.map_area, task.map_no, task.fleet_id) == (5, 5, 2)


def test_build_sortie_from_components() -> None:
    task = build_task(make("sortie", map_area=1, map_no=6))
    assert task.map_label == "1-6"


def test_sortie_uses_default_fleet() -> None:
    assert build_task(make("sortie", map="1-5")).fleet_id == 1


def test_sortie_without_map_is_rejected() -> None:
    """既定値で埋めない。意図しない海域へ出さないため。"""
    with pytest.raises(TaskBuildError, match="出撃先が指定されていません"):
        build_task(make("sortie"))


@pytest.mark.parametrize("label", ["55", "五-五", "1-", "-5"])
def test_bad_map_label(label) -> None:
    with pytest.raises(TaskBuildError):
        parse_map({"map": label})


def test_build_expedition() -> None:
    task = build_task(make("expedition", fleet_id=3, mission_id=21))
    assert isinstance(task, ExpeditionTask)
    assert (task.fleet_id, task.mission_id) == (3, 21)


def test_expedition_without_mission_is_rejected() -> None:
    with pytest.raises(TaskBuildError, match="mission_id"):
        build_task(make("expedition", fleet_id=2))


def test_build_daily() -> None:
    task = build_task(make("daily", quest_ids=[201, 303]))
    assert isinstance(task, DailyTask)
    assert task.quest_ids == (201, 303)


def test_build_construction_defaults_to_minimum_recipe() -> None:
    task = build_task(make("construction"))
    assert isinstance(task, ConstructionTask)
    assert task.recipe.as_payload() == {
        "fuel": 30,
        "ammo": 30,
        "steel": 30,
        "bauxite": 30,
    }


def test_build_construction_with_recipe_mapping() -> None:
    task = build_task(make("construction", recipe={"fuel": 250, "steel": 200}))
    assert task.recipe.fuel == 250
    assert task.recipe.ammo == 30


def test_build_construction_with_recipe_list() -> None:
    task = build_task(make("construction", recipe=[100, 200, 300, 400]))
    assert task.recipe.bauxite == 400


def test_build_construction_rejects_short_recipe() -> None:
    with pytest.raises(TaskBuildError, match="4 つの数値"):
        build_task(make("construction", recipe=[30, 30]))


def test_build_dismantle() -> None:
    task = build_task(make("dismantle", ship_ids=[105, 106]))
    assert isinstance(task, DismantleTask)
    assert task.candidate_ids == (105, 106)


def test_dismantle_without_ships_is_rejected() -> None:
    with pytest.raises(TaskBuildError, match="解体候補"):
        build_task(make("dismantle"))


def test_unknown_task_name() -> None:
    with pytest.raises(TaskBuildError, match="未知のタスク"):
        build_task(make("mystery"))


def test_extra_payload_keys_are_ignored() -> None:
    """制約や目標のように全タスクへ載せている項目は無視する。"""
    task = build_task(
        make(
            "sortie",
            map="1-5",
            constraints=["advance_with_heavy_damage"],
            resource_efficiency="high",
            goal={"objective": "destroy_gauge"},
        )
    )
    assert task.map_label == "1-5"


# ======================================================================
# 常駐ループ
# ======================================================================


@pytest.fixture
def session() -> SandboxSession:
    session = SandboxSession.create(seed=7)
    session.bootstrap()
    return session


def build_orchestrator(
    session: SandboxSession,
    queue: TaskQueue | None = None,
    scheduler: Scheduler | None = None,
    dispatcher: NotificationDispatcher | None = None,
) -> Orchestrator:
    return Orchestrator(
        source=session,
        game_state=session.game_state,
        safety=session.safety,
        # 空のキューは falsy なので `or` は使えない（渡した物が捨てられる）。
        queue=queue if queue is not None else TaskQueue(),
        scheduler=scheduler if scheduler is not None else Scheduler(),
        execute=session.run,
        dispatcher=dispatcher,
    )


def test_clock_follows_the_state(session: SandboxSession) -> None:
    """鮮度は状態を観測した時計で測る。"""
    orchestrator = build_orchestrator(session)
    assert orchestrator.clock is session.game_state.clock


def test_idle_tick_does_nothing(session: SandboxSession) -> None:
    report = build_orchestrator(session).tick()
    assert report.state is SystemState.IDLE
    assert report.did_work is False
    assert report.note == "待機"


def test_executes_queued_task(session: SandboxSession) -> None:
    queue = TaskQueue()
    queue.push(make("sortie", map="1-5", fleet_id=1))
    report = build_orchestrator(session, queue).tick()

    assert report.executed == "sortie"
    assert report.result.ok is True
    assert session.game.sortie is not None


def test_runs_in_priority_order(session: SandboxSession) -> None:
    queue = TaskQueue()
    queue.push(Task("sortie", TaskPriority.SORTIE, {"map": "1-5"}))
    queue.push(Task("construction", TaskPriority.DAILY_TASK, {}))
    session.environment.records.append(session.game.kdock_record())

    orchestrator = build_orchestrator(session, queue)
    assert orchestrator.tick().executed == "construction"
    assert orchestrator.tick().executed == "sortie"


def test_returns_to_idle_between_cycles(session: SandboxSession) -> None:
    """常駐は IDLE から次の周を始める。"""
    orchestrator = build_orchestrator(session)
    orchestrator.tick()
    orchestrator.tick()
    assert orchestrator.machine.state is SystemState.IDLE
    assert all(t.valid for t in orchestrator.machine.history)


def test_malformed_task_fails_without_stopping(session: SandboxSession) -> None:
    """指定ミスは実行前に弾ける。止めずに次へ進む。"""
    queue = TaskQueue()
    queue.push(make("sortie"))  # map が無い
    queue.push(make("expedition", fleet_id=2, mission_id=5))
    orchestrator = build_orchestrator(session, queue)

    first = orchestrator.tick()
    assert first.result.ok is False
    assert "組み立てに失敗" in first.note
    assert orchestrator.machine.is_stopped is False

    assert orchestrator.tick().executed == "expedition"


def test_safety_stop_halts_the_loop(session: SandboxSession) -> None:
    queue = TaskQueue()
    queue.push(make("sortie", map="1-5"))
    orchestrator = build_orchestrator(session, queue)
    orchestrator.safety.trigger_emergency_stop("手動停止")

    report = orchestrator.tick()
    assert report.state is SystemState.EMERGENCY_STOP
    assert report.executed is None
    assert len(orchestrator.queue) == 1  # 消費していない


def test_loop_resumes_after_clearing_the_stop(session: SandboxSession) -> None:
    queue = TaskQueue()
    queue.push(make("sortie", map="1-5"))
    orchestrator = build_orchestrator(session, queue)
    orchestrator.safety.trigger_emergency_stop("手動停止")
    orchestrator.tick()

    orchestrator.commands.handle_text("resume")
    report = orchestrator.tick()
    assert report.executed == "sortie"
    assert orchestrator.machine.state is SystemState.IDLE


def test_reservations_are_promoted(session: SandboxSession) -> None:
    scheduler = Scheduler()
    scheduler.reserve(
        session.game.clock() - timedelta(seconds=10),
        [TaskSpec("expedition", TaskPriority.EXPEDITION, {"fleet_id": 2, "mission_id": 5})],
        name="朝の遠征",
    )
    orchestrator = build_orchestrator(session, scheduler=scheduler)

    report = orchestrator.tick()
    assert report.fired
    assert report.executed == "expedition"


def test_expired_reservation_is_not_run(session: SandboxSession) -> None:
    scheduler = Scheduler()
    scheduler.reserve(
        session.game.clock() - timedelta(days=1),
        [TaskSpec("expedition", TaskPriority.EXPEDITION, {"mission_id": 5})],
    )
    report = build_orchestrator(session, scheduler=scheduler).tick()
    assert report.fired == ()
    assert report.executed is None


def test_notifications_are_sent(session: SandboxSession) -> None:
    sent = RecordingNotifier()
    queue = TaskQueue()
    queue.push(make("sortie", map="1-5"))
    build_orchestrator(session, queue, dispatcher=NotificationDispatcher(sent)).tick()
    assert "TASK COMPLETED" in sent.kinds()


def test_stop_notification(session: SandboxSession) -> None:
    sent = RecordingNotifier()
    orchestrator = build_orchestrator(
        session, dispatcher=NotificationDispatcher(sent)
    )
    orchestrator.safety.trigger_emergency_stop("資材の急減")
    orchestrator.tick()
    assert "SAFETY STOP" in sent.kinds()


# ======================================================================
# コマンド
# ======================================================================


def test_commands_are_processed_each_cycle(session: SandboxSession) -> None:
    pending = ["status", "stop 点検"]
    orchestrator = build_orchestrator(session)
    orchestrator.command_source = lambda: [pending.pop(0)] if pending else []

    replies = orchestrator.handle_commands()
    assert "資材:" in replies[0]
    replies = orchestrator.handle_commands()
    assert "緊急停止しました" in replies[0]
    assert orchestrator.safety.is_stopped is True


def test_unknown_command_is_reported_not_executed(session: SandboxSession) -> None:
    orchestrator = build_orchestrator(session)
    orchestrator.command_source = lambda: ["1-5を周回して"]
    replies = orchestrator.handle_commands()
    assert "自然言語の指示はここでは実行しません" in replies[0]


# ======================================================================
# 常駐
# ======================================================================


def test_run_stops_after_max_ticks(session: SandboxSession) -> None:
    queue = TaskQueue()
    queue.push(make("sortie", map="1-5"))
    orchestrator = build_orchestrator(session, queue)
    reports: list[TickReport] = []

    ticks = orchestrator.run(interval=0, on_tick=reports.append, max_ticks=3)
    assert ticks == 3
    assert reports[0].executed == "sortie"


def test_run_stops_on_event(session: SandboxSession) -> None:
    orchestrator = build_orchestrator(session)
    stop = threading.Event()
    orchestrator.run(stop=stop, interval=0, on_tick=lambda _: stop.set())
    assert orchestrator.machine.state is SystemState.IDLE


def test_shutdown_ends_the_loop(session: SandboxSession) -> None:
    orchestrator = build_orchestrator(session)
    orchestrator.shutdown("終了")
    report = orchestrator.tick()
    assert report.note == "終了済み"
    assert orchestrator.run(interval=0, max_ticks=5) == 1

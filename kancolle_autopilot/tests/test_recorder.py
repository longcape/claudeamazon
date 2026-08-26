"""SessionRecorder と、サンドボックスへ繋いだときの記録のテスト。"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from monitor.api_parser import APIParser
from monitor.game_state import GameState
from recording.recorder import SessionRecorder
from recording.timeline import BreakpointSet, EventKind, TimelineEvent
from sandbox.session import SandboxSession
from tasks.sortie_task import SortieTask
from tests.helpers import load_fixture

T0 = datetime(2024, 5, 2, 10, 52, tzinfo=timezone.utc)


@pytest.fixture
def ticking_recorder() -> SessionRecorder:
    """呼ばれるたびに 1 秒進む時計を持つ記録係。"""
    counter = iter(range(0, 10_000))
    return SessionRecorder(clock=lambda: T0 + timedelta(seconds=next(counter)))


@pytest.fixture
def state() -> GameState:
    state = GameState()
    state.apply_all(APIParser().parse_record(load_fixture("port.json")))
    return state


# ======================================================================
# 記録
# ======================================================================


def test_record_appends_to_timeline(ticking_recorder: SessionRecorder) -> None:
    event = ticking_recorder.record(EventKind.CLICK, "quest_button", task_id="t1")
    assert ticking_recorder.timeline[-1] is event
    assert event.task_id == "t1"


def test_record_actions_maps_kinds(ticking_recorder: SessionRecorder) -> None:
    from automation.interface import Action, ActionKind, ActionResult, Screen

    results = [
        ActionResult(Action(ActionKind.NAVIGATE, "QUEST"), True, True, screen=Screen.QUEST),
        ActionResult(Action(ActionKind.CLICK, "tab_daily"), True, True),
        ActionResult(Action(ActionKind.WAIT, "QUEST"), True, True),
    ]
    ticking_recorder.record_actions(results, "t1")
    assert [e.kind for e in ticking_recorder.timeline] == [
        EventKind.SCREEN_CHANGE,
        EventKind.CLICK,
        EventKind.WAIT,
    ]


def test_record_cursor(ticking_recorder: SessionRecorder) -> None:
    from automation.mouse_controller import CursorSample
    from automation.screen_detector import Point

    ticking_recorder.record_cursor(
        [
            CursorSample(Point(1, 2), T0, "MOVE"),
            CursorSample(Point(3, 4), T0, "CLICK"),
        ],
        "t1",
    )
    assert [e.kind for e in ticking_recorder.timeline] == [
        EventKind.MOVE,
        EventKind.CLICK,
    ]
    assert ticking_recorder.timeline[0].label == "(1, 2)"


def test_decide_records_state_summary(
    ticking_recorder: SessionRecorder, state: GameState
) -> None:
    decision = ticking_recorder.decide(
        state,
        decision="START_SORTIE",
        reason_code="TARGET_PROGRESS",
        expected_result="BATTLE_START",
        constraints=["NO_HEAVY_DAMAGE_ADVANCE"],
    )
    assert decision.input_state_summary["fuel"] == 25000
    assert ticking_recorder.timeline[-1].kind is EventKind.DECISION
    assert decision.constraints == ("NO_HEAVY_DAMAGE_ADVANCE",)


def test_screen_changed_ignores_no_op(ticking_recorder: SessionRecorder) -> None:
    assert ticking_recorder.screen_changed("HOME", "HOME") is None
    assert len(ticking_recorder.timeline) == 0
    assert ticking_recorder.screen_changed("HOME", "QUEST") is not None


# ======================================================================
# スナップショット
# ======================================================================


def test_snapshot_freezes_state(
    ticking_recorder: SessionRecorder, state: GameState
) -> None:
    """後から「その瞬間 AI が何を知っていたか」を引ける。"""
    index = ticking_recorder.snapshot(state, "出撃前")
    state.ships[101].level = 1  # 現在の状態だけが変わる

    assert ticking_recorder.snapshot_at(index).ships[101].level == 99


def test_snapshot_at_returns_nearest_preceding(
    ticking_recorder: SessionRecorder, state: GameState
) -> None:
    first = ticking_recorder.snapshot(state, "1回目")
    ticking_recorder.record(EventKind.CLICK, "x")
    second = ticking_recorder.snapshot(state, "2回目")

    assert ticking_recorder.snapshot_at(first + 1) is ticking_recorder.snapshots[first]
    assert ticking_recorder.snapshot_at(second) is ticking_recorder.snapshots[second]


def test_snapshot_at_before_any_snapshot(ticking_recorder: SessionRecorder) -> None:
    ticking_recorder.record(EventKind.CLICK, "x")
    assert ticking_recorder.snapshot_at(0) is None


# ======================================================================
# 停止（§17 / §18）
# ======================================================================


def test_breakpoint_pauses(ticking_recorder: SessionRecorder) -> None:
    paused: list[TimelineEvent] = []
    ticking_recorder.breakpoints = BreakpointSet.from_names(["on_damage"])
    ticking_recorder.on_pause = paused.append

    ticking_recorder.record(EventKind.CLICK, "x")
    ticking_recorder.record(EventKind.DAMAGE, "大破: [103]")

    assert [e.kind for e in paused] == [EventKind.DAMAGE]
    assert len(ticking_recorder.paused_at) == 1


def test_step_mode_pauses_on_every_event(ticking_recorder: SessionRecorder) -> None:
    paused: list[TimelineEvent] = []
    ticking_recorder.step_mode = True
    ticking_recorder.on_pause = paused.append

    ticking_recorder.record(EventKind.CLICK, "a")
    ticking_recorder.record(EventKind.CLICK, "b")
    assert len(paused) == 2


def test_pause_without_handler_does_not_fail(
    ticking_recorder: SessionRecorder,
) -> None:
    ticking_recorder.step_mode = True
    ticking_recorder.record(EventKind.CLICK, "a")
    assert len(ticking_recorder.paused_at) == 1


# ======================================================================
# 保存
# ======================================================================


def test_save_writes_timeline_and_decisions(
    tmp_path: Path, ticking_recorder: SessionRecorder, state: GameState
) -> None:
    ticking_recorder.decide(state, "SORTIE", "TARGET_PROGRESS")
    ticking_recorder.record(EventKind.CLICK, "sortie_start")
    paths = ticking_recorder.save(tmp_path)

    lines = paths["timeline"].read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    decisions = json.loads(paths["decisions"].read_text(encoding="utf-8"))
    assert decisions[0]["decision"] == "SORTIE"


def test_summary_reports_counts(
    ticking_recorder: SessionRecorder, state: GameState
) -> None:
    ticking_recorder.decide(state, "A", "R", expected_result="X").resolve("Y")
    summary = ticking_recorder.summary()
    assert summary["decisions"] == 1
    assert summary["mismatched_decisions"] == 1


# ======================================================================
# サンドボックスへ繋いだとき
# ======================================================================


@pytest.fixture
def session() -> SandboxSession:
    session = SandboxSession.create(seed=7, recorder=SessionRecorder())
    session.bootstrap()
    return session


def kinds(session: SandboxSession) -> list[EventKind]:
    return [event.kind for event in session.recorder.timeline]


def test_task_run_is_recorded(session: SandboxSession) -> None:
    # bootstrap の分を除いて、タスク実行以降だけを見る。
    start = len(session.recorder.timeline)
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    recorded = kinds(session)[start:]

    assert recorded[0] is EventKind.TASK_START
    assert EventKind.DECISION in recorded
    assert EventKind.CLICK in recorded
    assert recorded[-1] is EventKind.TASK_END


def test_task_events_share_a_task_id(session: SandboxSession) -> None:
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    task_ids = {
        event.task_id for event in session.recorder.timeline if event.task_id
    }
    assert len(task_ids) == 1


def test_decision_is_resolved_after_the_task(session: SandboxSession) -> None:
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    decision = session.recorder.decisions.latest()
    assert decision.actual_result == "TASK_COMPLETED"
    assert decision.matched_expectation is True


def test_failed_task_records_mismatch(session: SandboxSession) -> None:
    """止められたタスクは、判断と結果のずれとして残る。"""
    for ship in session.game.fleet_ships(1):
        ship.hp = 1
    session.environment.records.append(session.game.port_record())
    session.sync()

    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    assert session.recorder.decisions.mismatched()


def test_battle_events_are_recorded(session: SandboxSession) -> None:
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    session.fight_through()
    recorded = kinds(session)

    assert recorded.count(EventKind.BATTLE_START) == recorded.count(
        EventKind.BATTLE_END
    )
    assert EventKind.RESOURCE_CHANGE in recorded


def test_unknown_drop_is_recorded_as_safety_warning() -> None:
    session = SandboxSession.create(seed=3, recorder=SessionRecorder())
    session.bootstrap()
    session.game.maps["1-5"].drop_pool = (1004,)  # 未所持
    session.game.battle.drop_rate = 1.0

    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    session.fight_through()

    warnings = session.recorder.timeline.of_kind(EventKind.SAFETY_WARNING)
    assert warnings
    assert "未所持艦" in warnings[0].label


def test_snapshot_preserves_pre_task_state(session: SandboxSession) -> None:
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    session.fight_through()

    before = session.recorder.snapshot_at(len(session.recorder.timeline) - 1)
    assert len(before.ships) < len(session.game_state.ships)


def test_breakpoint_stops_a_running_session() -> None:
    recorder = SessionRecorder(
        breakpoints=BreakpointSet.from_names(["on_battle_end"])
    )
    paused: list[TimelineEvent] = []
    recorder.on_pause = paused.append

    session = SandboxSession.create(seed=7, recorder=recorder)
    session.bootstrap()
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    ranks = session.fight_through()

    assert len(paused) == len(ranks)


def test_session_without_recorder_still_runs() -> None:
    session = SandboxSession.create(seed=7)
    session.bootstrap()
    assert session.run(SortieTask(fleet_id=1, map_area=1, map_no=5)).ok is True

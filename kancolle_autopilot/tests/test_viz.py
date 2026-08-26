"""可視化のテスト。"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from automation.interface import Screen
from monitor.api_parser import APIParser
from monitor.game_state import GameState
from recording.decision_log import Decision
from recording.recorder import SessionRecorder
from recording.timeline import EventKind, Timeline, TimelineEvent
from tests.helpers import load_fixture
from viz.model import (
    all_screens,
    build_data,
    decision_view,
    screen_widgets,
    snapshot_view,
)
from viz.report import build_report, report_from_recorder, write_report

T0 = datetime(2024, 5, 2, 10, 52, tzinfo=timezone.utc)


def event(kind: EventKind, label: str = "", offset: float = 0.0, **kwargs) -> TimelineEvent:
    return TimelineEvent(
        kind=kind, label=label, at=T0 + timedelta(seconds=offset), **kwargs
    )


@pytest.fixture
def timeline() -> Timeline:
    return Timeline(
        [
            event(EventKind.TASK_START, "sortie", 0.0, task_id="t1"),
            event(EventKind.DECISION, "SORTIE", 0.2, task_id="t1"),
            event(EventKind.SCREEN_CHANGE, "SORTIE_SELECT", 0.4, screen="SORTIE_SELECT"),
            event(EventKind.MOVE, "(100, 200)", 0.5, detail={"x": 100, "y": 200}),
            event(EventKind.CLICK, "sortie_start", 0.6, screen="SORTIE_SELECT"),
            event(EventKind.TASK_END, "t1 成功", 1.0, task_id="t1"),
        ]
    )


@pytest.fixture
def state() -> GameState:
    state = GameState()
    state.apply_all(APIParser().parse_record(load_fixture("port.json")))
    return state


def payload_of(html: str) -> dict:
    """埋め込まれた JSON を取り出す。"""
    raw = html.split("const DATA = ")[1].split(";\nconst view")[0]
    return json.loads(raw.replace("<\\/", "</"))


# ======================================================================
# 表示用データ
# ======================================================================


def test_screen_widgets_expand_indexed_targets() -> None:
    names = [widget["name"] for widget in screen_widgets(Screen.EXPEDITION)]
    assert "mission_1" in names
    assert "mission_40" in names
    assert "mission_start" in names


def test_all_screens_skips_empty_ones() -> None:
    screens = all_screens()
    assert "HOME" in screens
    assert "UNKNOWN" not in screens


def test_snapshot_view_is_compact(state: GameState) -> None:
    view = snapshot_view(state)
    assert view["資材"]["燃料"] == 25000
    assert len(view["艦"]) == 3
    assert view["艦"][2]["状態"] == "大破"
    assert view["艦"][0]["ロック"] == "済"


def test_decision_view_marks_mismatch() -> None:
    decision = Decision("SORTIE", "R", expected_result="X")
    decision.resolve("Y")
    assert decision_view(decision)["matched"] is False


def test_build_data_counts(timeline: Timeline) -> None:
    data = build_data(timeline, title="テスト")
    assert data.counts["CLICK"] == 1
    assert data.mismatched == 0
    assert len(data.events) == len(timeline)


# ======================================================================
# HTML
# ======================================================================


def test_report_is_self_contained(timeline: Timeline) -> None:
    """外部の CSS も JS も読み込まない。記録ごと持ち歩ける。"""
    html = build_report(timeline)
    assert re.findall(r'(?:src|href)="(?!#)[^"]+"', html) == []
    assert "<script>" in html


def test_report_embeds_the_timeline(timeline: Timeline) -> None:
    data = payload_of(build_report(timeline))
    assert len(data["events"]) == len(timeline)
    assert data["events"][0]["kind"] == "TASK_START"


def test_report_embeds_screen_layout(timeline: Timeline) -> None:
    data = payload_of(build_report(timeline))
    assert any(w["name"] == "sortie_start" for w in data["screens"]["SORTIE_SELECT"])


def test_report_escapes_script_terminator() -> None:
    """記録に紛れた "</script>" でページを壊さない。"""
    hostile = Timeline([event(EventKind.CLICK, "</script><img src=x>")])
    html = build_report(hostile)
    raw = html.split("const DATA = ")[1].split(";\nconst view")[0]

    assert "</script>" not in raw
    assert payload_of(html)["events"][0]["label"] == "</script><img src=x>"


def test_report_includes_decisions_and_snapshots(
    timeline: Timeline, state: GameState
) -> None:
    decision = Decision("SORTIE", "TARGET_PROGRESS", expected_result="OK", at=T0)
    data = payload_of(build_report(timeline, [decision], {2: state}))

    assert data["decisions"][0]["decision"] == "SORTIE"
    assert data["snapshots"]["2"]["資材"]["燃料"] == 25000


def test_report_title_is_used(timeline: Timeline) -> None:
    assert "<title>周回の記録</title>" in build_report(timeline, title="周回の記録")


def test_empty_timeline_still_renders() -> None:
    html = build_report(Timeline())
    assert payload_of(html)["events"] == []


def test_write_report(tmp_path: Path, timeline: Timeline) -> None:
    path = write_report(tmp_path / "report.html", build_report(timeline))
    assert path.exists()
    assert path.read_text(encoding="utf-8").startswith("<!doctype html>")


# ======================================================================
# 記録からの生成
# ======================================================================


def test_report_from_a_real_session() -> None:
    from core.task_queue import Task, TaskPriority, TaskQueue
    from core.orchestrator import Orchestrator
    from core.scheduler import Scheduler
    from sandbox.session import SandboxSession

    recorder = SessionRecorder()
    session = SandboxSession.create(seed=11, recorder=recorder)
    session.bootstrap()
    queue = TaskQueue()
    queue.push(Task("sortie", TaskPriority.SORTIE, {"map": "1-5", "fleet_id": 1}))
    Orchestrator(
        source=session,
        game_state=session.game_state,
        safety=session.safety,
        queue=queue,
        scheduler=Scheduler(),
        execute=session.run_and_resolve,
    ).tick()

    data = payload_of(report_from_recorder(recorder, "通し"))
    kinds = {entry["kind"] for entry in data["events"]}
    assert {"TASK_START", "DECISION", "CLICK", "MOVE", "TASK_END"} <= kinds
    assert data["decisions"]
    assert data["snapshots"]
    # カーソルの軌跡が座標付きで残っている。
    assert any(entry["detail"].get("x") for entry in data["events"])

"""Timeline / DecisionLog / ReplayPlayer のテスト。"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from recording.decision_log import Decision, DecisionLog, summarize_state
from recording.replay import ReplayPlayer, filter_noise, summarize
from recording.timeline import (
    BREAKPOINTS,
    BreakpointSet,
    EventKind,
    Timeline,
    TimelineEvent,
    UnknownBreakpoint,
)

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
            event(EventKind.DECISION, "SORTIE", 0.5, task_id="t1"),
            event(EventKind.MOVE, "(10, 10)", 0.6, task_id="t1"),
            event(EventKind.CLICK, "sortie_start", 0.8, task_id="t1"),
            event(EventKind.SCREEN_CHANGE, "SORTIE_MAP", 1.0),
            event(EventKind.BATTLE_END, "S", 2.0),
            event(EventKind.TASK_END, "t1 成功", 2.5, task_id="t1"),
        ]
    )


# ======================================================================
# タイムライン
# ======================================================================


def test_describe_uses_spec_format() -> None:
    line = event(EventKind.CLICK, "QUEST", 0.0).describe()
    assert line.startswith("10:52:00.000 CLICK = QUEST")


def test_describe_includes_task_id() -> None:
    assert "[t1]" in event(EventKind.CLICK, "x", task_id="t1").describe()


def test_of_kind(timeline: Timeline) -> None:
    assert len(timeline.of_kind(EventKind.CLICK, EventKind.MOVE)) == 2


def test_of_task(timeline: Timeline) -> None:
    assert len(timeline.of_task("t1")) == 5


def test_round_trip_through_jsonl(tmp_path: Path, timeline: Timeline) -> None:
    path = tmp_path / "timeline.jsonl"
    timeline.save(path)
    restored = Timeline.load(path)

    assert len(restored) == len(timeline)
    assert restored[0].kind is EventKind.TASK_START
    assert restored[3].label == "sortie_start"
    assert restored[0].at == T0


def test_load_missing_file_is_empty(tmp_path: Path) -> None:
    assert len(Timeline.load(tmp_path / "absent.jsonl")) == 0


def test_load_skips_broken_lines(tmp_path: Path) -> None:
    """1 行壊れていても、残りの記録は失わない。"""
    path = tmp_path / "timeline.jsonl"
    good = event(EventKind.CLICK, "ok").to_dict()
    path.write_text(
        "{ broken\n"
        + json.dumps({"kind": "NOPE", "at": T0.isoformat()})
        + "\n"
        + json.dumps(good)
        + "\n",
        encoding="utf-8",
    )
    restored = Timeline.load(path)
    assert [e.label for e in restored] == ["ok"]


# ======================================================================
# ブレークポイント
# ======================================================================


def test_breakpoint_names_match_spec() -> None:
    """追加指示書 §18 の名前をすべて受け付ける。"""
    for name in (
        "on_task_start",
        "on_battle_start",
        "on_battle_end",
        "on_damage",
        "on_resource_change",
        "on_screen_change",
        "on_safety_warning",
        "on_decision",
    ):
        assert name in BREAKPOINTS


def test_breakpoint_matches() -> None:
    points = BreakpointSet.from_names(["on_battle_end"])
    assert points.matches(event(EventKind.BATTLE_END)) is True
    assert points.matches(event(EventKind.CLICK)) is False


def test_unknown_breakpoint_is_rejected() -> None:
    with pytest.raises(UnknownBreakpoint, match="未知のブレークポイント"):
        BreakpointSet.from_names(["on_typo"])


def test_empty_breakpoint_set_is_falsy() -> None:
    assert bool(BreakpointSet.from_names([])) is False
    assert bool(BreakpointSet.from_names(["on_damage"])) is True


# ======================================================================
# 判断ログ
# ======================================================================


def test_decision_resolves() -> None:
    decision = Decision("SORTIE", "TARGET_PROGRESS", expected_result="BATTLE_START")
    assert decision.is_resolved is False
    assert decision.matched_expectation is None

    decision.resolve("BATTLE_START")
    assert decision.matched_expectation is True


def test_mismatched_decisions_are_findable() -> None:
    log = DecisionLog()
    log.record(Decision("A", "R", expected_result="X")).resolve("X")
    log.record(Decision("B", "R", expected_result="X")).resolve("Y")

    assert [d.decision for d in log.mismatched()] == ["B"]
    assert log.unresolved() == []


def test_latest_filters_by_task() -> None:
    log = DecisionLog()
    log.record(Decision("A", "R", task_id="t1"))
    log.record(Decision("B", "R", task_id="t2"))
    assert log.latest("t1").decision == "A"
    assert log.latest().decision == "B"


def test_decision_describe_omits_empty_fields() -> None:
    text = Decision("SORTIE", "TARGET_PROGRESS").describe()
    assert "constraints" not in text
    assert "actual_result" not in text


def test_summarize_state_is_compact() -> None:
    from monitor.api_parser import APIParser
    from monitor.game_state import GameState
    from tests.helpers import load_fixture

    state = GameState()
    state.apply_all(APIParser().parse_record(load_fixture("port.json")))
    summary = summarize_state(state)

    assert summary["fuel"] == 25000
    assert summary["ships"] == 3
    assert summary["heavy_damage"] == [103]


# ======================================================================
# リプレイ
# ======================================================================


def test_step_advances_one(timeline: Timeline) -> None:
    player = ReplayPlayer(timeline, sleep=lambda _: None)
    assert player.step()[0].kind is EventKind.TASK_START
    assert player.progress == "1/7"


def test_step_stops_at_end(timeline: Timeline) -> None:
    player = ReplayPlayer(timeline, sleep=lambda _: None)
    player.step(100)
    assert player.finished is True
    assert player.step() == []


def test_restart(timeline: Timeline) -> None:
    player = ReplayPlayer(timeline, sleep=lambda _: None)
    player.step(3)
    player.restart()
    assert player.position == 0
    assert player.current() is None


def test_jump_to_index(timeline: Timeline) -> None:
    player = ReplayPlayer(timeline, sleep=lambda _: None)
    assert player.jump(4).kind is EventKind.SCREEN_CHANGE
    assert player.current().kind is EventKind.SCREEN_CHANGE


def test_jump_clamps_out_of_range(timeline: Timeline) -> None:
    player = ReplayPlayer(timeline, sleep=lambda _: None)
    assert player.jump(999).kind is EventKind.TASK_END
    assert player.jump(-5).kind is EventKind.TASK_START


def test_jump_on_empty_timeline() -> None:
    player = ReplayPlayer(Timeline(), sleep=lambda _: None)
    assert player.jump(0) is None


def test_seek_finds_next_matching_event(timeline: Timeline) -> None:
    player = ReplayPlayer(timeline, sleep=lambda _: None)
    assert player.seek(EventKind.BATTLE_END).label == "S"
    assert player.seek(EventKind.BATTLE_END) is None


def test_play_honours_recorded_gaps(timeline: Timeline) -> None:
    """等間隔ではなく、記録された時刻差で待つ。"""
    slept: list[float] = []
    player = ReplayPlayer(timeline, sleep=slept.append)
    player.play(speed=1.0)

    assert slept == pytest.approx([0.5, 0.1, 0.2, 0.2, 1.0, 0.5])


def test_play_speed_divides_the_wait(timeline: Timeline) -> None:
    slept: list[float] = []
    ReplayPlayer(timeline, sleep=slept.append).play(speed=10.0)
    assert slept[0] == pytest.approx(0.05)


def test_play_rejects_zero_speed(timeline: Timeline) -> None:
    with pytest.raises(ValueError, match="正の数"):
        ReplayPlayer(timeline, sleep=lambda _: None).play(speed=0)


def test_play_limit(timeline: Timeline) -> None:
    player = ReplayPlayer(timeline, sleep=lambda _: None)
    assert len(player.play(limit=2)) == 2
    assert player.finished is False


def test_play_invokes_callback(timeline: Timeline) -> None:
    seen: list[str] = []
    ReplayPlayer(timeline, sleep=lambda _: None).play(
        on_event=lambda e: seen.append(e.kind.value)
    )
    assert seen[0] == "TASK_START"


def test_render_marks_current(timeline: Timeline) -> None:
    player = ReplayPlayer(timeline, sleep=lambda _: None)
    player.jump(3)
    lines = player.render(window=1)
    assert any(line.startswith(">") and "sortie_start" in line for line in lines)


def test_render_on_empty_timeline() -> None:
    assert ReplayPlayer(Timeline()).render() == ["（記録がありません）"]


def test_summarize_counts(timeline: Timeline) -> None:
    assert summarize(timeline)["CLICK"] == 1


def test_filter_noise_drops_moves(timeline: Timeline) -> None:
    """カーソルの MOVE は流れを追うとき邪魔になる。"""
    assert len(filter_noise(timeline)) == len(timeline) - 1
    assert len(filter_noise(timeline, [EventKind.CLICK])) == len(timeline) - 1

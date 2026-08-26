"""Scheduler のテスト。"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from core.scheduler import (
    Reservation,
    ReservationStatus,
    Scheduler,
    TaskSpec,
)
from core.task_queue import TaskPriority, TaskQueue

T0 = datetime(2024, 1, 1, 10, 52, tzinfo=timezone.utc)

#: 指示書 §19 の例（起動 → デイリー → 遠征 → 周回）。
PLAYLIST = [
    TaskSpec("daily", TaskPriority.DAILY_TASK),
    TaskSpec("expedition", TaskPriority.EXPEDITION),
    TaskSpec("sortie", TaskPriority.SORTIE, {"map": "1-5"}),
]


@pytest.fixture
def scheduler() -> Scheduler:
    return Scheduler()


# -- 予約 -----------------------------------------------------------------


def test_reserve_and_list(scheduler: Scheduler) -> None:
    reservation = scheduler.reserve(T0, PLAYLIST, name="朝の周回")
    assert scheduler.pending() == [reservation]
    assert scheduler.next_run_at() == T0
    assert len(scheduler) == 1


def test_reserve_requires_tasks(scheduler: Scheduler) -> None:
    with pytest.raises(ValueError, match="1 件以上"):
        scheduler.reserve(T0, [])


def test_naive_datetime_is_rejected(scheduler: Scheduler) -> None:
    """素朴な datetime は比較で事故るため受け付けない。"""
    with pytest.raises(ValueError, match="タイムゾーン"):
        scheduler.reserve(datetime(2024, 1, 1, 10, 52), PLAYLIST)


def test_pending_is_sorted_by_time(scheduler: Scheduler) -> None:
    later = scheduler.reserve(T0 + timedelta(hours=2), PLAYLIST, name="後")
    earlier = scheduler.reserve(T0, PLAYLIST, name="先")
    assert scheduler.pending() == [earlier, later]


# -- 発火 -----------------------------------------------------------------


def test_not_due_yet(scheduler: Scheduler) -> None:
    scheduler.reserve(T0, PLAYLIST)
    assert scheduler.pop_due(T0 - timedelta(seconds=1)) == []


def test_fires_at_exact_time(scheduler: Scheduler) -> None:
    reservation = scheduler.reserve(T0, PLAYLIST)
    fired = scheduler.pop_due(T0)
    assert fired == [reservation]
    assert reservation.status is ReservationStatus.FIRED
    assert reservation.fired_at == T0


def test_fires_only_once(scheduler: Scheduler) -> None:
    scheduler.reserve(T0, PLAYLIST)
    assert scheduler.pop_due(T0)
    assert scheduler.pop_due(T0 + timedelta(minutes=1)) == []


def test_late_reservation_expires(scheduler: Scheduler) -> None:
    """PC が落ちていて時刻を大きく過ぎた予約は発火しない。"""
    reservation = scheduler.reserve(T0, PLAYLIST, max_delay_seconds=3600)
    assert scheduler.pop_due(T0 + timedelta(hours=12)) == []
    assert reservation.status is ReservationStatus.EXPIRED


def test_late_reservation_within_grace_fires(scheduler: Scheduler) -> None:
    reservation = scheduler.reserve(T0, PLAYLIST, max_delay_seconds=3600)
    assert scheduler.pop_due(T0 + timedelta(minutes=30)) == [reservation]


def test_unlimited_delay_always_fires(scheduler: Scheduler) -> None:
    reservation = scheduler.reserve(T0, PLAYLIST, max_delay_seconds=None)
    assert scheduler.pop_due(T0 + timedelta(days=3)) == [reservation]


def test_cancelled_reservation_does_not_fire(scheduler: Scheduler) -> None:
    reservation = scheduler.reserve(T0, PLAYLIST)
    assert scheduler.cancel(reservation.reservation_id) is True
    assert scheduler.pop_due(T0) == []
    assert reservation.status is ReservationStatus.CANCELLED


def test_cancel_unknown_or_fired_returns_false(scheduler: Scheduler) -> None:
    reservation = scheduler.reserve(T0, PLAYLIST)
    assert scheduler.cancel("nope") is False
    scheduler.pop_due(T0)
    assert scheduler.cancel(reservation.reservation_id) is False


def test_purge_terminal(scheduler: Scheduler) -> None:
    scheduler.reserve(T0, PLAYLIST)
    scheduler.reserve(T0 + timedelta(days=1), PLAYLIST)
    scheduler.pop_due(T0)
    assert scheduler.purge_terminal() == 1
    assert len(scheduler.reservations) == 1


# -- キューへの展開 -------------------------------------------------------


def test_playlist_order_is_preserved_in_queue(scheduler: Scheduler) -> None:
    """デイリー → 遠征 → 周回の順で取り出される。"""
    reservation = scheduler.reserve(T0, PLAYLIST)
    queue = TaskQueue()
    queue.push_all(scheduler.pop_due(T0)[0].to_tasks())
    assert [queue.pop().name for _ in range(3)] == ["daily", "expedition", "sortie"]
    assert reservation.status is ReservationStatus.FIRED


def test_payload_is_carried_into_task(scheduler: Scheduler) -> None:
    scheduler.reserve(T0, PLAYLIST)
    tasks = scheduler.pop_due(T0)[0].to_tasks()
    assert tasks[2].payload == {"map": "1-5"}


def test_same_priority_playlist_keeps_order() -> None:
    """優先度が同じ並びは投入順が守られる。"""
    specs = [TaskSpec(f"step{i}", TaskPriority.SORTIE) for i in range(4)]
    queue = TaskQueue()
    queue.push_all([spec.to_task() for spec in specs])
    assert [queue.pop().name for _ in range(4)] == [f"step{i}" for i in range(4)]


# -- 永続化 ---------------------------------------------------------------


def test_save_and_load_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "schedule.json"
    scheduler = Scheduler(state_path=path)
    reservation = scheduler.reserve(T0, PLAYLIST, name="朝の周回")

    restored = Scheduler.load(path)
    assert len(restored) == 1
    loaded = restored.pending()[0]
    assert loaded.reservation_id == reservation.reservation_id
    assert loaded.run_at == T0
    assert loaded.name == "朝の周回"
    assert [spec.name for spec in loaded.specs] == ["daily", "expedition", "sortie"]
    assert loaded.specs[2].payload == {"map": "1-5"}
    assert loaded.specs[0].priority is TaskPriority.DAILY_TASK


def test_autosave_records_status_changes(tmp_path: Path) -> None:
    """発火後に再起動しても、二重発火しない。"""
    path = tmp_path / "schedule.json"
    scheduler = Scheduler(state_path=path)
    scheduler.reserve(T0, PLAYLIST)
    scheduler.pop_due(T0)

    restored = Scheduler.load(path)
    assert restored.pop_due(T0 + timedelta(minutes=1)) == []


def test_load_missing_file_returns_empty(tmp_path: Path) -> None:
    scheduler = Scheduler.load(tmp_path / "absent.json")
    assert len(scheduler) == 0
    assert scheduler.state_path == tmp_path / "absent.json"


def test_load_broken_file_returns_empty(tmp_path: Path) -> None:
    path = tmp_path / "schedule.json"
    path.write_text("{ broken", encoding="utf-8")
    assert len(Scheduler.load(path)) == 0


def test_load_skips_broken_reservation_and_keeps_rest(tmp_path: Path) -> None:
    """1 件壊れていても、残りの予約は失わない。"""
    path = tmp_path / "schedule.json"
    good = Reservation(run_at=T0, specs=[TaskSpec("daily")], name="正常")
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "reservations": [
                    {"reservation_id": "broken", "specs": []},
                    good.to_dict(),
                ],
            }
        ),
        encoding="utf-8",
    )
    restored = Scheduler.load(path)
    assert [r.name for r in restored.pending()] == ["正常"]


def test_load_handles_unknown_priority(tmp_path: Path) -> None:
    path = tmp_path / "schedule.json"
    path.write_text(
        json.dumps(
            {
                "reservations": [
                    {
                        "run_at": T0.isoformat(),
                        "specs": [{"name": "mystery", "priority": 12345}],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    restored = Scheduler.load(path)
    assert restored.pending()[0].specs[0].priority is TaskPriority.BACKGROUND


def test_save_without_path_raises(scheduler: Scheduler) -> None:
    with pytest.raises(ValueError, match="保存先"):
        scheduler.save()


def test_save_leaves_no_temp_files(tmp_path: Path) -> None:
    scheduler = Scheduler(state_path=tmp_path / "schedule.json")
    scheduler.reserve(T0, PLAYLIST)
    assert [p.name for p in tmp_path.iterdir()] == ["schedule.json"]

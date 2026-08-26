"""TaskQueue のテスト。"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from core.task_queue import Task, TaskPriority, TaskQueue, TaskStatus

T0 = datetime(2024, 1, 1, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def queue() -> TaskQueue:
    return TaskQueue()


def make(name: str, priority: TaskPriority = TaskPriority.BACKGROUND) -> Task:
    return Task(name=name, priority=priority)


# -- 取り出し順 -----------------------------------------------------------


def test_higher_priority_comes_first(queue: TaskQueue) -> None:
    queue.push(make("sortie", TaskPriority.SORTIE))
    queue.push(make("daily", TaskPriority.DAILY_TASK))
    queue.push(make("background", TaskPriority.BACKGROUND))
    assert [queue.pop().name for _ in range(3)] == ["daily", "sortie", "background"]


def test_same_priority_is_fifo(queue: TaskQueue) -> None:
    for index in range(5):
        queue.push(make(f"task{index}", TaskPriority.EXPEDITION))
    assert [queue.pop().name for _ in range(5)] == [f"task{i}" for i in range(5)]


def test_interrupt_jumps_ahead_of_running_backlog(queue: TaskQueue) -> None:
    """割り込みは通常周回より先に出る（§5 の想定）。"""
    queue.push(make("sortie", TaskPriority.SORTIE))
    queue.push(make("sortie2", TaskPriority.SORTIE))
    queue.push(make("break_gauge", TaskPriority.USER_INTERRUPT))
    assert queue.pop().name == "break_gauge"


def test_full_priority_order(queue: TaskQueue) -> None:
    """指示書 §11 の優先度がそのまま順序になる。"""
    order = [
        TaskPriority.BACKGROUND,
        TaskPriority.SORTIE,
        TaskPriority.EXPEDITION,
        TaskPriority.DAILY_TASK,
        TaskPriority.USER_INTERRUPT,
        TaskPriority.SAFETY_TASK,
        TaskPriority.EMERGENCY_STOP,
    ]
    for priority in order:
        queue.push(make(priority.name, priority))
    popped = [queue.pop().name for _ in range(len(order))]
    assert popped == [p.name for p in reversed(order)]


def test_pop_on_empty_queue_returns_none(queue: TaskQueue) -> None:
    assert queue.pop() is None


def test_peek_does_not_consume(queue: TaskQueue) -> None:
    queue.push(make("daily", TaskPriority.DAILY_TASK))
    assert queue.peek().name == "daily"
    assert len(queue) == 1


# -- 状態遷移 -------------------------------------------------------------


def test_pop_marks_running_and_counts_attempts(queue: TaskQueue) -> None:
    task = queue.push(make("sortie"))
    popped = queue.pop()
    assert popped is task
    assert popped.status is TaskStatus.RUNNING
    assert popped.attempts == 1
    assert popped.started_at is not None


def test_complete_records_history(queue: TaskQueue) -> None:
    task = queue.push(make("daily"))
    queue.pop()
    queue.complete(task, result={"count": 3}, at=T0)
    assert task.status is TaskStatus.DONE
    assert task.result == {"count": 3}
    assert queue.history == (task,)


def test_fail_records_error(queue: TaskQueue) -> None:
    task = queue.push(make("daily"))
    queue.pop()
    queue.fail(task, "画面が想定と違います", at=T0)
    assert task.status is TaskStatus.FAILED
    assert task.error == "画面が想定と違います"


def test_requeue_after_failure(queue: TaskQueue) -> None:
    task = queue.push(Task(name="sortie", max_attempts=2))
    queue.pop()
    queue.fail(task, "一時的な失敗")
    queue.requeue(task)
    assert task.status is TaskStatus.PENDING
    assert queue.pop() is task
    assert task.attempts == 2


def test_requeue_beyond_max_attempts_is_rejected(queue: TaskQueue) -> None:
    task = queue.push(Task(name="sortie", max_attempts=1))
    queue.pop()
    queue.fail(task, "失敗")
    with pytest.raises(ValueError, match="再投入できません"):
        queue.requeue(task)


# -- 取り消し -------------------------------------------------------------


def test_cancelled_task_is_not_popped(queue: TaskQueue) -> None:
    cancelled = queue.push(make("cancelled", TaskPriority.SAFETY_TASK))
    kept = queue.push(make("kept", TaskPriority.SORTIE))
    queue.cancel(cancelled.task_id, "不要になりました")

    assert queue.pop() is kept
    assert queue.pop() is None
    assert cancelled.status is TaskStatus.CANCELLED
    assert cancelled.error == "不要になりました"


def test_cancel_unknown_id_returns_false(queue: TaskQueue) -> None:
    assert queue.cancel("nope") is False


def test_cancel_all(queue: TaskQueue) -> None:
    queue.push_all([make("a"), make("b"), make("c")])
    assert queue.cancel_all("緊急停止") == 3
    assert queue.is_empty is True


def test_len_excludes_cancelled(queue: TaskQueue) -> None:
    task = queue.push(make("a"))
    queue.push(make("b"))
    queue.cancel(task.task_id)
    assert len(queue) == 1


def test_completing_cancelled_task_keeps_cancelled_status(queue: TaskQueue) -> None:
    """実行中に取り消されたタスクを完了扱いにしない。"""
    task = queue.push(make("a"))
    queue.pop()
    task.cancel("割り込み")
    queue.complete(task)
    assert task.status is TaskStatus.CANCELLED


# -- その他 ---------------------------------------------------------------


def test_duplicate_task_id_is_rejected(queue: TaskQueue) -> None:
    queue.push(Task(name="a", task_id="fixed"))
    with pytest.raises(ValueError, match="同じ task_id"):
        queue.push(Task(name="b", task_id="fixed"))


def test_pending_is_sorted_without_consuming(queue: TaskQueue) -> None:
    queue.push(make("sortie", TaskPriority.SORTIE))
    queue.push(make("safety", TaskPriority.SAFETY_TASK))
    assert [task.name for task in queue.pending()] == ["safety", "sortie"]
    assert len(queue) == 2


def test_get_finds_pending_task(queue: TaskQueue) -> None:
    task = queue.push(make("a"))
    assert queue.get(task.task_id) is task
    queue.pop()
    assert queue.get(task.task_id) is None


def test_clear_history(queue: TaskQueue) -> None:
    task = queue.push(make("a"))
    queue.pop()
    queue.complete(task)
    queue.clear_history()
    assert queue.history == ()


def test_task_status_terminal_flags() -> None:
    assert TaskStatus.DONE.is_terminal is True
    assert TaskStatus.RUNNING.is_terminal is False

"""優先度付きタスクキュー。

開発指示書 §11 の担当。優先度が高い順に取り出し、同一優先度では
投入順（FIFO）を守る。

このモジュールは **タスクを実行しない**。何を次にやるかを決めるだけで、
実行は Phase 4 以降の Task 実装が担う。実行してよいかどうかの判断は
:class:`~safety.safety_manager.SafetyManager` が持つ。

ログ監視スレッドと Discord 受信スレッドから同時に触られうるため、
内部でロックを取る。
"""

from __future__ import annotations

import heapq
import itertools
import logging
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum, IntEnum
from typing import Any, Iterator, Mapping

from core.state import utcnow

logger = logging.getLogger(__name__)


class TaskPriority(IntEnum):
    """タスクの優先度。数値が大きいほど先に実行する。"""

    EMERGENCY_STOP = 1000
    SAFETY_TASK = 900
    USER_INTERRUPT = 800
    DAILY_TASK = 700
    EXPEDITION = 500
    SORTIE = 400
    BACKGROUND = 100


#: タスク名と優先度の対応。予約・LLM 由来の計画・CLI がここを共有する。
PRIORITY_BY_TASK_NAME: Mapping[str, "TaskPriority"] = {}


class TaskStatus(str, Enum):
    """タスクの状態。"""

    PENDING = "PENDING"
    RUNNING = "RUNNING"
    DONE = "DONE"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"

    @property
    def is_terminal(self) -> bool:
        """これ以上遷移しない状態なら ``True``。"""
        return self in (TaskStatus.DONE, TaskStatus.FAILED, TaskStatus.CANCELLED)


PRIORITY_BY_TASK_NAME = {
    "daily": TaskPriority.DAILY_TASK,
    "construction": TaskPriority.DAILY_TASK,
    "expedition": TaskPriority.EXPEDITION,
    "sortie": TaskPriority.SORTIE,
    "advance": TaskPriority.SORTIE,
    "supply": TaskPriority.DAILY_TASK,
    "repair": TaskPriority.SAFETY_TASK,
    "dismantle": TaskPriority.BACKGROUND,
}


def priority_for(name: str) -> TaskPriority:
    """タスク名から優先度を引く。

    未知の名前は :attr:`TaskPriority.BACKGROUND` にする。名前の妥当性は
    :mod:`llm.schema` が先に弾くので、ここは保険。
    """
    return PRIORITY_BY_TASK_NAME.get(name, TaskPriority.BACKGROUND)


def _new_task_id() -> str:
    """短いタスク ID を生成する。"""
    return uuid.uuid4().hex[:12]


@dataclass
class Task:
    """キューに載る 1 件のタスク。

    Attributes:
        payload: タスク種別ごとのパラメータ。キュー自身は解釈しない。
        max_attempts: 再投入を許す回数。超えたら失敗として扱う。
    """

    name: str
    priority: TaskPriority = TaskPriority.BACKGROUND
    payload: Mapping[str, Any] = field(default_factory=dict)
    task_id: str = field(default_factory=_new_task_id)
    created_at: datetime = field(default_factory=utcnow)
    status: TaskStatus = TaskStatus.PENDING
    cancelled: bool = False
    attempts: int = 0
    max_attempts: int = 1
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: str | None = None
    result: Any = None

    @property
    def is_cancelled(self) -> bool:
        """取り消し済みなら ``True``。"""
        return self.cancelled or self.status is TaskStatus.CANCELLED

    @property
    def can_retry(self) -> bool:
        """再投入してよいなら ``True``。"""
        return not self.is_cancelled and self.attempts < self.max_attempts

    def cancel(self, reason: str | None = None) -> None:
        """タスクを取り消す。

        実行中でも呼べる。取り消されたタスクはキューから取り出されず、
        実行側も :attr:`is_cancelled` を見て中断する。
        """
        self.cancelled = True
        if not self.status.is_terminal:
            self.status = TaskStatus.CANCELLED
            self.finished_at = utcnow()
        if reason:
            self.error = reason
        logger.info("タスクを取り消しました: %s (%s)", self.name, self.task_id)

    def describe(self) -> str:
        """ログ用の 1 行表記。"""
        return f"{self.name}[{self.task_id}] {self.priority.name} {self.status.value}"


@dataclass(order=True)
class _Entry:
    """ヒープに載せる内部エントリ。

    優先度は降順、投入順は昇順にしたいので、``(-priority, sequence)``
    をキーにする。
    """

    sort_key: tuple[int, int]
    task: Task = field(compare=False)


class TaskQueue:
    """優先度付きキュー。

    Example:
        >>> queue = TaskQueue()
        >>> queue.push(Task("sortie", TaskPriority.SORTIE))
        >>> queue.push(Task("daily", TaskPriority.DAILY_TASK))
        >>> queue.pop().name
        'daily'
    """

    def __init__(self) -> None:
        self._heap: list[_Entry] = []
        self._by_id: dict[str, Task] = {}
        self._counter = itertools.count()
        self._lock = threading.RLock()
        self._history: list[Task] = []

    # ------------------------------------------------------------------
    # 参照
    # ------------------------------------------------------------------

    def __len__(self) -> int:
        """取り出し可能なタスク数（取り消し済みを除く）。"""
        with self._lock:
            return sum(1 for entry in self._heap if not entry.task.is_cancelled)

    def __iter__(self) -> Iterator[Task]:
        """優先度順にタスクを列挙する（キューは変更しない）。"""
        return iter(self.pending())

    @property
    def is_empty(self) -> bool:
        """取り出せるタスクが無ければ ``True``。"""
        return len(self) == 0

    @property
    def history(self) -> tuple[Task, ...]:
        """完了・失敗・取り消しになったタスクの記録。"""
        with self._lock:
            return tuple(self._history)

    def pending(self) -> list[Task]:
        """待機中のタスクを優先度順に返す。"""
        with self._lock:
            ordered = sorted(self._heap, key=lambda entry: entry.sort_key)
            return [entry.task for entry in ordered if not entry.task.is_cancelled]

    def get(self, task_id: str) -> Task | None:
        """ID でタスクを引く（履歴は含まない）。"""
        with self._lock:
            return self._by_id.get(task_id)

    def peek(self) -> Task | None:
        """次に取り出されるタスクを、取り出さずに返す。"""
        with self._lock:
            self._discard_cancelled()
            return self._heap[0].task if self._heap else None

    # ------------------------------------------------------------------
    # 更新
    # ------------------------------------------------------------------

    def push(self, task: Task) -> Task:
        """タスクを投入する。

        Args:
            task: 投入するタスク。

        Returns:
            投入したタスク（呼び出し側でそのまま参照できるように返す）。

        Raises:
            ValueError: 同じ ``task_id`` が既にキューにある場合。
        """
        with self._lock:
            if task.task_id in self._by_id:
                raise ValueError(f"同じ task_id が既に存在します: {task.task_id}")
            entry = _Entry((-int(task.priority), next(self._counter)), task)
            heapq.heappush(self._heap, entry)
            self._by_id[task.task_id] = task
        logger.info("タスクを投入しました: %s", task.describe())
        return task

    def push_all(self, tasks: list[Task]) -> list[Task]:
        """複数のタスクを順に投入する。

        同一優先度なら渡した順（FIFO）で取り出される。
        """
        return [self.push(task) for task in tasks]

    def pop(self) -> Task | None:
        """次に実行すべきタスクを取り出す。

        取り消し済みのタスクは読み飛ばす。

        Returns:
            取り出したタスク。無ければ ``None``。
        """
        with self._lock:
            self._discard_cancelled()
            if not self._heap:
                return None
            task = heapq.heappop(self._heap).task
            self._by_id.pop(task.task_id, None)
            task.status = TaskStatus.RUNNING
            task.attempts += 1
            task.started_at = utcnow()
        logger.info("タスクを開始します: %s", task.describe())
        return task

    def cancel(self, task_id: str, reason: str | None = None) -> bool:
        """ID を指定してタスクを取り消す。

        Returns:
            取り消せたら ``True``。該当が無ければ ``False``。
        """
        with self._lock:
            task = self._by_id.get(task_id)
            if task is None:
                return False
            task.cancel(reason)
            self._history.append(task)
            return True

    def cancel_all(self, reason: str | None = None) -> int:
        """待機中のタスクをすべて取り消す。

        Returns:
            取り消した件数。
        """
        with self._lock:
            targets = [task for task in self._by_id.values() if not task.is_cancelled]
            for task in targets:
                task.cancel(reason)
                self._history.append(task)
            return len(targets)

    def complete(
        self, task: Task, result: Any = None, at: datetime | None = None
    ) -> Task:
        """タスクを完了として記録する。"""
        return self._finish(task, TaskStatus.DONE, at, result=result)

    def fail(
        self, task: Task, error: str, at: datetime | None = None
    ) -> Task:
        """タスクを失敗として記録する。

        再投入の可否は :attr:`Task.can_retry` を見て呼び出し側が決める。
        """
        return self._finish(task, TaskStatus.FAILED, at, error=error)

    def requeue(self, task: Task) -> Task:
        """失敗したタスクをキューへ戻す。

        Raises:
            ValueError: 再投入の上限に達している、または取り消し済みの場合。
        """
        if not task.can_retry:
            raise ValueError(
                f"再投入できません: {task.describe()}"
                f"（{task.attempts}/{task.max_attempts} 回）"
            )
        task.status = TaskStatus.PENDING
        task.started_at = None
        task.finished_at = None
        task.error = None
        logger.info("タスクを再投入します: %s", task.describe())
        return self.push(task)

    def clear_history(self) -> None:
        """履歴を捨てる（長時間稼働でのメモリ肥大を防ぐ）。"""
        with self._lock:
            self._history.clear()

    # ------------------------------------------------------------------
    # 内部処理
    # ------------------------------------------------------------------

    def _finish(
        self,
        task: Task,
        status: TaskStatus,
        at: datetime | None,
        result: Any = None,
        error: str | None = None,
    ) -> Task:
        """終了状態を書き込んで履歴へ積む。"""
        with self._lock:
            if task.is_cancelled:
                logger.info("取り消し済みのタスクです: %s", task.describe())
                return task
            task.status = status
            task.finished_at = at or utcnow()
            task.result = result
            task.error = error
            self._by_id.pop(task.task_id, None)
            self._history.append(task)
        level = logging.INFO if status is TaskStatus.DONE else logging.WARNING
        logger.log(level, "タスクが終了しました: %s %s", task.describe(), error or "")
        return task

    def _discard_cancelled(self) -> None:
        """ヒープ先頭にある取り消し済みタスクを捨てる（要ロック）。"""
        while self._heap and self._heap[0].task.is_cancelled:
            discarded = heapq.heappop(self._heap).task
            self._by_id.pop(discarded.task_id, None)

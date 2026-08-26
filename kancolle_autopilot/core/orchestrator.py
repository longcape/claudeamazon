"""すべての部品を 1 つのプロセスとして回す。

これまで各 Phase で作った部品を繋いで、常駐できる形にする。1 周
（:meth:`Orchestrator.tick`）でやることは決まっている。

1. 状態を取り込む（ログ監視、またはサンドボックス）
2. 発火した予約をキューへ移す
3. 安全判定
4. 実行してよければ、キューから 1 件取り出して実行
5. 結果を取り込む

**安全判定が STOP の間は 4 に進まない。** 状態機械も
:attr:`~core.state_machine.SystemState.EMERGENCY_STOP` へ落とし、
`SafetyManager` 側が回復するまで通常状態へ戻さない。緊急停止はラッチ
なので、`resume` コマンドか明示的な解除が要る。

タスクの組み立てに失敗した場合（payload が足りないなど）は、そのタスクを
失敗にして次へ進む。緊急停止はしない。危ないのは「操作したのに結果を
確認できていない」状態であって、実行前に弾けた指定ミスではないため。
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Protocol, Sequence

from core.scheduler import Scheduler
from core.state import utcnow
from core.state_machine import StateMachine, SystemState
from core.task_queue import Task, TaskQueue
from monitor.api_parser import Event
from monitor.game_state import GameState
from notify.commands import CommandError, CommandHandler
from notify.dispatcher import NotificationDispatcher
from safety.safety_manager import SafetyManager
from safety.verdict import SafetyVerdict
from tasks.base_task import BaseTask, TaskResult
from tasks.factory import TaskBuildError, build_task

logger = logging.getLogger(__name__)

#: 1 周の既定の間隔（秒）。
DEFAULT_INTERVAL = 2.0


class StateSource(Protocol):
    """状態の取り込み口。

    ログ監視でもサンドボックスでも、この形さえ満たせばよい。
    """

    def sync(self) -> list[Event]:
        """新しく分かったことを取り込み、派生イベントを返す。"""
        ...


@dataclass(frozen=True)
class TickReport:
    """1 周の結果。"""

    state: SystemState
    verdict: SafetyVerdict
    fired: tuple[str, ...] = ()
    executed: str | None = None
    result: TaskResult | None = None
    note: str = ""

    @property
    def did_work(self) -> bool:
        """何かしら進んだなら ``True``。"""
        return bool(self.fired) or self.executed is not None

    def describe(self) -> str:
        """ログ用の 1 行表記。"""
        parts = [self.state.value, self.verdict.level.name]
        if self.fired:
            parts.append(f"予約発火 {len(self.fired)}")
        if self.executed:
            outcome = "成功" if self.result and self.result.ok else "失敗"
            parts.append(f"{self.executed} → {outcome}")
        if self.note:
            parts.append(self.note)
        return " / ".join(parts)


@dataclass
class Orchestrator:
    """常駐して 1 周ずつ進める。

    Args:
        source: 状態の取り込み口。
        execute: タスクを実行する関数。サンドボックスなら
            :meth:`~sandbox.session.SandboxSession.run`。
    """

    source: StateSource
    game_state: GameState
    safety: SafetyManager
    queue: TaskQueue
    scheduler: Scheduler
    execute: Callable[[BaseTask], TaskResult]
    machine: StateMachine = field(default_factory=StateMachine)
    dispatcher: NotificationDispatcher | None = None
    #: 現在時刻。省略時は :attr:`game_state` が観測に使っている時計に揃える。
    clock: Callable[[], datetime] | None = None
    #: 外部から届いた管理コマンドを取り出す関数。
    command_source: Callable[[], Sequence[str]] | None = None
    _started: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        if self.clock is None:
            # 状態の鮮度は「観測に使った時計」で測る。別の時計を使うと、
            # サンドボックスのように時刻が実時間と違う環境で、届いた
            # 直後のイベントが古いと判定されてしまう。
            self.clock = self.game_state.clock

    # ------------------------------------------------------------------
    # コマンド
    # ------------------------------------------------------------------

    @property
    def commands(self) -> CommandHandler:
        """管理コマンドの実行係。"""
        return CommandHandler(
            safety=self.safety,
            queue=self.queue,
            game_state=self.game_state,
            state_machine=self.machine,
        )

    def handle_commands(self) -> list[str]:
        """溜まっているコマンドを処理して、返答を返す。"""
        if self.command_source is None:
            return []
        handler = self.commands
        replies: list[str] = []
        for line in self.command_source():
            try:
                replies.append(handler.handle_text(line))
            except CommandError as exc:
                replies.append(str(exc))
        return replies

    # ------------------------------------------------------------------
    # 1 周
    # ------------------------------------------------------------------

    def tick(self) -> TickReport:
        """1 周進める。

        Returns:
            この周で起きたこと。
        """
        now = self.clock()

        if self.machine.is_terminated:
            return TickReport(self.machine.state, SafetyVerdict.ok(), note="終了済み")

        self._enter_sync()
        self.source.sync()
        fired = self._promote_reservations(now)

        self.machine.transition(SystemState.SAFETY_CHECK, "安全判定")
        verdict = self.safety.evaluate(self.game_state, now=now)
        if verdict.should_stop:
            return self._halt(verdict, fired)

        if self.queue.is_empty:
            self.machine.transition(SystemState.IDLE, "待機タスクなし")
            return TickReport(self.machine.state, verdict, fired, note="待機")

        return self._run_next(verdict, fired, now)

    def run(
        self,
        stop: threading.Event | None = None,
        interval: float = DEFAULT_INTERVAL,
        on_tick: Callable[[TickReport], None] | None = None,
        max_ticks: int | None = None,
    ) -> int:
        """停止が指示されるまで回し続ける。

        Args:
            stop: 停止用イベント。
            interval: 1 周ごとの待ち時間（秒）。
            on_tick: 各周の結果を受け取る関数。
            max_ticks: 回す最大周回数。``None`` なら無制限。

        Returns:
            回した周回数。
        """
        stop = stop or threading.Event()
        ticks = 0
        logger.info("常駐を開始します（間隔 %.1fs）", interval)

        while not stop.is_set():
            if max_ticks is not None and ticks >= max_ticks:
                break
            for reply in self.handle_commands():
                logger.info("コマンド応答:\n%s", reply)
            report = self.tick()
            ticks += 1
            if on_tick is not None:
                on_tick(report)
            if self.machine.is_terminated:
                break
            stop.wait(interval)

        logger.info("常駐を終了します（%d 周）", ticks)
        return ticks

    def shutdown(self, reason: str = "") -> None:
        """終了状態へ移す。"""
        self.machine.shutdown(reason or "停止要求")

    # ------------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------------

    def _enter_sync(self) -> None:
        """同期状態へ入る。緊急停止からは復旧を経由する。"""
        if not self._started:
            self.machine.transition(SystemState.INITIALIZING, "起動")
            self._started = True

        if self.machine.is_stopped:
            # SafetyManager 側が回復していなければ、次の判定でまた止まる。
            self.machine.recover("安全判定を再確認")

        self.machine.transition(SystemState.SYNCING, "状態を取り込む")

    def _promote_reservations(self, now: datetime) -> tuple[str, ...]:
        """発火した予約をキューへ移す。"""
        fired: list[str] = []
        for reservation in self.scheduler.pop_due(now):
            self.queue.push_all(reservation.to_tasks())
            fired.append(reservation.describe())
            logger.info("予約を投入しました: %s", reservation.describe())
        return tuple(fired)

    def _halt(self, verdict: SafetyVerdict, fired: tuple[str, ...]) -> TickReport:
        """安全判定により止まる。"""
        self.machine.emergency_stop(verdict.describe())
        if self.dispatcher is not None:
            self.dispatcher.observe_verdict(verdict, self.game_state)
        return TickReport(self.machine.state, verdict, fired, note="安全判定により停止")

    def _run_next(
        self, verdict: SafetyVerdict, fired: tuple[str, ...], now: datetime
    ) -> TickReport:
        """キューから 1 件取り出して実行する。"""
        task = self.queue.pop()
        if task is None:
            self.machine.transition(SystemState.IDLE, "待機タスクなし")
            return TickReport(self.machine.state, verdict, fired, note="待機")

        try:
            implementation = build_task(task)
        except TaskBuildError as exc:
            # 指定ミスは実行前に弾けている。止めずに次へ進む。
            self.queue.fail(task, str(exc), at=now)
            self._notify_task(task, ok=False, message=str(exc))
            self.machine.transition(SystemState.SAFETY_CHECK, "組み立て失敗")
            self.machine.transition(SystemState.IDLE, "次へ")
            return TickReport(
                self.machine.state,
                verdict,
                fired,
                executed=task.name,
                result=TaskResult.failure(str(exc)),
                note="組み立てに失敗",
            )

        self.machine.transition(SystemState.EXECUTING_TASK, task.describe())
        result = self.execute(implementation)
        self.machine.transition(SystemState.WAITING_RESULT, "結果を確認")

        if result.ok:
            self.queue.complete(task, result.details, at=now)
        else:
            self.queue.fail(task, result.message, at=now)
        self._notify_task(task, result.ok, result.message)

        self.machine.transition(SystemState.SYNCING, "結果を取り込む")
        self.source.sync()
        self.machine.transition(SystemState.SAFETY_CHECK, "実行後の判定")
        self.machine.transition(SystemState.IDLE, "1 周完了")

        if self.queue.is_empty and self.dispatcher is not None:
            self.dispatcher.all_tasks_completed(
                {"完了": task.name, "残り": len(self.queue)}
            )

        return TickReport(
            self.machine.state, verdict, fired, executed=task.name, result=result
        )

    def _notify_task(self, task: Task, ok: bool, message: str) -> None:
        """タスクの結果を通知する。"""
        if self.dispatcher is not None:
            self.dispatcher.task_finished(task.name, ok, message)

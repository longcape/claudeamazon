"""サンドボックスを人間が操作するための窓口。

ブラウザからの要求を受けて、:class:`~sandbox.session.SandboxSession` を
動かす。**クリックは座標で受け取り、AI と同じ当たり判定を通す。** 論理名で
直接叩けるようにすると、人間が触ったときだけ通る経路ができてしまい、
配置表の間違いが表に出なくなる。

HTTP のことはここに持ち込まない（:mod:`viz.server` の担当）。この層は
辞書を返すだけなので、サーバを起こさずに検証できる。
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Mapping

from automation.interface import Screen
from automation.screen_detector import Point
from core.orchestrator import Orchestrator
from core.scheduler import Scheduler
from core.task_queue import Task, TaskQueue, priority_for
from recording.recorder import SessionRecorder
from sandbox.session import SandboxSession
from tasks.factory import TaskBuildError, build_task
from viz.model import screen_widgets, snapshot_view

logger = logging.getLogger(__name__)

#: 操作ログに残す件数。
LOG_LIMIT = 60


@dataclass
class SandboxService:
    """サンドボックスに対する操作をまとめる。

    Args:
        seed: 戦闘乱数の種。
    """

    seed: int = 0
    session: SandboxSession = field(init=False)
    orchestrator: Orchestrator = field(init=False)
    recorder: SessionRecorder = field(init=False)
    log: list[str] = field(default_factory=list, init=False)
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False)

    def __post_init__(self) -> None:
        self.reset()

    # ------------------------------------------------------------------
    # 組み立て
    # ------------------------------------------------------------------

    def reset(self, seed: int | None = None) -> dict[str, Any]:
        """最初の状態に戻す。"""
        with self._lock:
            if seed is not None:
                self.seed = seed
            self.recorder = SessionRecorder()
            self.session = SandboxSession.create(seed=self.seed, recorder=self.recorder)
            self.session.bootstrap()
            self.session.environment.records.append(self.session.game.kdock_record())
            self.session.sync()
            self.orchestrator = Orchestrator(
                source=self.session,
                game_state=self.session.game_state,
                safety=self.session.safety,
                queue=TaskQueue(),
                scheduler=Scheduler(),
                execute=self.session.run_and_resolve,
            )
            self.log = [f"サンドボックスを初期化しました（seed={self.seed}）"]
            return self.snapshot()

    # ------------------------------------------------------------------
    # 参照
    # ------------------------------------------------------------------

    def snapshot(self) -> dict[str, Any]:
        """ブラウザへ返す現在の様子。"""
        with self._lock:
            environment = self.session.environment
            screen = environment.current_screen()
            verdict = self.session.safety.evaluate(
                self.session.game_state, now=self.session.game.clock()
            )
            cursor = self.session.interface.mouse.backend.position()
            return {
                "screen": screen.value,
                "widgets": screen_widgets(screen),
                "cursor": {"x": cursor.x, "y": cursor.y},
                "selection": {
                    key: value for key, value in environment.selection.items()
                },
                "state": snapshot_view(self.session.game_state),
                "safety": {
                    "level": verdict.level.name,
                    "reasons": list(verdict.reasons),
                    "stopped": self.session.safety.is_stopped,
                    "pending": [
                        pending.name or str(pending.master_id)
                        for pending in self.session.safety.pending_protections
                    ],
                },
                "game": {
                    "戦果": self.session.game.rank_points,
                    "出撃": (
                        self.session.game.sortie.map_key
                        if self.session.game.sortie
                        else None
                    ),
                    "セル": (
                        self.session.game.sortie.cell
                        if self.session.game.sortie
                        else None
                    ),
                    "直近戦闘": self.session.game.last_battle_rank or None,
                    "ゲージ": {
                        key: f"{target.gauge.current}/{target.gauge.maximum}"
                        for key, target in self.session.game.maps.items()
                        if target.gauge is not None
                    },
                },
                "queue": [task.describe() for task in self.orchestrator.queue.pending()],
                "log": self.log[-LOG_LIMIT:],
                "events": len(self.recorder.timeline),
            }

    # ------------------------------------------------------------------
    # 操作
    # ------------------------------------------------------------------

    def click(self, x: int, y: int) -> dict[str, Any]:
        """座標を押す。

        AI と同じ当たり判定を通す。どのウィジェットにも当たらなければ、
        当たらなかったことを記録する。
        """
        with self._lock:
            environment = self.session.environment
            point = Point(int(x), int(y))
            # 押下の前後で件数を比べる。押されたものが無ければ外している。
            before = len(environment.pressed_targets)
            errors_before = len(environment.errors)

            self.session.interface.mouse.click(point)

            if len(environment.pressed_targets) > before:
                target = environment.pressed_targets[-1]
            else:
                target = "（どのウィジェットにも当たりません）"
            note = f"クリック ({point.x}, {point.y}) → {target}"
            if len(environment.errors) > errors_before:
                note += f" — {environment.errors[-1]}"
            self._note(note)

            self.session.sync()
            return self.snapshot()

    def run_task(self, name: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """タスクを 1 つ実行する（AI に任せる）。"""
        with self._lock:
            task = Task(name=name, priority=priority_for(name), payload=dict(payload or {}))
            try:
                implementation = build_task(task)
            except TaskBuildError as exc:
                self._note(f"タスクを組み立てられません: {exc}")
                return self.snapshot()

            result = self.session.run_and_resolve(implementation)
            self._note(
                f"{name}: {'成功' if result.ok else '失敗'} — {result.message}"
            )
            return self.snapshot()

    def enqueue(self, name: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """タスクをキューへ積む（常駐が拾う）。"""
        with self._lock:
            self.orchestrator.queue.push(
                Task(name=name, priority=priority_for(name), payload=dict(payload or {}))
            )
            self._note(f"キューへ投入: {name}")
            return self.snapshot()

    def tick(self) -> dict[str, Any]:
        """常駐ループを 1 周進める。"""
        with self._lock:
            report = self.orchestrator.tick()
            self._note(f"1 周: {report.describe()}")
            return self.snapshot()

    def command(self, text: str) -> dict[str, Any]:
        """管理コマンドを実行する。"""
        from notify.commands import CommandError

        with self._lock:
            try:
                reply = self.orchestrator.commands.handle_text(text)
            except CommandError as exc:
                reply = str(exc)
            self._note(f"$ {text}\n{reply}")
            return self.snapshot()

    def report_html(self) -> str:
        """ここまでの記録から HTML レポートを作る。"""
        from viz.report import report_from_recorder

        with self._lock:
            return report_from_recorder(self.recorder, "サンドボックス操作の記録")

    # ------------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------------

    def _note(self, text: str) -> None:
        """操作ログへ 1 行足す。"""
        self.log.append(text)
        logger.info("%s", text.replace("\n", " / "))
        if len(self.log) > LOG_LIMIT * 4:
            del self.log[: -LOG_LIMIT * 2]

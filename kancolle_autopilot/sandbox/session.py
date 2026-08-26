"""サンドボックス一式を組み立てて、AI Core と繋ぐ。

ここが「AI がサンドボックスを自律運用する」ための配線。組み立てるのは
次の 3 つで、その間を kcsapi 形式のレコードが流れる。

1. :class:`~sandbox.game.SandboxGame` … ゲームの真の状態
2. :class:`~sandbox.environment.SandboxEnvironment` … 画面と当たり判定
3. AI Core … :class:`~monitor.game_state.GameState` と
   :class:`~safety.safety_manager.SafetyManager`

AI Core は :meth:`SandboxSession.sync` を通じてしかゲームを知らない。
サンドボックス固有の型は AI Core 側へ渡らない（追加指示書 §2）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Sequence

from automation.controller import ControlledInterface
from automation.interface import Screen
from automation.keyboard_controller import KeyboardController, VirtualKeyboard
from automation.mouse_controller import MouseController
from automation.screen_detector import ScreenDetector
from monitor.api_parser import APIParser, Event, EventType
from notify.dispatcher import NotificationDispatcher
from recording.recorder import SessionRecorder
from recording.timeline import EventKind
from monitor.game_state import GameState
from safety.lock_guard import Blacklist, DismantlePolicy, LockGuard
from safety.safety_manager import SafetyManager
from safety.verdict import SafetyVerdict
from sandbox.environment import SandboxEnvironment, SandboxPointer
from sandbox.game import SandboxGame
from sandbox.scenario import new_game
from tasks.base_task import BaseTask, TaskContext, TaskResult
from tasks.sortie_task import SortieTask
from tasks.constraints import NO_CONSTRAINTS, TaskConstraints, decide_advance

logger = logging.getLogger(__name__)


@dataclass
class SandboxSession:
    """ゲーム・環境・AI Core をひとまとめにしたもの。

    Example:
        >>> session = SandboxSession.create()
        >>> session.sync()
        >>> session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    """

    game: SandboxGame
    environment: SandboxEnvironment
    interface: ControlledInterface
    game_state: GameState
    safety: SafetyManager
    parser: APIParser = field(default_factory=APIParser)
    #: 記録係。``None`` なら何も記録しない。
    recorder: SessionRecorder | None = None
    #: 通知係。``None`` なら何も通知しない。
    dispatcher: NotificationDispatcher | None = None
    _cursor_offset: int = field(default=0, init=False)
    _task_counter: int = field(default=0, init=False)

    @classmethod
    def create(
        cls,
        seed: int = 0,
        clock: Callable[[], datetime] | None = None,
        blacklist: Blacklist | None = None,
        safety: SafetyManager | None = None,
        recorder: SessionRecorder | None = None,
        dispatcher: NotificationDispatcher | None = None,
    ) -> "SandboxSession":
        """既定の初期状態で一式を組み立てる。

        Args:
            seed: 戦闘乱数の種。
            clock: 現在時刻を返す関数。省略時は実時刻。
            blacklist: 解体保護のブラックリスト。省略時は空を許可した
                ものを使う（サンドボックスには保護対象の実艦がいない）。
            safety: 差し替える SafetyManager。
            recorder: 記録係。渡すと操作・判断・状態が記録される。
            dispatcher: 通知係。渡すと重要イベントが通知される。

        Returns:
            組み立て済みのセッション。
        """
        game = new_game(seed=seed, clock=clock)
        environment = SandboxEnvironment(game=game)
        interface = ControlledInterface(
            detector=ScreenDetector(environment, dynamic=environment),
            mouse=MouseController(SandboxPointer(environment)),
            keyboard=KeyboardController(VirtualKeyboard()),
            # 押せばゲームの状態が動くので、結果照合を行う。
            affects_game_state=True,
        )
        manager = safety or SafetyManager(
            lock_guard=LockGuard(
                blacklist or Blacklist(allow_empty=True, source="sandbox"),
                DismantlePolicy(protect_newest_count=1),
            )
        )
        state = GameState(clock=game.clock)
        return cls(
            game=game,
            environment=environment,
            interface=interface,
            game_state=state,
            safety=manager,
            recorder=recorder,
            dispatcher=dispatcher,
        )

    # ------------------------------------------------------------------
    # AI Core との同期
    # ------------------------------------------------------------------

    def sync(self) -> list[Event]:
        """ゲームが吐いたレコードを AI Core の状態へ反映する。

        Returns:
            適用によって導出された派生イベント。
        """
        events: list[Event] = []
        for record in self.environment.drain_records():
            events.extend(self.parser.parse_record(record))
        before = self.game_state.resources
        derived = self.game_state.apply_all(events)
        self.safety.observe(derived)
        if derived:
            logger.info(
                "派生イベント: %s", [event.type.value for event in derived]
            )
        self._record_sync(before, derived)
        self._notify_sync(derived)
        return derived

    def _notify_sync(self, derived: Sequence[Event]) -> None:
        """同期で分かったことを通知する。"""
        if self.dispatcher is None:
            return
        for event in derived:
            if event.type is EventType.UNKNOWN_SHIP_DROPPED:
                self.dispatcher.drop_protected(
                    event.payload.get("name"),
                    event.payload.get("master_id"),
                    locked=False,
                )

    def _record_sync(self, before, derived: Sequence[Event]) -> None:
        """同期で分かったことをタイムラインへ残す。"""
        if self.recorder is None:
            return

        after = self.game_state.resources
        if (before.fuel, before.ammo, before.steel, before.bauxite) != (
            after.fuel,
            after.ammo,
            after.steel,
            after.bauxite,
        ):
            self.recorder.record(
                EventKind.RESOURCE_CHANGE,
                f"燃{after.fuel} 弾{after.ammo} 鋼{after.steel} ボ{after.bauxite}",
                detail={"fuel": after.fuel, "ammo": after.ammo},
            )

        for event in derived:
            if event.type is EventType.UNKNOWN_SHIP_DROPPED:
                self.recorder.record(
                    EventKind.SAFETY_WARNING,
                    f"未所持艦のドロップ: {event.payload.get('name')}",
                    detail=dict(event.payload),
                )

    def bootstrap(self) -> list[Event]:
        """母港応答を 1 回流し込んで、初期状態を作る。"""
        self.environment.records.append(self.game.port_record())
        return self.sync()

    def context(self, now: datetime | None = None) -> TaskContext:
        """タスク実行用のコンテキストを作る。"""
        return TaskContext(
            game_state=self.game_state,
            safety=self.safety,
            interface=self.interface,
            now=now or self.game.clock(),
        )

    def run(self, task: BaseTask, now: datetime | None = None) -> TaskResult:
        """タスクを実行し、結果をゲーム状態へ反映してから返す。

        照合が要るタスクのために、手順の実行と結果照合の間で
        :meth:`sync` を挟む必要がある。ここでは実行 → 同期 →
        照合の順になるよう、タスクの :meth:`~tasks.base_task.BaseTask.execute`
        を使わず段階を組み立てる。
        """
        ctx = self.context(now)
        task_id = self._start_recording(task, ctx)

        verdict = self.safety.evaluate(
            self.game_state, fleet_id=task.safety_fleet_id(ctx), now=ctx.now
        )
        if verdict.should_stop:
            return self._finish_recording(
                task_id,
                TaskResult.failure(f"安全判定により中止: {verdict.describe()}"),
            )

        precondition = task.preconditions(ctx)
        if precondition.should_stop:
            return self._finish_recording(
                task_id,
                TaskResult.failure(
                    f"事前条件を満たしません: {precondition.describe()}"
                ),
            )

        from tasks.base_task import ActionFailed

        try:
            result = task.perform(ctx)
        except ActionFailed as exc:
            reason = f"{task.name}: 操作に失敗しました: {exc.result.describe()}"
            self.safety.trigger_emergency_stop(reason, at=ctx.now)
            self._record_steps(ctx, task_id)
            return self._finish_recording(
                task_id, TaskResult.failure(reason, actions=tuple(ctx.performed))
            )

        self._record_steps(ctx, task_id)

        if not result.ok:
            self.safety.trigger_emergency_stop(
                f"{task.name}: {result.message}", at=ctx.now
            )
            return self._finish_recording(
                task_id,
                TaskResult(False, result.message, result.details, tuple(ctx.performed)),
            )

        # 照合の前に、ゲームが吐いたレコードを取り込む。
        self.sync()

        verification = task.verify(ctx)
        if not verification.ok:
            reason = f"{task.name}: 結果を確認できません: {verification.message}"
            self.safety.trigger_emergency_stop(reason, at=ctx.now)
            return self._finish_recording(
                task_id,
                TaskResult.failure(reason, verification.details, tuple(ctx.performed)),
            )

        return self._finish_recording(
            task_id,
            TaskResult.succeeded(
                result.message or verification.message,
                {**result.details, **verification.details},
                tuple(ctx.performed),
            ),
        )

    # ------------------------------------------------------------------
    # 記録
    # ------------------------------------------------------------------

    def _start_recording(self, task: BaseTask, ctx: TaskContext) -> str:
        """タスク開始を記録し、判断とスナップショットを残す。

        タスク ID は記録の有無と無関係に振る。記録を切っていても通知は
        タスクを識別できる必要があるため。
        """
        self._task_counter += 1
        task_id = f"{task.name}-{self._task_counter}"
        if self.recorder is None:
            return task_id

        self.recorder.record(
            EventKind.TASK_START,
            task.name,
            task_id=task_id,
            screen=self.interface.get_state().value,
        )
        self.recorder.snapshot(self.game_state, f"{task.name} 開始前")
        self.recorder.decide(
            self.game_state,
            decision=task.name.upper(),
            reason_code="TASK_REQUESTED",
            selected_action=task.name,
            expected_result="TASK_COMPLETED",
            task_id=task_id,
        )
        self._cursor_offset = len(self.interface.mouse.trace)
        return task_id

    def _record_steps(self, ctx: TaskContext, task_id: str) -> None:
        """操作とカーソル軌跡を記録する。"""
        if self.recorder is None:
            return
        self.recorder.record_actions(ctx.performed, task_id)
        self.recorder.record_cursor(
            self.interface.mouse.trace[self._cursor_offset :], task_id
        )
        self._cursor_offset = len(self.interface.mouse.trace)

    def _finish_recording(self, task_id: str, result: TaskResult) -> TaskResult:
        """タスク終了を記録・通知し、判断の実際の結果を書き込む。"""
        if self.dispatcher is not None:
            self.dispatcher.task_finished(
                task_id.rsplit("-", 1)[0], result.ok, result.message
            )
            if self.safety.is_stopped:
                self.dispatcher.safety_stop(
                    SafetyVerdict.stop(list(self.safety.latched_reasons))
                )

        if self.recorder is None:
            return result

        decision = self.recorder.decisions.latest(task_id)
        if decision is not None:
            decision.resolve("TASK_COMPLETED" if result.ok else "TASK_FAILED")
        self.recorder.record(
            EventKind.TASK_END,
            f"{task_id} {'成功' if result.ok else '失敗'}",
            task_id=task_id,
            detail={"ok": result.ok, "message": result.message},
        )
        return result

    def run_and_resolve(self, task: BaseTask, now: datetime | None = None) -> TaskResult:
        """タスクを実行し、出撃なら海域を進み切るまで面倒を見る。

        常駐ループから渡す実行関数はこれ。:meth:`run` だけでは出撃を
        始めたところで止まり、戦闘が進まない。進撃の判断にはタスクへ
        与えられた制約をそのまま使う。

        Returns:
            タスクの結果。出撃の場合は戦闘結果を details に足す。
        """
        result = self.run(task, now)
        if not result.ok or not isinstance(task, SortieTask):
            return result

        ranks = self.fight_through(constraints=task.constraints)
        return TaskResult.succeeded(
            f"{result.message}（戦闘 {len(ranks)} 回: {' '.join(ranks)}）",
            {**result.details, "ranks": ranks, "rank_points": self.game.rank_points},
            result.actions,
        )

    # ------------------------------------------------------------------
    # ゲーム側の進行
    # ------------------------------------------------------------------

    def fight_through(
        self,
        max_battles: int = 20,
        constraints: TaskConstraints = NO_CONSTRAINTS,
    ) -> list[str]:
        """出撃中の海域を進んで戦い、母港へ戻る。

        実ゲームでは進撃も画面操作だが、まだタスク化していないため
        ここではゲームを直接進める。進むかどうかの判断は
        :func:`~tasks.constraints.decide_advance` に任せる。既定は撤退で、
        「大破進撃を禁止していない」かつ「捨て艦戦法が許可されている」
        場合だけ進む。

        Args:
            max_battles: 打ち切りまでの戦闘回数。
            constraints: 与えられた制約。

        Returns:
            各戦闘の勝利判定。
        """
        ranks: list[str] = []
        if self.game.sortie is None:
            return ranks

        for _ in range(max_battles):
            if self.game.sortie is None:
                break

            if self.recorder is not None:
                self.recorder.record(
                    EventKind.BATTLE_START,
                    f"{self.game.sortie.map_key} セル{self.game.sortie.cell}",
                )

            damaged_before = self._heavily_damaged_ids()
            records = self.game.fight()
            rank = self._rank_of(records)
            ranks.append(rank)
            self.environment.records.extend(records)
            self.sync()

            # 記録と通知は独立させる。片方だけ有効でも成り立つように。
            newly_damaged = sorted(self._heavily_damaged_ids() - damaged_before)
            if self.recorder is not None:
                self.recorder.record(EventKind.BATTLE_END, rank)
                if newly_damaged:
                    self.recorder.record(
                        EventKind.DAMAGE,
                        f"大破: {newly_damaged}",
                        detail={"ship_ids": newly_damaged},
                    )
            if newly_damaged and self.dispatcher is not None:
                self.dispatcher.damage_detected(newly_damaged)

            target = self.game.maps[self.game.sortie.map_key]
            if self.game.at_boss or self.game.sortie.cell >= target.cells:
                break

            fleet_id = self.game.sortie.fleet_id
            decision = decide_advance(
                self.game_state.fleet_ships(fleet_id), constraints
            )
            if not decision.advance:
                logger.info("撤退します: %s", decision.reason)
                if self.recorder is not None:
                    self.recorder.record(
                        EventKind.DECISION,
                        f"RETREAT / {decision.reason_code}",
                        detail={"reason": decision.reason},
                    )
                break
            if decision.sacrificed and self.recorder is not None:
                self.recorder.record(
                    EventKind.DECISION,
                    f"ADVANCE / {decision.reason_code}",
                    detail={"sacrificed": list(decision.sacrificed)},
                )

            self.environment.records.extend(self.game.advance())
            self.sync()

        self.environment.records.extend(self.game.return_to_port())
        self.environment.screen = Screen.HOME
        self.sync()
        return ranks

    @staticmethod
    def _rank_of(records: Sequence[dict]) -> str:
        """戦闘結果レコードから勝利判定を取り出す。"""
        for record in records:
            body = record.get("body", {}).get("api_data", {})
            if isinstance(body, dict) and "api_win_rank" in body:
                return str(body["api_win_rank"])
        return "?"

    def _heavily_damaged_ids(self) -> set[int]:
        """出撃中の艦隊で大破している艦の ID。"""
        if self.game.sortie is None:
            return set()
        return {
            ship.instance_id
            for ship in self.game.fleet_ships(self.game.sortie.fleet_id)
            if ship.is_heavily_damaged
        }

    def _has_heavy_damage(self) -> bool:
        """出撃中の艦隊に大破艦がいれば ``True``。"""
        if self.game.sortie is None:
            return False
        return any(
            ship.is_heavily_damaged
            for ship in self.game.fleet_ships(self.game.sortie.fleet_id)
        )

    def complete_all_expeditions(self) -> list[int]:
        """遠征に出ている艦隊をすべて帰投させる。

        Returns:
            帰投させた艦隊 ID。
        """
        done: list[int] = []
        for fleet_id, fleet in self.game.fleets.items():
            if fleet.mission_state != 0:
                self.environment.records.extend(
                    self.game.complete_expedition(fleet_id)
                )
                done.append(fleet_id)
        if done:
            self.sync()
        return done

    def summary(self) -> dict[str, object]:
        """現在の様子をまとめる（CLI 表示用）。"""
        return {
            "戦果": self.game.rank_points,
            "資材": {
                "燃料": self.game_state.resources.fuel,
                "弾薬": self.game_state.resources.ammo,
                "鋼材": self.game_state.resources.steel,
                "ボーキ": self.game_state.resources.bauxite,
            },
            "所有艦": len(self.game_state.ships),
            "ゲージ": {
                key: f"{m.gauge.current}/{m.gauge.maximum}"
                for key, m in self.game.maps.items()
                if m.gauge is not None
            },
            "割った海域": list(self.game.cleared_maps),
            "保護待ち": [
                pending.name or str(pending.master_id)
                for pending in self.safety.pending_protections
            ],
        }

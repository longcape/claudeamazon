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
from typing import Sequence

from automation.controller import ControlledInterface
from automation.interface import Screen
from automation.keyboard_controller import KeyboardController, VirtualKeyboard
from automation.mouse_controller import MouseController
from automation.screen_detector import ScreenDetector
from monitor.api_parser import APIParser, Event
from monitor.game_state import GameState
from safety.lock_guard import Blacklist, DismantlePolicy, LockGuard
from safety.safety_manager import SafetyManager
from sandbox.environment import SandboxEnvironment, SandboxPointer
from sandbox.game import SandboxGame
from sandbox.scenario import new_game
from tasks.base_task import BaseTask, TaskContext, TaskResult

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

    @classmethod
    def create(
        cls,
        seed: int = 0,
        blacklist: Blacklist | None = None,
        safety: SafetyManager | None = None,
    ) -> "SandboxSession":
        """既定の初期状態で一式を組み立てる。

        Args:
            seed: 戦闘乱数の種。
            blacklist: 解体保護のブラックリスト。省略時は空を許可した
                ものを使う（サンドボックスには保護対象の実艦がいない）。
            safety: 差し替える SafetyManager。

        Returns:
            組み立て済みのセッション。
        """
        game = new_game(seed=seed)
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
        derived = self.game_state.apply_all(events)
        self.safety.observe(derived)
        if derived:
            logger.info(
                "派生イベント: %s", [event.type.value for event in derived]
            )
        return derived

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

        verdict = self.safety.evaluate(
            self.game_state, fleet_id=task.safety_fleet_id(ctx), now=ctx.now
        )
        if verdict.should_stop:
            return TaskResult.failure(f"安全判定により中止: {verdict.describe()}")

        precondition = task.preconditions(ctx)
        if precondition.should_stop:
            return TaskResult.failure(
                f"事前条件を満たしません: {precondition.describe()}"
            )

        from tasks.base_task import ActionFailed

        try:
            result = task.perform(ctx)
        except ActionFailed as exc:
            reason = f"{task.name}: 操作に失敗しました: {exc.result.describe()}"
            self.safety.trigger_emergency_stop(reason, at=ctx.now)
            return TaskResult.failure(reason, actions=tuple(ctx.performed))

        if not result.ok:
            self.safety.trigger_emergency_stop(
                f"{task.name}: {result.message}", at=ctx.now
            )
            return TaskResult(False, result.message, result.details, tuple(ctx.performed))

        # 照合の前に、ゲームが吐いたレコードを取り込む。
        self.sync()

        verification = task.verify(ctx)
        if not verification.ok:
            reason = f"{task.name}: 結果を確認できません: {verification.message}"
            self.safety.trigger_emergency_stop(reason, at=ctx.now)
            return TaskResult.failure(reason, verification.details, tuple(ctx.performed))

        return TaskResult.succeeded(
            result.message or verification.message,
            {**result.details, **verification.details},
            tuple(ctx.performed),
        )

    # ------------------------------------------------------------------
    # ゲーム側の進行
    # ------------------------------------------------------------------

    def fight_through(self, max_battles: int = 20) -> list[str]:
        """出撃中の海域を進んで戦い、母港へ戻る。

        実ゲームでは進撃も画面操作だが、まだタスク化していないため
        ここではゲームを直接進める。大破艦が出た時点で撤退する。

        Args:
            max_battles: 打ち切りまでの戦闘回数。

        Returns:
            各戦闘の勝利判定。
        """
        ranks: list[str] = []
        if self.game.sortie is None:
            return ranks

        for _ in range(max_battles):
            if self.game.sortie is None:
                break

            records = self.game.fight()
            ranks.append(self._rank_of(records))
            self.environment.records.extend(records)
            self.sync()

            target = self.game.maps[self.game.sortie.map_key]
            if self.game.at_boss or self.game.sortie.cell >= target.cells:
                break
            if self._has_heavy_damage():
                logger.info("大破艦が出たため撤退します")
                break

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

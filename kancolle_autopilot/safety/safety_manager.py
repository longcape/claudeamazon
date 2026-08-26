"""すべての安全装置を束ね、実行可否を最終判断する。

開発指示書 §8 の担当。``SafetyManager`` はすべての実行系タスクより
上位に置かれ、ここが ``STOP`` を返している間は Task を実行してはならない。

責務は 3 つ。

* **集約** … 各 Guard の判定を統合する。
* **ラッチ** … 一度 ``EMERGENCY_STOP`` に入ったら、明示的に解除される
  まで停止したままにする。次の走査でたまたま資材が回復して見えても
  自動では戻さない。
* **保護待ちの管理** … 未確認ドロップを検出したら、ロックが確認できる
  まで艦の増減を伴う操作を止める。

なお §8 が挙げる停止条件のうち「GUI 状態と API 状態が矛盾」
「操作後の結果確認に失敗」「想定外の画面」は Automation 層
（Phase 5）が :meth:`SafetyManager.trigger_emergency_stop` を呼んで
表明する。ここでは受け口だけ用意している。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable, Sequence

from core.config_manager import ConfigManager
from core.state import utcnow
from monitor.api_parser import Event, EventType
from monitor.game_state import GameState
from safety.damage_guard import DamageGuard, DamagePolicy
from safety.lock_guard import Blacklist, DismantlePolicy, LockGuard, load_blacklist
from safety.resource_guard import ResourceGuard, ResourceThresholds
from safety.verdict import SafetyLevel, SafetyVerdict

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LatchedStop:
    """ラッチされた停止理由。"""

    reason: str
    at: datetime

    def __str__(self) -> str:
        return f"{self.reason}（{self.at.isoformat()}）"


@dataclass
class PendingProtection:
    """保護が必要なドロップの記録。

    Attributes:
        master_id: 保護対象の艦種。``None`` は艦種を特定できなかった
            ケースで、自動では解消しない（人手での確認が要る）。
    """

    master_id: int | None
    name: str | None
    detected_at: datetime

    def is_satisfied(self, state: GameState) -> bool:
        """該当艦種のロック済み個体を所有していれば ``True``。"""
        if self.master_id is None:
            return False
        return any(
            ship.master_id == self.master_id and ship.locked is True
            for ship in state.ships.values()
        )


@dataclass
class SafetyManager:
    """安全判定の集約点。

    Example:
        >>> manager = SafetyManager.from_config(config)
        >>> manager.observe(derived_events)
        >>> if manager.evaluate(state, fleet_id=1).should_stop:
        ...     ...  # Task を実行しない
    """

    resource_guard: ResourceGuard = field(default_factory=ResourceGuard)
    damage_guard: DamageGuard = field(default_factory=DamageGuard)
    lock_guard: LockGuard = field(default_factory=LockGuard)
    log_stale_seconds: int = 300
    _latched: list[LatchedStop] = field(default_factory=list, init=False)
    _pending: list[PendingProtection] = field(default_factory=list, init=False)

    # ------------------------------------------------------------------
    # 生成
    # ------------------------------------------------------------------

    @classmethod
    def from_config(
        cls, config: ConfigManager, blacklist: Blacklist | None = None
    ) -> "SafetyManager":
        """設定から各 Guard を組み立てる。

        Args:
            config: 読み込み済みの設定。
            blacklist: 明示するブラックリスト。``None`` の場合は
                ``safety.blacklist_path`` から読み込む。パスは設定
                ファイルからの相対として解決する。
        """
        safety = config.as_dict()["safety"]
        if blacklist is None:
            blacklist_path = config.path.parent / str(safety["blacklist_path"])
            blacklist = load_blacklist(blacklist_path)

        return cls(
            resource_guard=ResourceGuard(ResourceThresholds.from_mapping(safety)),
            damage_guard=DamageGuard(DamagePolicy.from_mapping(safety)),
            lock_guard=LockGuard(blacklist, DismantlePolicy.from_mapping(safety)),
            log_stale_seconds=int(safety["log_stale_seconds"]),
        )

    # ------------------------------------------------------------------
    # 状態
    # ------------------------------------------------------------------

    @property
    def is_stopped(self) -> bool:
        """緊急停止がラッチされていれば ``True``。"""
        return bool(self._latched)

    @property
    def latched_reasons(self) -> tuple[str, ...]:
        """ラッチされている停止理由。"""
        return tuple(str(entry) for entry in self._latched)

    @property
    def pending_protections(self) -> tuple[PendingProtection, ...]:
        """未処理の保護要求。"""
        return tuple(self._pending)

    def trigger_emergency_stop(
        self, reason: str, at: datetime | None = None
    ) -> None:
        """緊急停止をラッチする。

        Automation 層が「操作結果を確認できない」「想定外の画面」を
        検出した場合もここを呼ぶ。
        """
        entry = LatchedStop(reason, at or utcnow())
        self._latched.append(entry)
        logger.error("緊急停止: %s", reason)

    def clear_emergency_stop(self) -> None:
        """ラッチされた停止をすべて解除する（人手での確認後に呼ぶ）。"""
        if self._latched:
            logger.warning("緊急停止を解除します: %s", self.latched_reasons)
        self._latched.clear()

    def clear_protection(self, master_id: int | None = None) -> None:
        """保護要求を手動で解消する。

        Args:
            master_id: 対象の艦種。``None`` ならすべて解消する。
        """
        before = len(self._pending)
        if master_id is None:
            self._pending.clear()
        else:
            self._pending = [
                pending
                for pending in self._pending
                if pending.master_id != master_id
            ]
        logger.info("保護要求を解消しました: %d 件", before - len(self._pending))

    # ------------------------------------------------------------------
    # イベント
    # ------------------------------------------------------------------

    def observe(self, events: Iterable[Event]) -> None:
        """イベント列を監視して、保護要求などをラッチする。"""
        for event in events:
            if event.type is EventType.UNKNOWN_SHIP_DROPPED:
                self._pending.append(
                    PendingProtection(
                        master_id=event.payload.get("master_id"),
                        name=event.payload.get("name"),
                        detected_at=event.occurred_at,
                    )
                )
                logger.warning(
                    "保護が必要なドロップを受け付けました: %s",
                    event.payload.get("name") or event.payload.get("master_id"),
                )

    def refresh_protections(self, state: GameState) -> None:
        """ロックが確認できた保護要求を解消する。"""
        remaining = [
            pending for pending in self._pending if not pending.is_satisfied(state)
        ]
        if len(remaining) != len(self._pending):
            logger.info(
                "ロックを確認した保護要求を解消しました: %d 件",
                len(self._pending) - len(remaining),
            )
        self._pending = remaining

    # ------------------------------------------------------------------
    # 判定
    # ------------------------------------------------------------------

    def evaluate(
        self,
        state: GameState,
        fleet_id: int | None = None,
        now: datetime | None = None,
    ) -> SafetyVerdict:
        """総合判定を返す。

        Args:
            state: 現在のゲーム状態。
            fleet_id: 出撃前など、艦隊を対象にする場合の ID。
            now: 判定時刻（鮮度の評価に使う）。

        Returns:
            統合された判定。``STOP`` の間は Task を実行してはならない。
        """
        self.refresh_protections(state)
        verdicts: list[SafetyVerdict] = []

        if self._latched:
            verdicts.append(
                SafetyVerdict.stop(
                    [f"緊急停止中: {reason}" for reason in self.latched_reasons]
                )
            )

        if state.is_stale(self.log_stale_seconds, now):
            verdicts.append(
                SafetyVerdict.stop(
                    [f"ログが {self.log_stale_seconds} 秒以上更新されていません"],
                    {"last_event_at": state.last_event_at},
                )
            )

        verdicts.append(self.resource_guard.check(state.resources))

        if self._pending:
            verdicts.append(
                SafetyVerdict.stop(
                    [
                        "未確認ドロップの保護が完了していません: "
                        + (pending.name or str(pending.master_id))
                        for pending in self._pending
                    ]
                )
            )

        if fleet_id is not None:
            verdicts.append(self.damage_guard.check_fleet(state, fleet_id))

        merged = SafetyVerdict.merge(verdicts)
        if merged.level is SafetyLevel.STOP:
            logger.warning("安全判定: %s", merged.describe())
        return merged

    def may_execute(
        self,
        state: GameState,
        fleet_id: int | None = None,
        now: datetime | None = None,
    ) -> bool:
        """Task を実行してよいなら ``True``。"""
        return not self.evaluate(state, fleet_id, now).should_stop

    def approve_dismantle(
        self, state: GameState, ship_ids: Sequence[int], now: datetime | None = None
    ) -> tuple[list[int], list[str]]:
        """破棄候補を最終判断する。

        全体の安全判定が ``STOP`` の場合は、個別の条件を満たしていても
        1 隻も承認しない。

        Args:
            state: 現在のゲーム状態。
            ship_ids: 候補の所有 ID。
            now: 判定時刻。

        Returns:
            ``(承認された艦 ID, 却下理由の一覧)``。
        """
        overall = self.evaluate(state, now=now)
        if overall.should_stop:
            return [], [f"全体の安全判定が STOP です: {overall.describe()}"]

        approved, rejected = self.lock_guard.approve(state, ship_ids)
        reasons = [
            f"#{decision.ship_id}: {' / '.join(decision.reasons)}"
            for decision in rejected
        ]
        return [decision.ship_id for decision in approved], reasons

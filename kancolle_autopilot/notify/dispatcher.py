"""システムの出来事を通知へ変換する。

開発指示書 §17 が挙げる重要イベントを、:class:`~notify.notifier.Notifier`
へ流す。

**同じ通知を連投しない。** 資材の下限割れは判定のたびに発生するので、
そのまま送ると数秒おきに同じ通知が飛ぶ。種類と対象の組ごとに冷却時間を
設け、その間は抑止する。抑止した件数は数えておき、後から「気づかない
うちに握り潰されていた」という状態にしない。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Mapping, Sequence

from core.state import Resources, utcnow
from monitor.game_state import GameState
from notify.message import Notification, NotificationKind, NotificationLevel
from notify.notifier import NullNotifier, Notifier
from safety.verdict import SafetyLevel, SafetyVerdict

logger = logging.getLogger(__name__)

#: 同じ通知を抑止する既定の冷却時間（秒）。
DEFAULT_COOLDOWN_SECONDS = 300


@dataclass
class NotificationDispatcher:
    """出来事を通知へ変換して送る。

    Example:
        >>> dispatcher = NotificationDispatcher(RecordingNotifier())
        >>> dispatcher.observe_verdict(verdict, state)
    """

    notifier: Notifier = field(default_factory=NullNotifier)
    cooldown_seconds: int = DEFAULT_COOLDOWN_SECONDS
    clock: Callable[[], datetime] = utcnow
    #: 冷却により抑止した件数。
    suppressed: int = 0
    _last_sent: dict[str, datetime] = field(default_factory=dict, init=False)

    # ------------------------------------------------------------------
    # 送信
    # ------------------------------------------------------------------

    def send(self, notification: Notification) -> bool:
        """冷却を確認してから送る。

        Returns:
            送ったら ``True``。抑止または失敗なら ``False``。
        """
        now = self.clock()
        previous = self._last_sent.get(notification.dedupe_key)
        if previous is not None and now - previous < timedelta(
            seconds=self.cooldown_seconds
        ):
            self.suppressed += 1
            logger.debug("冷却中のため抑止しました: %s", notification.describe())
            return False

        sent = self.notifier.send(notification)
        if sent:
            self._last_sent[notification.dedupe_key] = now
        return sent

    def reset_cooldown(self, kind: NotificationKind | None = None) -> None:
        """冷却をリセットする。

        Args:
            kind: 対象の種類。``None`` ならすべて。
        """
        if kind is None:
            self._last_sent.clear()
            return
        prefix = f"{kind.value}:"
        for key in [key for key in self._last_sent if key.startswith(prefix)]:
            del self._last_sent[key]

    # ------------------------------------------------------------------
    # 出来事ごとの入口
    # ------------------------------------------------------------------

    def safety_stop(
        self, verdict: SafetyVerdict, image_path: Path | None = None
    ) -> bool:
        """安全装置による停止を通知する。"""
        return self.send(
            Notification(
                kind=NotificationKind.SAFETY_STOP,
                title="安全判定により停止しました",
                body="\n".join(f"・{reason}" for reason in verdict.reasons),
                image_path=image_path,
                dedupe_hint="|".join(sorted(verdict.reasons)),
            )
        )

    def resource_low(
        self, resources: Resources, thresholds: Mapping[str, int]
    ) -> bool:
        """資材の下限割れを通知する。"""
        fields = {
            "燃料": str(resources.fuel),
            "弾薬": str(resources.ammo),
            "鋼材": str(resources.steel),
            "ボーキ": str(resources.bauxite),
            "バケツ": str(resources.buckets),
        }
        return self.send(
            Notification(
                kind=NotificationKind.RESOURCE_LOW,
                title="資材が下限を下回りました",
                body="閾値: " + ", ".join(f"{k}={v}" for k, v in thresholds.items()),
                fields=fields,
                dedupe_hint="resources",
            )
        )

    def damage_detected(self, ship_ids: Sequence[int]) -> bool:
        """大破の発生を通知する。"""
        return self.send(
            Notification(
                kind=NotificationKind.DAMAGE_DETECTED,
                title=f"大破艦を検出しました（{len(ship_ids)} 隻）",
                body=f"艦: {sorted(ship_ids)}",
                dedupe_hint=",".join(str(i) for i in sorted(ship_ids)),
            )
        )

    def drop_protected(
        self, name: str | None, master_id: int | None, locked: bool
    ) -> bool:
        """未所持艦の保護について通知する。

        Args:
            name: 艦名。
            master_id: 艦種マスタ ID。
            locked: ロックが確認できていれば ``True``。
        """
        label = name or (str(master_id) if master_id is not None else "艦種不明")
        title = (
            f"未所持艦をロックしました: {label}"
            if locked
            else f"未所持艦を検出しました: {label}（要ロック）"
        )
        return self.send(
            Notification(
                kind=NotificationKind.NEW_DROP_PROTECTED,
                title=title,
                level=NotificationLevel.INFO
                if locked
                else NotificationLevel.CRITICAL,
                fields={"master_id": str(master_id), "ロック": "済" if locked else "未"},
                dedupe_hint=f"{master_id}:{locked}",
            )
        )

    def task_finished(self, task_name: str, ok: bool, message: str = "") -> bool:
        """タスクの完了・失敗を通知する。"""
        kind = (
            NotificationKind.TASK_COMPLETED if ok else NotificationKind.TASK_FAILED
        )
        return self.send(
            Notification(
                kind=kind,
                title=task_name,
                body=message,
                dedupe_hint=f"{task_name}:{message}",
            )
        )

    def all_tasks_completed(self, summary: Mapping[str, object]) -> bool:
        """全タスクの完了を通知する。"""
        return self.send(
            Notification(
                kind=NotificationKind.ALL_TASKS_COMPLETED,
                title="予定していたタスクがすべて終わりました",
                fields={str(k): str(v) for k, v in summary.items()},
                dedupe_hint="all",
            )
        )

    def stop_cleared(self, reasons: Sequence[str]) -> bool:
        """緊急停止の解除を通知する。"""
        return self.send(
            Notification(
                kind=NotificationKind.STOP_CLEARED,
                title="緊急停止を解除しました",
                body="\n".join(f"・{reason}" for reason in reasons),
                dedupe_hint="cleared",
            )
        )

    # ------------------------------------------------------------------
    # 判定からの振り分け
    # ------------------------------------------------------------------

    def observe_verdict(
        self,
        verdict: SafetyVerdict,
        state: GameState,
        thresholds: Mapping[str, int] | None = None,
    ) -> list[bool]:
        """安全判定を見て、必要な通知を送る。

        資材の下限割れは専用の通知にし、それ以外の停止理由は
        ``SAFETY STOP`` にまとめる。理由の粒度が違うものを 1 種類に
        押し込むと、冷却の効き方が噛み合わなくなるため。

        Returns:
            送信した各通知の結果。
        """
        if verdict.level is not SafetyLevel.STOP:
            return []

        results: list[bool] = []
        resource_reasons = [
            reason for reason in verdict.reasons if "下限" in reason or "残量" in reason
        ]
        other_reasons = [
            reason for reason in verdict.reasons if reason not in resource_reasons
        ]

        if resource_reasons:
            results.append(self.resource_low(state.resources, thresholds or {}))
        if other_reasons:
            results.append(
                self.safety_stop(SafetyVerdict.stop(other_reasons, verdict.details))
            )
        return results

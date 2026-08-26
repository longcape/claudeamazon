"""未来タスクの予約と復元。

開発指示書 §19 の担当。「10:52 に起動 → 状態同期 → Safety Check →
Daily → Expedition → Sortie」のような予約を保持し、時刻が来たら
:class:`~core.task_queue.Task` の列へ展開する。

このモジュールは **タスクを実行しない**。時刻の管理と、キューへ渡す
形への変換だけを行う。

設計上の判断:

* **遅延した予約は既定で失効させる。** PC が落ちていて 10:52 の予約を
  23:00 に見つけた場合、そのまま実行すると意図しない時刻に動き出す。
  :attr:`Reservation.max_delay_seconds` を超えていたら ``EXPIRED``
  にして発火しない。無期限に待たせたい場合だけ明示的に ``None`` を置く。
* **予約は毎回ディスクへ書く。** PC 再起動後に復元できるようにする
  ためで、書き出しは atomic（:mod:`core.persistence`）。
* **プレイリストの順序は投入順で表現する。** キューは優先度が支配的
  なので、優先度が異なる並びを指定した場合はキューの順序が勝つ。
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from core.persistence import PersistenceError, read_json, write_json_atomic
from core.state import utcnow
from core.task_queue import Task, TaskPriority

logger = logging.getLogger(__name__)

#: 予約が遅れて発見された場合に、発火を諦めるまでの既定秒数。
DEFAULT_MAX_DELAY_SECONDS = 3600


class ReservationStatus(str, Enum):
    """予約の状態。"""

    PENDING = "PENDING"
    FIRED = "FIRED"
    CANCELLED = "CANCELLED"
    #: 時刻を過ぎすぎたため発火しなかった。
    EXPIRED = "EXPIRED"

    @property
    def is_terminal(self) -> bool:
        """これ以上変化しないなら ``True``。"""
        return self is not ReservationStatus.PENDING


def _new_id() -> str:
    """短い予約 ID を生成する。"""
    return uuid.uuid4().hex[:12]


@dataclass(frozen=True)
class TaskSpec:
    """予約に含まれるタスク 1 件の指定。

    Attributes:
        payload: タスク種別ごとのパラメータ。Scheduler は解釈しない。
    """

    name: str
    priority: TaskPriority = TaskPriority.BACKGROUND
    payload: Mapping[str, Any] = field(default_factory=dict)

    def to_task(self) -> Task:
        """キューへ載せる :class:`Task` を作る。"""
        return Task(name=self.name, priority=self.priority, payload=dict(self.payload))

    def to_dict(self) -> dict[str, Any]:
        """永続化用の辞書へ変換する。"""
        return {
            "name": self.name,
            "priority": int(self.priority),
            "payload": dict(self.payload),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "TaskSpec":
        """永続化された辞書から復元する。

        Raises:
            ValueError: 必須項目が欠けている場合。
        """
        name = data.get("name")
        if not isinstance(name, str) or not name:
            raise ValueError(f"TaskSpec に name がありません: {data!r}")
        raw_priority = data.get("priority", int(TaskPriority.BACKGROUND))
        try:
            priority = TaskPriority(int(raw_priority))
        except (TypeError, ValueError):
            logger.warning(
                "未知の優先度です。BACKGROUND として扱います: %r", raw_priority
            )
            priority = TaskPriority.BACKGROUND
        payload = data.get("payload") or {}
        if not isinstance(payload, Mapping):
            raise ValueError(f"payload がオブジェクトではありません: {data!r}")
        return cls(name=name, priority=priority, payload=dict(payload))


@dataclass
class Reservation:
    """指定時刻に投入するタスクの並び。

    Attributes:
        specs: 投入するタスク。順に投入される。
        max_delay_seconds: 予約時刻からこの秒数を過ぎたら失効させる。
            ``None`` なら遅れても必ず発火する。
    """

    run_at: datetime
    specs: Sequence[TaskSpec]
    name: str = ""
    reservation_id: str = field(default_factory=_new_id)
    status: ReservationStatus = ReservationStatus.PENDING
    created_at: datetime = field(default_factory=utcnow)
    fired_at: datetime | None = None
    max_delay_seconds: int | None = DEFAULT_MAX_DELAY_SECONDS

    def __post_init__(self) -> None:
        # 素朴な datetime を混ぜると比較で例外になるため、ここで弾く。
        if self.run_at.tzinfo is None:
            raise ValueError("run_at にはタイムゾーン付きの datetime を渡してください")

    @property
    def is_pending(self) -> bool:
        """まだ発火していなければ ``True``。"""
        return self.status is ReservationStatus.PENDING

    def is_due(self, now: datetime) -> bool:
        """発火時刻に達していれば ``True``。"""
        return self.is_pending and now >= self.run_at

    def is_expired(self, now: datetime) -> bool:
        """遅れすぎて失効しているなら ``True``。"""
        if not self.is_due(now) or self.max_delay_seconds is None:
            return False
        return now - self.run_at > timedelta(seconds=self.max_delay_seconds)

    def to_tasks(self) -> list[Task]:
        """含まれるタスクを :class:`Task` の列へ変換する。"""
        return [spec.to_task() for spec in self.specs]

    def describe(self) -> str:
        """ログ用の 1 行表記。"""
        names = " -> ".join(spec.name for spec in self.specs)
        label = self.name or self.reservation_id
        return f"{label} @ {self.run_at.isoformat()} [{names}]"

    def to_dict(self) -> dict[str, Any]:
        """永続化用の辞書へ変換する。"""
        return {
            "reservation_id": self.reservation_id,
            "name": self.name,
            "run_at": self.run_at.isoformat(),
            "status": self.status.value,
            "created_at": self.created_at.isoformat(),
            "fired_at": self.fired_at.isoformat() if self.fired_at else None,
            "max_delay_seconds": self.max_delay_seconds,
            "specs": [spec.to_dict() for spec in self.specs],
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Reservation":
        """永続化された辞書から復元する。

        Raises:
            ValueError: 必須項目が欠けている、または形式が不正な場合。
        """
        run_at = _parse_datetime(data.get("run_at"))
        if run_at is None:
            raise ValueError(f"run_at が不正です: {data!r}")

        raw_specs = data.get("specs")
        if not isinstance(raw_specs, Sequence) or isinstance(raw_specs, (str, bytes)):
            raise ValueError(f"specs が配列ではありません: {data!r}")
        specs = [TaskSpec.from_dict(entry) for entry in raw_specs]

        try:
            status = ReservationStatus(data.get("status", "PENDING"))
        except ValueError:
            logger.warning("未知の予約状態です。PENDING として扱います: %r", data)
            status = ReservationStatus.PENDING

        max_delay = data.get("max_delay_seconds", DEFAULT_MAX_DELAY_SECONDS)
        if max_delay is not None and not isinstance(max_delay, int):
            max_delay = DEFAULT_MAX_DELAY_SECONDS

        return cls(
            run_at=run_at,
            specs=specs,
            name=str(data.get("name") or ""),
            reservation_id=str(data.get("reservation_id") or _new_id()),
            status=status,
            created_at=_parse_datetime(data.get("created_at")) or utcnow(),
            fired_at=_parse_datetime(data.get("fired_at")),
            max_delay_seconds=max_delay,
        )


def _parse_datetime(value: Any) -> datetime | None:
    """ISO 8601 文字列を tz 付き :class:`datetime` へ変換する。"""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        logger.warning("時刻を解析できません: %r", value)
        return None
    if parsed.tzinfo is None:
        # 保存側の不備。UTC とみなすと時刻がずれるため、明示して残す。
        logger.warning("タイムゾーンの無い時刻を UTC として扱います: %s", value)
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


@dataclass
class Scheduler:
    """予約の保持・発火・永続化を行う。

    Example:
        >>> scheduler = Scheduler()
        >>> scheduler.reserve(run_at, [TaskSpec("daily", TaskPriority.DAILY_TASK)])
        >>> for reservation in scheduler.pop_due(now):
        ...     queue.push_all(reservation.to_tasks())
    """

    reservations: list[Reservation] = field(default_factory=list)
    state_path: Path | None = None

    # ------------------------------------------------------------------
    # 参照
    # ------------------------------------------------------------------

    def __len__(self) -> int:
        """待機中の予約数。"""
        return len(self.pending())

    def pending(self) -> list[Reservation]:
        """待機中の予約を時刻順に返す。"""
        return sorted(
            (r for r in self.reservations if r.is_pending), key=lambda r: r.run_at
        )

    def get(self, reservation_id: str) -> Reservation | None:
        """ID で予約を引く。"""
        return next(
            (r for r in self.reservations if r.reservation_id == reservation_id), None
        )

    def next_run_at(self) -> datetime | None:
        """次に発火する時刻。待機中の予約が無ければ ``None``。"""
        upcoming = self.pending()
        return upcoming[0].run_at if upcoming else None

    # ------------------------------------------------------------------
    # 更新
    # ------------------------------------------------------------------

    def reserve(
        self,
        run_at: datetime,
        specs: Iterable[TaskSpec],
        name: str = "",
        max_delay_seconds: int | None = DEFAULT_MAX_DELAY_SECONDS,
    ) -> Reservation:
        """予約を追加する。

        Args:
            run_at: 発火時刻（タイムゾーン必須）。
            specs: 投入するタスク。順に投入される。
            name: 予約の表示名。
            max_delay_seconds: 遅延の許容秒数。``None`` なら無期限。

        Returns:
            追加した予約。

        Raises:
            ValueError: ``specs`` が空、または ``run_at`` が素朴な datetime の場合。
        """
        spec_list = list(specs)
        if not spec_list:
            raise ValueError("予約には 1 件以上のタスクが必要です")

        reservation = Reservation(
            run_at=run_at,
            specs=spec_list,
            name=name,
            max_delay_seconds=max_delay_seconds,
        )
        self.reservations.append(reservation)
        logger.info("予約を追加しました: %s", reservation.describe())
        self._autosave()
        return reservation

    def cancel(self, reservation_id: str) -> bool:
        """予約を取り消す。

        Returns:
            取り消せたら ``True``。該当が無い、または既に終了していれば ``False``。
        """
        reservation = self.get(reservation_id)
        if reservation is None or not reservation.is_pending:
            return False
        reservation.status = ReservationStatus.CANCELLED
        logger.info("予約を取り消しました: %s", reservation.describe())
        self._autosave()
        return True

    def pop_due(self, now: datetime | None = None) -> list[Reservation]:
        """発火時刻に達した予約を取り出す。

        遅れすぎているものは ``EXPIRED`` にして返さない。

        Args:
            now: 現在時刻。省略時は :func:`~core.state.utcnow`。

        Returns:
            発火した予約を時刻順に並べたリスト。
        """
        current = now or utcnow()
        fired: list[Reservation] = []
        expired: list[Reservation] = []

        for reservation in sorted(self.reservations, key=lambda r: r.run_at):
            if not reservation.is_due(current):
                continue
            if reservation.is_expired(current):
                reservation.status = ReservationStatus.EXPIRED
                expired.append(reservation)
                continue
            reservation.status = ReservationStatus.FIRED
            reservation.fired_at = current
            fired.append(reservation)

        for reservation in expired:
            logger.warning(
                "予約が遅延のため失効しました（%s 秒超過）: %s",
                reservation.max_delay_seconds,
                reservation.describe(),
            )
        for reservation in fired:
            logger.info("予約を発火しました: %s", reservation.describe())

        if fired or expired:
            self._autosave()
        return fired

    def purge_terminal(self) -> int:
        """終了した予約を捨てる。

        Returns:
            捨てた件数。
        """
        before = len(self.reservations)
        self.reservations = [r for r in self.reservations if r.is_pending]
        removed = before - len(self.reservations)
        if removed:
            self._autosave()
        return removed

    # ------------------------------------------------------------------
    # 永続化
    # ------------------------------------------------------------------

    def save(self, path: str | Path | None = None) -> None:
        """予約をファイルへ書き出す。

        Raises:
            PersistenceError: 書き出しに失敗した場合。
            ValueError: 保存先が指定されていない場合。
        """
        target = Path(path) if path is not None else self.state_path
        if target is None:
            raise ValueError("保存先が指定されていません")
        write_json_atomic(
            target,
            {
                "version": 1,
                "reservations": [r.to_dict() for r in self.reservations],
            },
        )
        logger.debug("予約を保存しました: %s", target)

    @classmethod
    def load(cls, path: str | Path) -> "Scheduler":
        """ファイルから予約を復元する。

        ファイルが無い場合は空の Scheduler を返す。壊れた予約は
        読み飛ばして、残りを復元する（1 件の破損で全予約を失わない）。

        Args:
            path: 読み込み元。

        Returns:
            復元した Scheduler。
        """
        target = Path(path)
        try:
            data = read_json(target)
        except PersistenceError as exc:
            logger.error("予約を復元できません: %s", exc)
            return cls(state_path=target)

        if data is None:
            return cls(state_path=target)
        if not isinstance(data, Mapping):
            logger.error("予約ファイルの形式が不正です: %s", target)
            return cls(state_path=target)

        reservations: list[Reservation] = []
        for entry in data.get("reservations", []):
            if not isinstance(entry, Mapping):
                continue
            try:
                reservations.append(Reservation.from_dict(entry))
            except ValueError as exc:
                logger.warning("予約を読み飛ばしました: %s", exc)

        logger.info("予約を %d 件復元しました: %s", len(reservations), target)
        return cls(reservations=reservations, state_path=target)

    def _autosave(self) -> None:
        """保存先が設定されていれば書き出す（失敗しても止めない）。"""
        if self.state_path is None:
            return
        try:
            self.save()
        except PersistenceError as exc:
            logger.error("予約の保存に失敗しました: %s", exc)

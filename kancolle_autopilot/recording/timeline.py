"""操作タイムライン。

追加指示書 §12 の担当。すべての操作・判断・状態変化を 1 本の時系列に
並べ、Task ID で関連付ける。§18 のブレークポイントもここで判定する。

保存形式は JSON Lines。1 行 1 イベントなので、長い稼働でも追記でき、
壊れた行があってもそこだけ捨てて残りを読める。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

from core.persistence import write_text_atomic
from core.state import utcnow

logger = logging.getLogger(__name__)


class EventKind(str, Enum):
    """タイムラインに載るイベントの種類。"""

    TASK_START = "TASK_START"
    TASK_END = "TASK_END"
    DECISION = "DECISION"
    SCREEN = "SCREEN"
    SCREEN_CHANGE = "SCREEN_CHANGE"
    MOVE = "MOVE"
    CLICK = "CLICK"
    WAIT = "WAIT"
    BATTLE_START = "BATTLE_START"
    BATTLE_END = "BATTLE_END"
    DAMAGE = "DAMAGE"
    RESOURCE_CHANGE = "RESOURCE_CHANGE"
    SAFETY_WARNING = "SAFETY_WARNING"
    SNAPSHOT = "SNAPSHOT"


#: 追加指示書 §18 のブレークポイント名と、対応するイベント種別。
BREAKPOINTS: Mapping[str, EventKind] = {
    "on_task_start": EventKind.TASK_START,
    "on_task_end": EventKind.TASK_END,
    "on_decision": EventKind.DECISION,
    "on_screen_change": EventKind.SCREEN_CHANGE,
    "on_battle_start": EventKind.BATTLE_START,
    "on_battle_end": EventKind.BATTLE_END,
    "on_damage": EventKind.DAMAGE,
    "on_resource_change": EventKind.RESOURCE_CHANGE,
    "on_safety_warning": EventKind.SAFETY_WARNING,
}


class UnknownBreakpoint(Exception):
    """定義されていないブレークポイント名。"""

    def __init__(self, name: str) -> None:
        super().__init__(
            f"未知のブレークポイントです: {name}"
            f"（使えるのは {', '.join(sorted(BREAKPOINTS))}）"
        )
        self.name = name


@dataclass(frozen=True)
class TimelineEvent:
    """タイムライン上の 1 件。

    Attributes:
        label: ``"CLICK = QUEST"`` の右辺にあたる短い値。
        detail: 追加情報。表示には使うが、検索の鍵にはしない。
    """

    kind: EventKind
    label: str = ""
    at: datetime = field(default_factory=utcnow)
    task_id: str | None = None
    screen: str | None = None
    detail: Mapping[str, Any] = field(default_factory=dict)

    def describe(self) -> str:
        """追加指示書 §12 の形式で 1 行にする。"""
        stamp = self.at.strftime("%H:%M:%S.%f")[:-3]
        line = f"{stamp} {self.kind.value}"
        if self.label:
            line += f" = {self.label}"
        if self.task_id:
            line += f"  [{self.task_id}]"
        return line

    def to_dict(self) -> dict[str, Any]:
        """永続化用の辞書へ変換する。"""
        return {
            "kind": self.kind.value,
            "label": self.label,
            "at": self.at.isoformat(),
            "task_id": self.task_id,
            "screen": self.screen,
            "detail": dict(self.detail),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "TimelineEvent":
        """永続化された辞書から復元する。

        Raises:
            ValueError: 種別または時刻が読めない場合。
        """
        try:
            kind = EventKind(data["kind"])
        except (KeyError, ValueError) as exc:
            raise ValueError(f"イベント種別が不正です: {data!r}") from exc
        try:
            at = datetime.fromisoformat(str(data["at"]))
        except (KeyError, ValueError) as exc:
            raise ValueError(f"時刻が不正です: {data!r}") from exc
        detail = data.get("detail") or {}
        return cls(
            kind=kind,
            label=str(data.get("label") or ""),
            at=at,
            task_id=data.get("task_id"),
            screen=data.get("screen"),
            detail=dict(detail) if isinstance(detail, Mapping) else {},
        )


@dataclass
class Timeline:
    """イベントの時系列。"""

    events: list[TimelineEvent] = field(default_factory=list)

    def __len__(self) -> int:
        """イベント数。"""
        return len(self.events)

    def __iter__(self) -> Iterator[TimelineEvent]:
        """先頭から順に返す。"""
        return iter(self.events)

    def __getitem__(self, index: int) -> TimelineEvent:
        """位置で取り出す。"""
        return self.events[index]

    def append(self, event: TimelineEvent) -> TimelineEvent:
        """イベントを追加する。"""
        self.events.append(event)
        return event

    def extend(self, events: Iterable[TimelineEvent]) -> None:
        """まとめて追加する。"""
        self.events.extend(events)

    def of_kind(self, *kinds: EventKind) -> list[TimelineEvent]:
        """指定した種別だけを返す。"""
        wanted = set(kinds)
        return [event for event in self.events if event.kind in wanted]

    def of_task(self, task_id: str) -> list[TimelineEvent]:
        """指定したタスクに紐づくイベントを返す。"""
        return [event for event in self.events if event.task_id == task_id]

    def describe(self, limit: int | None = None) -> list[str]:
        """人間向けの行に整形する。"""
        events = self.events if limit is None else self.events[-limit:]
        return [event.describe() for event in events]

    # -- 永続化 ---------------------------------------------------------

    def to_jsonl(self) -> str:
        """JSON Lines 文字列へ変換する。"""
        return "".join(
            json.dumps(event.to_dict(), ensure_ascii=False) + "\n"
            for event in self.events
        )

    def save(self, path: str | Path) -> None:
        """JSON Lines として書き出す。

        Raises:
            PersistenceError: 書き出しに失敗した場合。
        """
        write_text_atomic(path, self.to_jsonl())
        logger.info("タイムラインを保存しました: %s（%d 件）", path, len(self.events))

    @classmethod
    def load(cls, path: str | Path) -> "Timeline":
        """JSON Lines から復元する。

        壊れた行は読み飛ばす。1 行の破損で記録全体を失わないため。
        """
        source = Path(path)
        if not source.exists():
            logger.warning("タイムラインがありません: %s", source)
            return cls()

        events: list[TimelineEvent] = []
        for line_no, line in enumerate(
            source.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if not line.strip():
                continue
            try:
                events.append(TimelineEvent.from_dict(json.loads(line)))
            except (json.JSONDecodeError, ValueError) as exc:
                logger.warning("%s:%d を読み飛ばしました: %s", source, line_no, exc)
        logger.info("タイムラインを復元しました: %s（%d 件）", source, len(events))
        return cls(events)


@dataclass
class BreakpointSet:
    """停止条件の集合（追加指示書 §18）。"""

    kinds: set[EventKind] = field(default_factory=set)

    @classmethod
    def from_names(cls, names: Sequence[str]) -> "BreakpointSet":
        """``on_battle_end`` のような名前から作る。

        Raises:
            UnknownBreakpoint: 未知の名前が含まれる場合。
        """
        kinds: set[EventKind] = set()
        for name in names:
            key = name.strip()
            if not key:
                continue
            if key not in BREAKPOINTS:
                raise UnknownBreakpoint(key)
            kinds.add(BREAKPOINTS[key])
        return cls(kinds)

    def __bool__(self) -> bool:
        """1 つでも設定されていれば ``True``。"""
        return bool(self.kinds)

    def matches(self, event: TimelineEvent) -> bool:
        """このイベントで止まるべきなら ``True``。"""
        return event.kind in self.kinds

    def names(self) -> list[str]:
        """設定されている名前を返す。"""
        return sorted(
            name for name, kind in BREAKPOINTS.items() if kind in self.kinds
        )

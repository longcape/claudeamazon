"""記録したタイムラインを再生する。

追加指示書 §14 の担当。GUI は無いので、再生・一時停止・やり直し・
1 ステップ・速度・任意位置へのジャンプをテキストで提供する。

速度は **記録された時刻差を割る** かたちで効かせる。等間隔で送ると、
実際には一瞬だった連打と、待ちが入った箇所の区別が消えるため。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Callable, Sequence

from recording.timeline import EventKind, Timeline, TimelineEvent

logger = logging.getLogger(__name__)

#: 1 回の待機の上限（秒）。長い空白でリプレイが止まって見えるのを防ぐ。
MAX_GAP_SECONDS = 5.0


@dataclass
class ReplayPlayer:
    """タイムラインを 1 件ずつ進める再生器。

    Example:
        >>> player = ReplayPlayer(timeline)
        >>> player.step()
        >>> player.jump(10)
        >>> player.play(speed=10.0)
    """

    timeline: Timeline
    position: int = 0
    sleep: Callable[[float], None] = field(default=None)  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.sleep is None:
            import time

            self.sleep = time.sleep

    # ------------------------------------------------------------------
    # 参照
    # ------------------------------------------------------------------

    @property
    def length(self) -> int:
        """全体の件数。"""
        return len(self.timeline)

    @property
    def finished(self) -> bool:
        """末尾まで進んでいれば ``True``。"""
        return self.position >= self.length

    @property
    def progress(self) -> str:
        """``"12/40"`` 形式の進捗。"""
        return f"{min(self.position, self.length)}/{self.length}"

    def current(self) -> TimelineEvent | None:
        """直前に再生したイベント。"""
        if 0 < self.position <= self.length:
            return self.timeline[self.position - 1]
        return None

    # ------------------------------------------------------------------
    # 操作
    # ------------------------------------------------------------------

    def restart(self) -> None:
        """先頭へ戻す。"""
        self.position = 0

    def step(self, count: int = 1) -> list[TimelineEvent]:
        """指定件数だけ進める（待機しない）。

        Returns:
            進めた分のイベント。末尾なら空リスト。
        """
        played: list[TimelineEvent] = []
        for _ in range(max(0, count)):
            if self.finished:
                break
            played.append(self.timeline[self.position])
            self.position += 1
        return played

    def jump(self, index: int) -> TimelineEvent | None:
        """任意の位置へ飛ぶ。

        Args:
            index: 0 始まりの位置。範囲外は端に丸める。

        Returns:
            その位置のイベント。タイムラインが空なら ``None``。
        """
        if self.length == 0:
            self.position = 0
            return None
        clamped = max(0, min(index, self.length - 1))
        self.position = clamped + 1
        return self.timeline[clamped]

    def seek(self, *kinds: EventKind) -> TimelineEvent | None:
        """次に現れる指定種別のイベントまで進める。

        Returns:
            見つかったイベント。無ければ ``None``（位置は末尾）。
        """
        wanted = set(kinds)
        while not self.finished:
            event = self.timeline[self.position]
            self.position += 1
            if event.kind in wanted:
                return event
        return None

    def play(
        self,
        speed: float = 1.0,
        limit: int | None = None,
        on_event: Callable[[TimelineEvent], None] | None = None,
    ) -> list[TimelineEvent]:
        """記録された間隔を保ったまま再生する。

        Args:
            speed: 再生速度。``2.0`` なら 2 倍速。
            limit: 再生する最大件数。``None`` なら末尾まで。
            on_event: 1 件ごとに呼ばれる関数。

        Returns:
            再生したイベント。

        Raises:
            ValueError: ``speed`` が 0 以下の場合。
        """
        if speed <= 0:
            raise ValueError(f"速度は正の数である必要があります: {speed}")

        played: list[TimelineEvent] = []
        while not self.finished:
            if limit is not None and len(played) >= limit:
                break
            previous = self.current()
            event = self.timeline[self.position]
            self.position += 1

            if previous is not None:
                gap = (event.at - previous.at).total_seconds()
                delay = min(max(gap, 0.0), MAX_GAP_SECONDS) / speed
                if delay > 0:
                    self.sleep(delay)

            played.append(event)
            if on_event is not None:
                on_event(event)
        return played

    # ------------------------------------------------------------------
    # 表示
    # ------------------------------------------------------------------

    def render(self, window: int = 5) -> list[str]:
        """現在位置の前後を整形して返す。

        現在のイベントには ``>`` を付ける。
        """
        if self.length == 0:
            return ["（記録がありません）"]

        current = max(0, min(self.position - 1, self.length - 1))
        start = max(0, current - window)
        end = min(self.length, current + window + 1)

        lines: list[str] = []
        for index in range(start, end):
            marker = ">" if index == current else " "
            lines.append(f"{marker} {index:4d} {self.timeline[index].describe()}")
        return lines


def summarize(timeline: Timeline) -> dict[str, int]:
    """種別ごとの件数を数える（リプレイの概要表示用）。"""
    counts: dict[str, int] = {}
    for event in timeline:
        counts[event.kind.value] = counts.get(event.kind.value, 0) + 1
    return counts


def filter_noise(timeline: Timeline, drop: Sequence[EventKind] = ()) -> Timeline:
    """指定した種別を除いた新しいタイムラインを返す。

    カーソルの ``MOVE`` は件数が多く、流れを追うときは邪魔になる。
    """
    unwanted = set(drop) or {EventKind.MOVE}
    return Timeline([event for event in timeline if event.kind not in unwanted])

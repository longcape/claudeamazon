"""カーソルの移動とクリック。

実際に何をするか（サンドボックスの仮想カーソルか、OS の入力か）は
:class:`PointerBackend` の実装が決める。このモジュールは「どこへ動かして
どこを押すか」だけを扱う。

移動の軌跡について。ここでは **直線を等間隔で補間するだけ** で、乱数も
揺らぎも入れない。軌跡を記録しているのは、追加指示書 §10・§11 の
「仮想カーソルの表示とリプレイ」のためであって、動きを人間らしく
見せるためではない。
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime

from automation.screen_detector import Point
from core.state import utcnow

logger = logging.getLogger(__name__)

#: 移動を何点に分割して記録するか。
DEFAULT_TRAJECTORY_STEPS = 8


@dataclass(frozen=True)
class CursorSample:
    """軌跡の 1 点。"""

    point: Point
    at: datetime
    event: str = "MOVE"

    def describe(self) -> str:
        """記録用の 1 行表記（追加指示書 §10 の形式）。"""
        return f"{self.at.isoformat()} {self.event} {self.point}"


class PointerBackend(ABC):
    """カーソルを動かして押す実体。"""

    @property
    @abstractmethod
    def simulated(self) -> bool:
        """OS の入力に触れないなら ``True``。"""

    @abstractmethod
    def position(self) -> Point:
        """現在のカーソル位置。"""

    @abstractmethod
    def move_to(self, point: Point) -> None:
        """カーソルを移動する。"""

    @abstractmethod
    def press(self, point: Point) -> None:
        """その位置を押す。"""


@dataclass
class VirtualPointer(PointerBackend):
    """サンドボックス用の仮想カーソル。

    OS には触れず、押された位置を :attr:`presses` に積む。環境側は
    これを見てどのウィジェットが押されたかを判定する。
    """

    point: Point = Point(0, 0)
    presses: list[Point] = field(default_factory=list)

    @property
    def simulated(self) -> bool:
        """常に ``True``。"""
        return True

    def position(self) -> Point:
        """現在位置。"""
        return self.point

    def move_to(self, point: Point) -> None:
        """位置を更新する。"""
        self.point = point

    def press(self, point: Point) -> None:
        """押された位置を記録する。"""
        self.point = point
        self.presses.append(point)


@dataclass
class MouseController:
    """カーソル操作と、その軌跡の記録。

    Example:
        >>> mouse = MouseController(VirtualPointer())
        >>> mouse.click(Point(100, 200))
        >>> mouse.trace[-1].event
        'CLICK'
    """

    backend: PointerBackend
    steps: int = DEFAULT_TRAJECTORY_STEPS
    #: これまでのカーソル軌跡（リプレイ用）。
    trace: list[CursorSample] = field(default_factory=list)

    @property
    def simulated(self) -> bool:
        """OS の入力に触れないなら ``True``。"""
        return self.backend.simulated

    def move_to(self, destination: Point) -> None:
        """カーソルを移動し、軌跡を記録する。"""
        start = self.backend.position()
        for point in interpolate(start, destination, self.steps):
            self.backend.move_to(point)
            self.trace.append(CursorSample(point, utcnow(), "MOVE"))
        logger.debug("カーソル移動: %s -> %s", start, destination)

    def click(self, destination: Point) -> None:
        """移動してからクリックする。"""
        self.move_to(destination)
        self.backend.press(destination)
        self.trace.append(CursorSample(destination, utcnow(), "CLICK"))
        logger.debug("クリック: %s", destination)

    def clear_trace(self) -> None:
        """軌跡を捨てる（長時間稼働でのメモリ肥大を防ぐ）。"""
        self.trace.clear()

    def describe_trace(self, limit: int | None = None) -> list[str]:
        """軌跡を人間向けの行に整形する。"""
        samples = self.trace if limit is None else self.trace[-limit:]
        return [sample.describe() for sample in samples]


def interpolate(start: Point, end: Point, steps: int) -> list[Point]:
    """始点から終点までを等間隔で分割する。

    始点は含めず、終点は必ず含める。``steps`` が 1 以下、または
    始点と終点が同じ場合は終点だけを返す。

    Args:
        start: 始点。
        end: 終点。
        steps: 分割数。

    Returns:
        経路上の点。
    """
    if steps <= 1 or (start.x == end.x and start.y == end.y):
        return [end]
    points: list[Point] = []
    for index in range(1, steps + 1):
        ratio = index / steps
        points.append(
            Point(
                round(start.x + (end.x - start.x) * ratio),
                round(start.y + (end.y - start.y) * ratio),
            )
        )
    return points

"""操作を受け取る側のサンドボックス環境。

Automation Layer が実際に座標を押したとき、それがどのウィジェットに
当たったのかを判定し、画面を遷移させる。実ゲームの代わりに置く。

これがあることで、論理名 → 座標 → 当たり判定 → 画面遷移 という経路
全体を閉じて検証できる。論理名のまま扱うシミュレーション
（:mod:`automation.simulation`）では、座標解決の間違いは見つからない。

サンドボックスは配置表（:data:`~automation.screen_detector.LAYOUT`）を
Automation Layer と共有する。実ゲームでは「ゲーム側の実際の配置」と
「こちらが思っている配置」が食い違いうるが、その食い違いは画像認識を
入れる段でしか検出できない。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Mapping, Sequence

from automation.interface import Screen
from automation.mouse_controller import PointerBackend
from automation.navigator import SCREEN_GRAPH
from automation.screen_detector import (
    LAYOUT,
    DynamicResolver,
    IndexedTarget,
    Point,
    Region,
    StaticTarget,
)

logger = logging.getLogger(__name__)

#: 画面遷移のうち、ナビゲーション用ボタン以外が引き起こすもの。
SANDBOX_TRANSITIONS: Mapping[tuple[Screen, str], Screen] = {
    (Screen.SORTIE_SELECT, "sortie_start"): Screen.SORTIE_MAP,
    (Screen.EXPEDITION, "mission_start"): Screen.HOME,
}

#: 解体画面の艦一覧の配置。
SHIP_LIST_FIRST = Region(80, 120, 220, 40)
SHIP_LIST_STEP_Y = 44
#: スクロールせずに見える隻数。これを超える艦は位置を決められない。
SHIP_LIST_VISIBLE = 8


@dataclass
class SandboxEnvironment(DynamicResolver):
    """画面と当たり判定を持つ仮想ゲーム。

    Attributes:
        ship_order: 解体画面に並ぶ艦の所有 ID（表示順）。
        pressed_targets: 押されたウィジェットの論理名の記録。
        misses: どのウィジェットにも当たらなかった座標の記録。
    """

    screen: Screen = Screen.HOME
    ship_order: Sequence[int] = ()
    layout: Mapping[tuple[Screen, str], StaticTarget | IndexedTarget] = field(
        default_factory=lambda: LAYOUT
    )
    pressed_targets: list[str] = field(default_factory=list)
    misses: list[Point] = field(default_factory=list)

    # -- ScreenSource ---------------------------------------------------

    def current_screen(self) -> Screen:
        """現在の画面を返す。"""
        return self.screen

    # -- DynamicResolver ------------------------------------------------

    def locate(self, screen: Screen, target: str) -> Region | None:
        """一覧に並ぶ艦の位置を返す。

        並び順を知っているのは環境側なので、``ship_<所有ID>`` の解決は
        ここが担う。一覧に無い、または画面外の艦は ``None``。
        """
        if screen is not Screen.DISMANTLE or not target.startswith("ship_"):
            return None
        try:
            ship_id = int(target[len("ship_") :])
        except ValueError:
            return None
        if ship_id not in self.ship_order:
            return None
        index = list(self.ship_order).index(ship_id)
        if index >= SHIP_LIST_VISIBLE:
            # スクロールが要る位置は「分からない」として扱う。
            logger.info("艦 #%s は画面外です（%d 番目）", ship_id, index + 1)
            return None
        return SHIP_LIST_FIRST.shifted(0, index * SHIP_LIST_STEP_Y)

    # -- 当たり判定 ------------------------------------------------------

    def hit_test(self, point: Point) -> str | None:
        """押された座標がどのウィジェットかを返す。

        Returns:
            論理名。どれにも当たらなければ ``None``。
        """
        for (screen, prefix), entry in self.layout.items():
            if screen is not self.screen:
                continue
            if isinstance(entry, StaticTarget):
                if entry.region.contains(point):
                    return prefix
                continue
            for index in range(1, entry.count + 1):
                region = entry.resolve(str(index))
                if region is not None and region.contains(point):
                    return f"{prefix}_{index}"

        if self.screen is Screen.DISMANTLE:
            for ship_id in list(self.ship_order)[:SHIP_LIST_VISIBLE]:
                region = self.locate(Screen.DISMANTLE, f"ship_{ship_id}")
                if region is not None and region.contains(point):
                    return f"ship_{ship_id}"
        return None

    def press(self, point: Point) -> str | None:
        """座標を押して、画面遷移を適用する。

        Returns:
            押されたウィジェットの論理名。外していれば ``None``。
        """
        target = self.hit_test(point)
        if target is None:
            self.misses.append(point)
            logger.warning("どのウィジェットにも当たりませんでした: %s", point)
            return None

        self.pressed_targets.append(target)
        destination = self._transition_for(target)
        if destination is not None:
            logger.debug(
                "画面遷移: %s -> %s（%s）", self.screen.value, destination.value, target
            )
            self.screen = destination
        return target

    def reset(self, screen: Screen = Screen.HOME) -> None:
        """記録を捨てて初期画面へ戻す。"""
        self.screen = screen
        self.pressed_targets.clear()
        self.misses.clear()

    def _transition_for(self, target: str) -> Screen | None:
        """押されたウィジェットによる遷移先を返す。"""
        for destination, button in SCREEN_GRAPH.get(self.screen, {}).items():
            if button == target:
                return destination
        return SANDBOX_TRANSITIONS.get((self.screen, target))


@dataclass
class SandboxPointer(PointerBackend):
    """サンドボックスへ押下を届けるカーソル。"""

    environment: SandboxEnvironment
    point: Point = Point(0, 0)

    @property
    def simulated(self) -> bool:
        """常に ``True``。OS の入力には触れない。"""
        return True

    def position(self) -> Point:
        """現在位置。"""
        return self.point

    def move_to(self, point: Point) -> None:
        """位置を更新する。"""
        self.point = point

    def press(self, point: Point) -> None:
        """サンドボックスへ押下を伝える。"""
        self.point = point
        self.environment.press(point)

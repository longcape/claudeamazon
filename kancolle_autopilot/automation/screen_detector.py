"""画面の判別と、論理名から座標への解決。

タスクは ``"sortie_start"`` のような論理名でしか操作対象を指さない
（:mod:`automation.interface` 参照）。その名前を画面上の位置へ落とすのが
このモジュールの仕事。

対象は 3 種類に分かれる。

* **固定**（:class:`StaticTarget`）… 位置が決まっているボタン。
* **番号付き**（:class:`IndexedTarget`）… ``mission_5`` や ``dock_2`` の
  ように、番号から格子状に位置が決まるもの。
* **動的** … ``ship_102`` のように、一覧の並び順とスクロール位置に
  依存するもの。静的な表からは求められない。

3 番目を推測で埋めない。位置が確定できない対象は
:class:`TargetNotFound` にして操作を失敗させる。「たぶんこの辺」で
クリックすると、隣の艦を選んだまま解体まで進みうる。
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Mapping, Protocol

from automation.interface import Screen

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Point:
    """画面上の 1 点。"""

    x: int
    y: int

    def __str__(self) -> str:
        return f"({self.x}, {self.y})"


@dataclass(frozen=True)
class Region:
    """画面上の矩形領域。"""

    x: int
    y: int
    width: int
    height: int

    @property
    def center(self) -> Point:
        """中心点。クリック位置に使う。"""
        return Point(self.x + self.width // 2, self.y + self.height // 2)

    def contains(self, point: Point) -> bool:
        """点が領域内なら ``True``。"""
        return (
            self.x <= point.x < self.x + self.width
            and self.y <= point.y < self.y + self.height
        )

    def shifted(self, dx: int, dy: int) -> "Region":
        """平行移動した領域を返す。"""
        return Region(self.x + dx, self.y + dy, self.width, self.height)


class TargetNotFound(Exception):
    """操作対象の位置を決められなかった。"""

    def __init__(self, screen: Screen, target: str) -> None:
        super().__init__(f"操作対象の位置が分かりません: {screen.value} / {target}")
        self.screen = screen
        self.target = target


@dataclass(frozen=True)
class StaticTarget:
    """位置が固定された操作対象。"""

    region: Region

    def resolve(self, suffix: str) -> Region | None:
        """位置を返す。接尾辞は使わない。"""
        return self.region if suffix == "" else None


@dataclass(frozen=True)
class IndexedTarget:
    """``mission_5`` のように番号で位置が決まる操作対象。

    Attributes:
        first: 1 番目の領域。
        step_x: 列方向の間隔。
        step_y: 行方向の間隔。
        per_row: 1 行あたりの個数。
        count: 有効な番号の上限（1 始まり）。
    """

    first: Region
    step_x: int = 0
    step_y: int = 0
    per_row: int = 1
    count: int = 1

    def resolve(self, suffix: str) -> Region | None:
        """番号から領域を求める。範囲外なら ``None``。"""
        try:
            index = int(suffix)
        except ValueError:
            return None
        if not 1 <= index <= self.count:
            return None
        offset = index - 1
        row, column = divmod(offset, self.per_row)
        return self.first.shifted(column * self.step_x, row * self.step_y)


#: 論理名の接頭辞ごとの配置。``(画面, 接頭辞) -> 対象``。
#:
#: 接頭辞は ``最後の _ より前``。``mission_5`` なら ``mission``、
#: ``sortie_start`` なら ``sortie_start``（番号が付かないものは全体）。
LAYOUT: Mapping[tuple[Screen, str], StaticTarget | IndexedTarget] = {
    # 母港
    (Screen.HOME, "sortie_button"): StaticTarget(Region(120, 380, 120, 60)),
    (Screen.HOME, "expedition_button"): StaticTarget(Region(260, 380, 120, 60)),
    (Screen.HOME, "arsenal_button"): StaticTarget(Region(400, 380, 120, 60)),
    (Screen.HOME, "quest_button"): StaticTarget(Region(540, 380, 120, 60)),
    (Screen.HOME, "fleet_button"): StaticTarget(Region(120, 460, 120, 60)),
    (Screen.HOME, "supply_button"): StaticTarget(Region(260, 460, 120, 60)),
    (Screen.HOME, "repair_button"): StaticTarget(Region(400, 460, 120, 60)),
    # 帰投した遠征の受け取り（母港に艦隊ごとに出る）。
    (Screen.HOME, "expedition_return"): IndexedTarget(
        Region(120, 200, 90, 44), step_x=100, per_row=4, count=4
    ),
    # 出撃。海域の一覧は左の列、艦隊の選択は右。重ならないように分ける。
    (Screen.SORTIE_SELECT, "area"): IndexedTarget(
        Region(60, 100, 90, 46), step_x=100, step_y=56, per_row=5, count=10
    ),
    (Screen.SORTIE_SELECT, "map"): IndexedTarget(
        Region(60, 230, 200, 40), step_y=46, per_row=1, count=6
    ),
    (Screen.SORTIE_SELECT, "fleet"): IndexedTarget(
        Region(320, 230, 80, 44), step_x=90, per_row=4, count=4
    ),
    (Screen.SORTIE_SELECT, "sortie_decide"): StaticTarget(Region(320, 320, 140, 50)),
    (Screen.SORTIE_SELECT, "sortie_start"): StaticTarget(Region(500, 320, 140, 50)),
    # 遠征
    (Screen.EXPEDITION, "mission"): IndexedTarget(
        Region(80, 110, 160, 40), step_y=44, per_row=1, count=40
    ),
    (Screen.EXPEDITION, "mission_decide"): StaticTarget(Region(520, 400, 120, 50)),
    (Screen.EXPEDITION, "fleet"): IndexedTarget(
        Region(300, 320, 80, 44), step_x=90, per_row=4, count=4
    ),
    (Screen.EXPEDITION, "mission_start"): StaticTarget(Region(520, 470, 120, 50)),
    # 海域進行中
    (Screen.SORTIE_MAP, "advance"): StaticTarget(Region(420, 430, 140, 56)),
    (Screen.SORTIE_MAP, "retreat"): StaticTarget(Region(200, 430, 140, 56)),
    # 補給
    (Screen.SUPPLY, "fleet"): IndexedTarget(
        Region(100, 110, 80, 44), step_x=90, per_row=4, count=4
    ),
    (Screen.SUPPLY, "supply_all"): StaticTarget(Region(480, 420, 160, 52)),
    # 入渠。艦一覧（動的に解決する）は x=300..520 に並ぶので、そこを避ける。
    (Screen.REPAIR, "dock"): IndexedTarget(
        Region(60, 130, 200, 56), step_y=66, per_row=1, count=4
    ),
    (Screen.REPAIR, "use_fast_repair"): StaticTarget(Region(560, 300, 150, 44)),
    (Screen.REPAIR, "repair_start"): StaticTarget(Region(560, 380, 150, 52)),
    # 工廠
    (Screen.ARSENAL, "build_button"): StaticTarget(Region(150, 200, 140, 60)),
    (Screen.ARSENAL, "develop_button"): StaticTarget(Region(310, 200, 140, 60)),
    (Screen.ARSENAL, "dismantle_button"): StaticTarget(Region(470, 200, 140, 60)),
    # 建造
    (Screen.BUILD, "dock"): IndexedTarget(
        Region(100, 140, 200, 60), step_y=70, per_row=1, count=4
    ),
    (Screen.BUILD, "recipe_input"): StaticTarget(Region(380, 160, 220, 120)),
    (Screen.BUILD, "build_start"): StaticTarget(Region(480, 420, 140, 50)),
    (Screen.BUILD, "receive_ship"): StaticTarget(Region(380, 320, 200, 50)),
    # 解体
    (Screen.DISMANTLE, "dismantle_confirm"): StaticTarget(Region(520, 440, 140, 50)),
    # 任務
    (Screen.QUEST, "tab_daily"): StaticTarget(Region(120, 90, 110, 40)),
    (Screen.QUEST, "tab_weekly"): StaticTarget(Region(240, 90, 110, 40)),
}

#: 母港へ戻るボタンの位置。どの画面でも同じ場所にある想定。
BACK_BUTTON_REGION = Region(20, 20, 80, 40)

#: 戻るボタンを持つ画面。
_SCREENS_WITH_BACK = (
    Screen.FLEET,
    Screen.SUPPLY,
    Screen.REPAIR,
    Screen.ARSENAL,
    Screen.BUILD,
    Screen.DEVELOP,
    Screen.DISMANTLE,
    Screen.EXPEDITION,
    Screen.SORTIE_SELECT,
    Screen.QUEST,
)

LAYOUT = {
    **LAYOUT,
    **{
        (screen, "back_button"): StaticTarget(BACK_BUTTON_REGION)
        for screen in _SCREENS_WITH_BACK
    },
}


def split_target(target: str) -> tuple[str, str]:
    """論理名を接頭辞と接尾辞に分ける。

    Returns:
        ``("mission", "5")`` のような組。番号が付いていなければ
        接尾辞は空文字列。

    Example:
        >>> split_target("mission_5")
        ('mission', '5')
        >>> split_target("sortie_start")
        ('sortie_start', '')
    """
    prefix, _, suffix = target.rpartition("_")
    if prefix and suffix.isdigit():
        return prefix, suffix
    return target, ""


class ScreenSource(Protocol):
    """現在の画面を教えてくれるもの。

    サンドボックスなら環境自身が、実ゲームなら画像認識が実装する。
    """

    def current_screen(self) -> Screen:
        """現在の画面を返す。"""
        ...


class DynamicResolver(ABC):
    """静的な表では位置が決まらない対象を解決する。

    一覧の並び順を知っている側（サンドボックスの環境や、実ゲームなら
    画像認識）が実装する。
    """

    @abstractmethod
    def locate(self, screen: Screen, target: str) -> Region | None:
        """位置を返す。分からなければ ``None``。"""


class ScreenDetector:
    """画面の判別と、論理名 → 領域の解決を担う。

    Args:
        source: 現在の画面を教えてくれるもの。
        layout: 配置表。既定は :data:`LAYOUT`。
        dynamic: 動的な対象の解決手段。
    """

    def __init__(
        self,
        source: ScreenSource,
        layout: Mapping[tuple[Screen, str], StaticTarget | IndexedTarget] | None = None,
        dynamic: DynamicResolver | None = None,
    ) -> None:
        self._source = source
        self._layout = layout if layout is not None else LAYOUT
        self._dynamic = dynamic

    def current_screen(self) -> Screen:
        """現在の画面を返す。"""
        return self._source.current_screen()

    def find(self, target: str, screen: Screen | None = None) -> Region | None:
        """操作対象の領域を返す。見つからなければ ``None``。"""
        where = screen if screen is not None else self.current_screen()
        prefix, suffix = split_target(target)
        entry = self._layout.get((where, prefix))
        if entry is not None:
            region = entry.resolve(suffix)
            if region is not None:
                return region

        if self._dynamic is not None:
            return self._dynamic.locate(where, target)
        return None

    def locate(self, target: str, screen: Screen | None = None) -> Region:
        """操作対象の領域を返す。

        Raises:
            TargetNotFound: 位置を決められない場合。推測した座標を
                返すことはしない。
        """
        where = screen if screen is not None else self.current_screen()
        region = self.find(target, where)
        if region is None:
            logger.warning("操作対象が見つかりません: %s / %s", where.value, target)
            raise TargetNotFound(where, target)
        return region

    def point_for(self, target: str, screen: Screen | None = None) -> Point:
        """操作対象の中心点を返す。

        Raises:
            TargetNotFound: 位置を決められない場合。
        """
        return self.locate(target, screen).center

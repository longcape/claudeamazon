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
from sandbox.game import SandboxGame

logger = logging.getLogger(__name__)

#: 画面遷移のうち、ナビゲーション用ボタン以外が引き起こすもの。
SANDBOX_TRANSITIONS: Mapping[tuple[Screen, str], Screen] = {
    (Screen.SORTIE_SELECT, "sortie_start"): Screen.SORTIE_MAP,
    (Screen.EXPEDITION, "mission_start"): Screen.HOME,
    (Screen.SORTIE_MAP, "retreat"): Screen.HOME,
}

#: 艦一覧の配置。画面ごとに置き場所が違う。
#:
#: 入渠画面ではドックの一覧と横に並ぶので、重ならない位置に置く。領域が
#: 重なると、艦を押したつもりがドックの選択になる。
SHIP_LIST_ORIGIN: Mapping[Screen, Region] = {
    Screen.DISMANTLE: Region(80, 120, 220, 40),
    Screen.REPAIR: Region(300, 120, 220, 40),
}
SHIP_LIST_STEP_Y = 44
#: スクロールせずに見える隻数。これを超える艦は位置を決められない。
SHIP_LIST_VISIBLE = 8


@dataclass
class SandboxEnvironment(DynamicResolver):
    """画面と当たり判定を持つ仮想ゲーム。

    Attributes:
        game: 背後のゲーム。与えると、押下がゲーム状態を実際に動かし、
            kcsapi 形式のレコードが :attr:`records` に積まれる。
        ship_order: 解体画面に並ぶ艦の所有 ID（表示順）。``game`` があれば
            所有艦から自動で決まる。
        selection: 画面上で選択中の項目（海域・艦隊・遠征・ドック・艦）。
        records: ゲームが吐いた kcsapi 形式のレコード。
        errors: ゲーム側が拒否した操作の理由。
        pressed_targets: 押されたウィジェットの論理名の記録。
        misses: どのウィジェットにも当たらなかった座標の記録。
    """

    screen: Screen = Screen.HOME
    game: SandboxGame | None = None
    ship_order: Sequence[int] = ()
    layout: Mapping[tuple[Screen, str], StaticTarget | IndexedTarget] = field(
        default_factory=lambda: LAYOUT
    )
    pressed_targets: list[str] = field(default_factory=list)
    misses: list[Point] = field(default_factory=list)
    selection: dict[str, object] = field(default_factory=dict)
    records: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    #: 建造レシピ。1 回のクリックでは数値を運べないため、環境側に置く。
    recipe: Mapping[str, int] = field(
        default_factory=lambda: {"fuel": 30, "ammo": 30, "steel": 30, "bauxite": 30}
    )

    def __post_init__(self) -> None:
        if self.game is not None and not self.ship_order:
            self.ship_order = sorted(self.game.ships)

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
        if screen not in (Screen.DISMANTLE, Screen.REPAIR):
            return None
        if not target.startswith("ship_"):
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
        return SHIP_LIST_ORIGIN[screen].shifted(0, index * SHIP_LIST_STEP_Y)

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

        if self.screen in (Screen.DISMANTLE, Screen.REPAIR):
            for ship_id in list(self.ship_order)[:SHIP_LIST_VISIBLE]:
                region = self.locate(self.screen, f"ship_{ship_id}")
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
        self._apply(target)
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
        self.selection.clear()
        self.records.clear()
        self.errors.clear()

    def drain_records(self) -> list[dict]:
        """溜まった kcsapi レコードを取り出して空にする。"""
        drained = list(self.records)
        self.records.clear()
        return drained

    # -- ゲームへの反映 --------------------------------------------------

    def _apply(self, target: str) -> None:
        """押されたウィジェットをゲーム操作へ変換する。

        選択系のウィジェットは :attr:`selection` を更新するだけ。
        確定系のウィジェットで実際にゲームを動かす。ゲームが拒否した
        場合は :attr:`errors` に理由を残し、状態は変えない（実ゲームで
        エラーダイアログが出るのに相当する）。
        """
        if self.game is None:
            return

        prefix, _, suffix = target.rpartition("_")
        if suffix.isdigit() and prefix in ("area", "map", "fleet", "mission", "dock"):
            self.selection[prefix] = int(suffix)
            return
        if target.startswith("ship_"):
            selected = self.selection.setdefault("ships", [])
            assert isinstance(selected, list)
            selected.append(int(target[len("ship_") :]))
            return

        try:
            self.records.extend(self._commit(target))
        except ValueError as exc:
            logger.warning("ゲームが操作を拒否しました: %s: %s", target, exc)
            self.errors.append(f"{target}: {exc}")

    def _commit(self, target: str) -> list[dict]:
        """確定系のウィジェットを処理する。"""
        assert self.game is not None
        game = self.game

        if target == "sortie_start":
            area = self.selection.get("area")
            number = self.selection.get("map")
            fleet = self.selection.get("fleet")
            if area is None or number is None or fleet is None:
                raise ValueError("海域または艦隊が選ばれていません")
            # 出撃すると最初のマスに着き、そこで戦闘が起きる。損傷を見て
            # から進撃を判断できるよう、到着時に戦うのが正しい順序。
            records = list(game.start_sortie(int(fleet), f"{area}-{number}"))
            records.extend(game.fight())
            return records

        if target == "mission_start":
            mission = self.selection.get("mission")
            fleet = self.selection.get("fleet")
            if mission is None or fleet is None:
                raise ValueError("遠征または艦隊が選ばれていません")
            return game.start_expedition(int(fleet), int(mission))

        if target == "build_start":
            dock = self.selection.get("dock")
            if dock is None:
                raise ValueError("ドックが選ばれていません")
            return game.build(int(dock), self.recipe)

        if target.startswith("expedition_return_"):
            fleet_id = int(target[len("expedition_return_") :])
            return game.complete_expedition(fleet_id)

        if target == "receive_ship":
            dock = self.selection.get("dock")
            if dock is None:
                raise ValueError("ドックが選ばれていません")
            return game.receive_ship(int(dock))

        if target == "advance":
            if game.sortie is None:
                raise ValueError("出撃中ではありません")
            current = game.maps[game.sortie.map_key]
            if game.at_boss or game.sortie.cell >= current.cells:
                # 先が無いので、進撃ではなく帰投になる。
                return game.return_to_port()
            # 次のマスへ進み、そこで戦う。
            records = list(game.advance())
            records.extend(game.fight())
            return records

        if target == "retreat":
            return game.return_to_port()

        if target == "supply_all":
            fleet = self.selection.get("fleet")
            if fleet is None:
                raise ValueError("艦隊が選ばれていません")
            return game.supply(int(fleet))

        if target == "use_fast_repair":
            ships = self.selection.get("ships") or []
            assert isinstance(ships, list)
            if not ships:
                raise ValueError("艦が選ばれていません")
            records = game.use_bucket(ships[-1])
            self.selection["ships"] = []
            return records

        if target == "repair_start":
            dock = self.selection.get("dock")
            ships = self.selection.get("ships") or []
            assert isinstance(ships, list)
            if dock is None or not ships:
                raise ValueError("ドックまたは艦が選ばれていません")
            records = game.repair(int(dock), ships[-1])
            self.selection["ships"] = []
            return records

        if target == "dismantle_confirm":
            ships = self.selection.get("ships") or []
            assert isinstance(ships, list)
            if not ships:
                raise ValueError("艦が選ばれていません")
            records = game.destroy_ships(ships)
            self.selection["ships"] = []
            self.ship_order = sorted(game.ships)
            return records

        return []

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

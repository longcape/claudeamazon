"""画面遷移の経路を求める。

どの画面からどの画面へ、どのボタンを押せば行けるかを表に持ち、
最短経路を返す。**このモジュールはクリックしない。** 実際に押して
結果を確かめるのは :mod:`automation.controller` の仕事。

経路探索と実行を分けているのは、経路の正しさだけを単体でテストしたい
のと、「どう行くか」と「行った結果を検証するか」が別の関心事だから。
"""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass
from typing import Mapping

from automation.interface import Screen

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class NavStep:
    """経路の 1 手。

    Attributes:
        target: 押すボタンの論理名。
        from_screen: 押す時点で居るべき画面。
        to_screen: 押した結果たどり着く画面。
    """

    target: str
    from_screen: Screen
    to_screen: Screen

    def describe(self) -> str:
        """ログ用の 1 行表記。"""
        return f"{self.from_screen.value} --{self.target}--> {self.to_screen.value}"


#: ``画面 -> {行き先: 押すボタン}``。
SCREEN_GRAPH: Mapping[Screen, Mapping[Screen, str]] = {
    Screen.HOME: {
        Screen.SORTIE_SELECT: "sortie_button",
        Screen.EXPEDITION: "expedition_button",
        Screen.ARSENAL: "arsenal_button",
        Screen.QUEST: "quest_button",
        Screen.FLEET: "fleet_button",
        Screen.SUPPLY: "supply_button",
        Screen.REPAIR: "repair_button",
    },
    Screen.ARSENAL: {
        Screen.BUILD: "build_button",
        Screen.DEVELOP: "develop_button",
        Screen.DISMANTLE: "dismantle_button",
        Screen.HOME: "back_button",
    },
    Screen.SORTIE_SELECT: {Screen.HOME: "back_button"},
    Screen.EXPEDITION: {Screen.HOME: "back_button"},
    Screen.QUEST: {Screen.HOME: "back_button"},
    Screen.FLEET: {Screen.HOME: "back_button"},
    Screen.SUPPLY: {Screen.HOME: "back_button"},
    Screen.REPAIR: {Screen.HOME: "back_button"},
    Screen.BUILD: {Screen.ARSENAL: "back_button"},
    Screen.DEVELOP: {Screen.ARSENAL: "back_button"},
    Screen.DISMANTLE: {Screen.ARSENAL: "back_button"},
}


class UnreachableScreen(Exception):
    """経路が存在しない。"""

    def __init__(self, source: Screen, destination: Screen) -> None:
        super().__init__(
            f"経路がありません: {source.value} -> {destination.value}"
        )
        self.source = source
        self.destination = destination


class Navigator:
    """画面遷移の経路を求める。

    Example:
        >>> Navigator().route(Screen.HOME, Screen.BUILD)
        [NavStep(...arsenal_button...), NavStep(...build_button...)]
    """

    def __init__(
        self, graph: Mapping[Screen, Mapping[Screen, str]] | None = None
    ) -> None:
        self._graph = graph if graph is not None else SCREEN_GRAPH

    def neighbours(self, screen: Screen) -> Mapping[Screen, str]:
        """その画面から直接行ける先。"""
        return self._graph.get(screen, {})

    def route(self, source: Screen, destination: Screen) -> list[NavStep]:
        """最短経路を返す。

        Args:
            source: 現在の画面。
            destination: 行き先。

        Returns:
            押すべき手順。同じ画面なら空リスト。

        Raises:
            UnreachableScreen: 経路が無い場合。画面が
                :attr:`Screen.UNKNOWN` の場合も含む（どこに居るか
                分からない状態から手探りで動かさない）。
        """
        if source is destination:
            return []
        if source is Screen.UNKNOWN:
            raise UnreachableScreen(source, destination)

        # 画面数が少ないので幅優先で十分。
        previous: dict[Screen, tuple[Screen, str]] = {}
        queue = deque([source])
        visited = {source}

        while queue:
            current = queue.popleft()
            for neighbour, target in self.neighbours(current).items():
                if neighbour in visited:
                    continue
                visited.add(neighbour)
                previous[neighbour] = (current, target)
                if neighbour is destination:
                    return self._rebuild(previous, source, destination)
                queue.append(neighbour)

        raise UnreachableScreen(source, destination)

    def can_reach(self, source: Screen, destination: Screen) -> bool:
        """経路があるなら ``True``。"""
        try:
            self.route(source, destination)
        except UnreachableScreen:
            return False
        return True

    @staticmethod
    def _rebuild(
        previous: Mapping[Screen, tuple[Screen, str]],
        source: Screen,
        destination: Screen,
    ) -> list[NavStep]:
        """逆順の記録から手順を組み立てる。"""
        steps: list[NavStep] = []
        current = destination
        while current is not source:
            came_from, target = previous[current]
            steps.append(NavStep(target, came_from, current))
            current = came_from
        steps.reverse()
        return steps

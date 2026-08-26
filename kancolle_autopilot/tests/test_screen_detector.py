"""ScreenDetector のテスト。"""

from __future__ import annotations

import pytest

from automation.interface import Screen
from automation.screen_detector import (
    IndexedTarget,
    Point,
    Region,
    ScreenDetector,
    StaticTarget,
    TargetNotFound,
    split_target,
)


class FixedSource:
    """常に同じ画面を返す ScreenSource。"""

    def __init__(self, screen: Screen) -> None:
        self.screen = screen

    def current_screen(self) -> Screen:
        return self.screen


# -- 幾何 -----------------------------------------------------------------


def test_region_center() -> None:
    assert Region(10, 20, 100, 40).center == Point(60, 40)


def test_region_contains() -> None:
    region = Region(10, 10, 20, 20)
    assert region.contains(Point(10, 10)) is True
    assert region.contains(Point(29, 29)) is True
    assert region.contains(Point(30, 30)) is False  # 右下端は含まない
    assert region.contains(Point(9, 15)) is False


def test_region_shifted() -> None:
    assert Region(0, 0, 10, 10).shifted(5, 7) == Region(5, 7, 10, 10)


# -- 論理名の分解 ---------------------------------------------------------


@pytest.mark.parametrize(
    "target, expected",
    [
        ("mission_5", ("mission", "5")),
        ("dock_12", ("dock", "12")),
        ("sortie_start", ("sortie_start", "")),
        ("back_button", ("back_button", "")),
        ("map_1-5", ("map_1-5", "")),
        ("ship_102", ("ship", "102")),
    ],
)
def test_split_target(target, expected) -> None:
    assert split_target(target) == expected


# -- 番号付き対象 ---------------------------------------------------------


def test_indexed_target_grid() -> None:
    entry = IndexedTarget(Region(0, 0, 10, 10), step_x=20, step_y=30, per_row=2, count=4)
    assert entry.resolve("1") == Region(0, 0, 10, 10)
    assert entry.resolve("2") == Region(20, 0, 10, 10)
    assert entry.resolve("3") == Region(0, 30, 10, 10)
    assert entry.resolve("4") == Region(20, 30, 10, 10)


def test_indexed_target_out_of_range() -> None:
    entry = IndexedTarget(Region(0, 0, 10, 10), count=2)
    assert entry.resolve("0") is None
    assert entry.resolve("3") is None
    assert entry.resolve("x") is None


def test_static_target_ignores_suffix() -> None:
    entry = StaticTarget(Region(1, 2, 3, 4))
    assert entry.resolve("") == Region(1, 2, 3, 4)
    assert entry.resolve("5") is None


# -- 解決 -----------------------------------------------------------------


def test_locate_static_button() -> None:
    detector = ScreenDetector(FixedSource(Screen.HOME))
    assert detector.locate("sortie_button").width == 120


def test_locate_indexed_target() -> None:
    detector = ScreenDetector(FixedSource(Screen.EXPEDITION))
    first = detector.locate("mission_1")
    fifth = detector.locate("mission_5")
    assert fifth.y - first.y == 44 * 4


def test_locate_uses_current_screen() -> None:
    """同じ論理名でも、画面が違えば見つからない。"""
    detector = ScreenDetector(FixedSource(Screen.BUILD))
    with pytest.raises(TargetNotFound):
        detector.locate("sortie_button")


def test_unknown_target_raises_instead_of_guessing() -> None:
    """位置が分からないときに座標を推測しない。"""
    detector = ScreenDetector(FixedSource(Screen.HOME))
    with pytest.raises(TargetNotFound, match="位置が分かりません"):
        detector.locate("mystery_button")


def test_find_returns_none_instead_of_raising() -> None:
    detector = ScreenDetector(FixedSource(Screen.HOME))
    assert detector.find("mystery_button") is None


def test_point_for_returns_center() -> None:
    detector = ScreenDetector(FixedSource(Screen.HOME))
    region = detector.locate("sortie_button")
    assert detector.point_for("sortie_button") == region.center


def test_dynamic_resolver_is_consulted() -> None:
    """静的な表に無い対象は動的解決へ回す。"""

    class Resolver:
        def locate(self, screen: Screen, target: str) -> Region | None:
            return Region(1, 2, 3, 4) if target == "ship_102" else None

    detector = ScreenDetector(FixedSource(Screen.DISMANTLE), dynamic=Resolver())
    assert detector.locate("ship_102") == Region(1, 2, 3, 4)
    with pytest.raises(TargetNotFound):
        detector.locate("ship_999")


def test_back_button_exists_on_sub_screens() -> None:
    for screen in (Screen.BUILD, Screen.EXPEDITION, Screen.QUEST, Screen.ARSENAL):
        detector = ScreenDetector(FixedSource(screen))
        assert detector.find("back_button") is not None

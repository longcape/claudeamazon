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


# -- 領域が重ならないこと -------------------------------------------------


def _regions_for(screen: Screen) -> list[tuple[str, Region]]:
    """その画面のすべての操作対象と領域を並べる。"""
    from automation.screen_detector import LAYOUT

    found: list[tuple[str, Region]] = []
    for (where, prefix), entry in LAYOUT.items():
        if where is not screen:
            continue
        if isinstance(entry, StaticTarget):
            found.append((prefix, entry.region))
            continue
        for index in range(1, entry.count + 1):
            region = entry.resolve(str(index))
            if region is not None:
                found.append((f"{prefix}_{index}", region))
    return found


def _overlaps(left: Region, right: Region) -> bool:
    """2 つの領域が重なっていれば ``True``。"""
    return (
        left.x < right.x + right.width
        and right.x < left.x + left.width
        and left.y < right.y + right.height
        and right.y < left.y + left.height
    )


@pytest.mark.parametrize("screen", list(Screen))
def test_layout_regions_do_not_overlap(screen) -> None:
    """同じ画面の操作対象が重なっていないこと。

    重なっていると、ある対象を押したつもりが別の対象になる。入渠画面で
    実際に起きた（艦を選んだつもりがドックの選択になっていた）。
    """
    regions = _regions_for(screen)
    for index, (name, region) in enumerate(regions):
        for other_name, other in regions[index + 1 :]:
            assert not _overlaps(region, other), (
                f"{screen.value}: {name} と {other_name} が重なっています"
            )


@pytest.mark.parametrize("screen", [Screen.DISMANTLE, Screen.REPAIR])
def test_ship_list_does_not_overlap_the_layout(screen) -> None:
    """動的に置かれる艦一覧が、固定の対象と重なっていないこと。"""
    from sandbox.environment import (
        SHIP_LIST_ORIGIN,
        SHIP_LIST_STEP_Y,
        SHIP_LIST_VISIBLE,
    )

    origin = SHIP_LIST_ORIGIN[screen]
    ship_regions = [
        origin.shifted(0, index * SHIP_LIST_STEP_Y)
        for index in range(SHIP_LIST_VISIBLE)
    ]
    for name, region in _regions_for(screen):
        for index, ship_region in enumerate(ship_regions):
            assert not _overlaps(region, ship_region), (
                f"{screen.value}: {name} と艦一覧の {index + 1} 番目が重なっています"
            )

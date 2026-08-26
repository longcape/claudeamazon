"""Navigator のテスト。"""

from __future__ import annotations

import pytest

from automation.interface import Screen
from automation.navigator import Navigator, UnreachableScreen


@pytest.fixture
def navigator() -> Navigator:
    return Navigator()


def targets(steps) -> list[str]:
    return [step.target for step in steps]


def test_same_screen_needs_no_steps(navigator: Navigator) -> None:
    assert navigator.route(Screen.HOME, Screen.HOME) == []


def test_direct_route(navigator: Navigator) -> None:
    steps = navigator.route(Screen.HOME, Screen.EXPEDITION)
    assert targets(steps) == ["expedition_button"]
    assert steps[0].from_screen is Screen.HOME
    assert steps[0].to_screen is Screen.EXPEDITION


def test_two_step_route(navigator: Navigator) -> None:
    """工廠を経由しないと建造画面へは行けない。"""
    steps = navigator.route(Screen.HOME, Screen.BUILD)
    assert targets(steps) == ["arsenal_button", "build_button"]


def test_route_back_to_home(navigator: Navigator) -> None:
    steps = navigator.route(Screen.BUILD, Screen.HOME)
    assert targets(steps) == ["back_button", "back_button"]
    assert steps[-1].to_screen is Screen.HOME


def test_route_between_sibling_screens(navigator: Navigator) -> None:
    """出撃画面から建造画面へは、母港と工廠を経由する。"""
    steps = navigator.route(Screen.SORTIE_SELECT, Screen.BUILD)
    assert targets(steps) == ["back_button", "arsenal_button", "build_button"]


def test_route_is_shortest(navigator: Navigator) -> None:
    steps = navigator.route(Screen.DISMANTLE, Screen.DEVELOP)
    assert targets(steps) == ["back_button", "develop_button"]


def test_unknown_screen_is_unreachable(navigator: Navigator) -> None:
    """どこに居るか分からない状態から手探りで動かさない。"""
    with pytest.raises(UnreachableScreen):
        navigator.route(Screen.UNKNOWN, Screen.HOME)


def test_unreachable_destination(navigator: Navigator) -> None:
    with pytest.raises(UnreachableScreen):
        navigator.route(Screen.HOME, Screen.BATTLE)


def test_can_reach(navigator: Navigator) -> None:
    assert navigator.can_reach(Screen.HOME, Screen.DISMANTLE) is True
    assert navigator.can_reach(Screen.HOME, Screen.BATTLE) is False


def test_custom_graph() -> None:
    navigator = Navigator({Screen.HOME: {Screen.QUEST: "q"}})
    assert targets(navigator.route(Screen.HOME, Screen.QUEST)) == ["q"]
    assert navigator.can_reach(Screen.HOME, Screen.BUILD) is False


def test_step_describe(navigator: Navigator) -> None:
    step = navigator.route(Screen.HOME, Screen.ARSENAL)[0]
    assert step.describe() == "HOME --arsenal_button--> ARSENAL"

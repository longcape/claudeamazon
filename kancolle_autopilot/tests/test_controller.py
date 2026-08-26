"""ControlledInterface とサンドボックス環境のテスト。"""

from __future__ import annotations

import pytest

from automation.controller import ControlledInterface
from automation.interface import Action, ActionKind, Screen
from automation.keyboard_controller import KeyboardController, VirtualKeyboard
from automation.mouse_controller import MouseController
from automation.screen_detector import Point, ScreenDetector
from sandbox.environment import (
    SHIP_LIST_VISIBLE,
    SandboxEnvironment,
    SandboxPointer,
)


@pytest.fixture
def env() -> SandboxEnvironment:
    return SandboxEnvironment(ship_order=[101, 102, 103])


@pytest.fixture
def keyboard_backend() -> VirtualKeyboard:
    return VirtualKeyboard()


@pytest.fixture
def interface(
    env: SandboxEnvironment, keyboard_backend: VirtualKeyboard
) -> ControlledInterface:
    """時間を止めた ControlledInterface。"""
    ticks = iter(range(0, 10_000))
    return ControlledInterface(
        detector=ScreenDetector(env, dynamic=env),
        mouse=MouseController(SandboxPointer(env)),
        keyboard=KeyboardController(keyboard_backend),
        clock=lambda: float(next(ticks)),
        sleep=lambda _: None,
    )


# ======================================================================
# サンドボックス環境
# ======================================================================


def test_hit_test_finds_button(env: SandboxEnvironment) -> None:
    assert env.hit_test(Point(180, 410)) == "sortie_button"


def test_hit_test_misses(env: SandboxEnvironment) -> None:
    assert env.hit_test(Point(5, 5)) is None


def test_press_records_miss(env: SandboxEnvironment) -> None:
    assert env.press(Point(5, 5)) is None
    assert env.misses == [Point(5, 5)]
    assert env.screen is Screen.HOME


def test_press_transitions_screen(env: SandboxEnvironment) -> None:
    env.press(Point(180, 410))
    assert env.screen is Screen.SORTIE_SELECT


def test_indexed_hit_test(env: SandboxEnvironment) -> None:
    env.screen = Screen.EXPEDITION
    from automation.screen_detector import LAYOUT

    region = LAYOUT[(Screen.EXPEDITION, "mission")].resolve("3")
    assert env.hit_test(region.center) == "mission_3"


def test_ship_list_is_resolved_by_order(env: SandboxEnvironment) -> None:
    """艦の位置は一覧の並び順から決まる。"""
    first = env.locate(Screen.DISMANTLE, "ship_101")
    second = env.locate(Screen.DISMANTLE, "ship_102")
    assert second.y - first.y == 44


def test_ship_outside_list_is_unresolvable(env: SandboxEnvironment) -> None:
    assert env.locate(Screen.DISMANTLE, "ship_999") is None


def test_ship_below_the_fold_is_unresolvable() -> None:
    """スクロールが要る位置は「分からない」として扱う。"""
    env = SandboxEnvironment(ship_order=list(range(1, SHIP_LIST_VISIBLE + 3)))
    assert env.locate(Screen.DISMANTLE, f"ship_{SHIP_LIST_VISIBLE}") is not None
    assert env.locate(Screen.DISMANTLE, f"ship_{SHIP_LIST_VISIBLE + 1}") is None


def test_reset(env: SandboxEnvironment) -> None:
    env.press(Point(180, 410))
    env.reset()
    assert env.screen is Screen.HOME
    assert env.pressed_targets == []


# ======================================================================
# 座標を経由した操作
# ======================================================================


def test_click_reaches_the_right_widget(
    interface: ControlledInterface, env: SandboxEnvironment
) -> None:
    """論理名 → 座標 → 当たり判定 が一致する。"""
    assert interface.click("sortie_button", Screen.HOME).ok is True
    assert env.pressed_targets == ["sortie_button"]
    assert env.misses == []


def test_navigate_walks_the_route(
    interface: ControlledInterface, env: SandboxEnvironment
) -> None:
    assert interface.navigate(Screen.BUILD).ok is True
    assert env.pressed_targets == ["arsenal_button", "build_button"]
    assert env.screen is Screen.BUILD


def test_navigate_back_to_home(
    interface: ControlledInterface, env: SandboxEnvironment
) -> None:
    interface.navigate(Screen.BUILD)
    assert interface.navigate(Screen.HOME).ok is True
    assert env.screen is Screen.HOME


def test_navigate_to_unreachable_screen_fails(
    interface: ControlledInterface,
) -> None:
    result = interface.navigate(Screen.BATTLE)
    assert result.ok is False
    assert "経路がありません" in result.message


def test_cursor_trace_is_recorded(interface: ControlledInterface) -> None:
    interface.click("sortie_button", Screen.HOME)
    events = [sample.event for sample in interface.mouse.trace]
    assert events[-1] == "CLICK"
    assert "MOVE" in events


# ======================================================================
# §15 の必須事項
# ======================================================================


def test_wrong_screen_blocks_click(
    interface: ControlledInterface, env: SandboxEnvironment
) -> None:
    """目的画面確認。違う画面なら押さない。"""
    result = interface.click("build_start", Screen.BUILD)
    assert result.ok is False
    assert "画面が違います" in result.message
    assert env.pressed_targets == []


def test_unknown_target_blocks_click(
    interface: ControlledInterface, env: SandboxEnvironment
) -> None:
    """操作対象確認。位置が分からなければ押さない。"""
    result = interface.click("mystery_button", Screen.HOME)
    assert result.ok is False
    assert "位置が分かりません" in result.message
    assert env.pressed_targets == []


def test_wait_for_state_succeeds_immediately(
    interface: ControlledInterface,
) -> None:
    assert interface.wait_for_state(Screen.HOME).ok is True


def test_wait_for_state_times_out(interface: ControlledInterface) -> None:
    """タイムアウト。画面の変化を無限には待たない。"""
    result = interface.wait_for_state(Screen.BATTLE, timeout=3)
    assert result.ok is False
    assert "タイムアウト" in result.message


def test_action_budget_stops_runaway_clicking(
    interface: ControlledInterface, env: SandboxEnvironment
) -> None:
    """連続操作回数制限。予算を使い切ったら止まる。"""
    interface.reset_budget(2)
    assert interface.click("sortie_button", Screen.HOME).ok is True
    assert interface.click("back_button", Screen.SORTIE_SELECT).ok is True

    blocked = interface.click("sortie_button", Screen.HOME)
    assert blocked.ok is False
    assert "上限に達しました" in blocked.message
    assert len(env.pressed_targets) == 2


def test_reset_budget_allows_more_actions(interface: ControlledInterface) -> None:
    interface.reset_budget(0)
    assert interface.click("sortie_button", Screen.HOME).ok is False
    interface.reset_budget(5)
    assert interface.click("sortie_button", Screen.HOME).ok is True


def test_kill_switch_blocks_every_action(
    interface: ControlledInterface,
    env: SandboxEnvironment,
    keyboard_backend: VirtualKeyboard,
) -> None:
    """キルスイッチ。押されたら以降は一切操作しない。"""
    keyboard_backend.hold("f12")

    assert interface.click("sortie_button", Screen.HOME).ok is False
    assert interface.navigate(Screen.BUILD).ok is False
    assert interface.wait_for_state(Screen.HOME).ok is False
    assert env.pressed_targets == []


def test_kill_switch_stays_latched_after_release(
    interface: ControlledInterface, keyboard_backend: VirtualKeyboard
) -> None:
    keyboard_backend.hold("f12")
    interface.click("sortie_button", Screen.HOME)
    keyboard_backend.release("f12")
    assert interface.click("sortie_button", Screen.HOME).ok is False


def test_execute_action_dispatches(interface: ControlledInterface) -> None:
    assert interface.execute_action(
        Action(ActionKind.NAVIGATE, Screen.ARSENAL.value)
    ).ok is True
    assert interface.execute_action(
        Action(ActionKind.CLICK, "build_button", Screen.ARSENAL)
    ).ok is True
    assert interface.execute_action(
        Action(ActionKind.WAIT, Screen.BUILD.value)
    ).ok is True

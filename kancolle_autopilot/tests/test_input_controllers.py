"""MouseController / KeyboardController のテスト。"""

from __future__ import annotations

from automation.keyboard_controller import KeyboardController, VirtualKeyboard
from automation.mouse_controller import (
    MouseController,
    VirtualPointer,
    interpolate,
)
from automation.screen_detector import Point


# -- 補間 -----------------------------------------------------------------


def test_interpolate_reaches_destination() -> None:
    points = interpolate(Point(0, 0), Point(100, 50), 5)
    assert points[-1] == Point(100, 50)
    assert len(points) == 5


def test_interpolate_is_evenly_spaced() -> None:
    """直線を等間隔に割るだけ。揺らぎは入れない。"""
    points = interpolate(Point(0, 0), Point(100, 0), 4)
    assert [point.x for point in points] == [25, 50, 75, 100]


def test_interpolate_is_deterministic() -> None:
    assert interpolate(Point(3, 7), Point(90, 40), 6) == interpolate(
        Point(3, 7), Point(90, 40), 6
    )


def test_interpolate_same_point() -> None:
    assert interpolate(Point(5, 5), Point(5, 5), 8) == [Point(5, 5)]


def test_interpolate_single_step() -> None:
    assert interpolate(Point(0, 0), Point(9, 9), 1) == [Point(9, 9)]


# -- マウス ---------------------------------------------------------------


def test_click_moves_then_presses() -> None:
    pointer = VirtualPointer()
    mouse = MouseController(pointer, steps=4)
    mouse.click(Point(40, 20))

    assert pointer.presses == [Point(40, 20)]
    assert pointer.position() == Point(40, 20)
    assert [sample.event for sample in mouse.trace] == ["MOVE"] * 4 + ["CLICK"]


def test_trace_records_positions() -> None:
    mouse = MouseController(VirtualPointer(), steps=2)
    mouse.move_to(Point(10, 10))
    assert mouse.trace[-1].point == Point(10, 10)


def test_describe_trace_format() -> None:
    mouse = MouseController(VirtualPointer(), steps=1)
    mouse.click(Point(3, 4))
    line = mouse.describe_trace(1)[0]
    assert "CLICK" in line
    assert "(3, 4)" in line


def test_clear_trace() -> None:
    mouse = MouseController(VirtualPointer())
    mouse.click(Point(1, 1))
    mouse.clear_trace()
    assert mouse.trace == []


def test_virtual_pointer_is_simulated() -> None:
    assert MouseController(VirtualPointer()).simulated is True


# -- キーボード -----------------------------------------------------------


def test_press_records_key() -> None:
    keyboard = VirtualKeyboard()
    KeyboardController(keyboard).press("enter")
    assert keyboard.sent == ["enter"]


def test_kill_switch_not_triggered_by_default() -> None:
    controller = KeyboardController(VirtualKeyboard())
    assert controller.poll_kill_switch() is False


def test_kill_switch_latches() -> None:
    """一瞬押しただけでも止まり続ける。"""
    backend = VirtualKeyboard()
    controller = KeyboardController(backend)

    backend.hold("f12")
    assert controller.poll_kill_switch() is True

    backend.release("f12")
    assert controller.poll_kill_switch() is True
    assert controller.kill_switch_triggered is True


def test_kill_switch_reset() -> None:
    backend = VirtualKeyboard()
    controller = KeyboardController(backend)
    backend.hold("f12")
    controller.poll_kill_switch()
    backend.release("f12")

    controller.reset_kill_switch()
    assert controller.poll_kill_switch() is False


def test_kill_switch_key_is_configurable() -> None:
    backend = VirtualKeyboard()
    controller = KeyboardController(backend, kill_switch_key="esc")
    backend.hold("f12")
    assert controller.poll_kill_switch() is False
    backend.hold("esc")
    assert controller.poll_kill_switch() is True

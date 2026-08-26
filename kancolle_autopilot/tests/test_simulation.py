"""SimulationInterface のテスト。"""

from __future__ import annotations

import logging

import pytest

from automation.interface import Action, ActionKind, Screen
from automation.simulation import (
    SIMULATION_PREFIX,
    SimulationInterface,
    build_interface,
)


@pytest.fixture
def interface() -> SimulationInterface:
    return SimulationInterface(screen=Screen.HOME)


def test_starts_at_home(interface: SimulationInterface) -> None:
    assert interface.get_state() is Screen.HOME
    assert interface.simulated is True


def test_navigate_changes_screen(interface: SimulationInterface) -> None:
    result = interface.navigate(Screen.EXPEDITION)
    assert result.ok is True
    assert interface.get_state() is Screen.EXPEDITION


def test_click_records_action(interface: SimulationInterface) -> None:
    result = interface.click("sortie_start", Screen.HOME, "出撃")
    assert result.ok is True
    assert result.simulated is True
    assert interface.action_targets == ["sortie_start"]


def test_click_on_wrong_screen_fails(interface: SimulationInterface) -> None:
    """誤クリック防止。想定した画面でなければ操作しない。"""
    result = interface.click("sortie_start", Screen.BUILD)
    assert result.ok is False
    assert "画面が違います" in result.message


def test_click_without_screen_requirement_always_runs(
    interface: SimulationInterface,
) -> None:
    assert interface.click("anything").ok is True


def test_transitions_change_screen() -> None:
    interface = SimulationInterface(
        screen=Screen.SORTIE_SELECT,
        transitions={(Screen.SORTIE_SELECT, "sortie_start"): Screen.SORTIE_MAP},
    )
    interface.click("sortie_start", Screen.SORTIE_SELECT)
    assert interface.get_state() is Screen.SORTIE_MAP


def test_wait_for_state_succeeds_when_screen_matches(
    interface: SimulationInterface,
) -> None:
    assert interface.wait_for_state(Screen.HOME).ok is True


def test_wait_for_state_fails_when_screen_differs(
    interface: SimulationInterface,
) -> None:
    result = interface.wait_for_state(Screen.BATTLE)
    assert result.ok is False
    assert "画面が変わりませんでした" in result.message


def test_failing_targets_simulate_errors() -> None:
    """異常系の検証用に、特定の操作を必ず失敗させられる。"""
    interface = SimulationInterface(failing_targets=frozenset({"build_start"}))
    assert interface.click("build_start").ok is False
    assert interface.click("other").ok is True


def test_failing_navigation() -> None:
    interface = SimulationInterface(failing_targets=frozenset({Screen.BUILD.value}))
    result = interface.navigate(Screen.BUILD)
    assert result.ok is False
    assert interface.get_state() is Screen.HOME


def test_execute_action_dispatches(interface: SimulationInterface) -> None:
    interface.execute_action(Action(ActionKind.NAVIGATE, Screen.QUEST.value))
    assert interface.get_state() is Screen.QUEST
    assert interface.execute_action(
        Action(ActionKind.CLICK, "tab_daily", Screen.QUEST)
    ).ok is True
    assert interface.execute_action(
        Action(ActionKind.WAIT, Screen.QUEST.value)
    ).ok is True


def test_logs_use_simulation_prefix(
    interface: SimulationInterface, caplog: pytest.LogCaptureFixture
) -> None:
    """§13 のとおり、実際にはクリックしないことがログで分かる。"""
    with caplog.at_level(logging.INFO, logger="automation.simulation"):
        interface.click("sortie_start", Screen.HOME, "出撃する")
    assert SIMULATION_PREFIX in caplog.text
    assert "sortie_start" in caplog.text


def test_reset_clears_actions(interface: SimulationInterface) -> None:
    interface.click("a")
    interface.navigate(Screen.BUILD)
    interface.reset()
    assert interface.actions == []
    assert interface.get_state() is Screen.HOME


# -- ファクトリ -----------------------------------------------------------


def test_build_interface_returns_simulation() -> None:
    assert isinstance(build_interface(True), SimulationInterface)


def test_build_interface_refuses_real_mode() -> None:
    """実操作を要求されたら黙ってシミュレーションへ落とさない。"""
    with pytest.raises(NotImplementedError, match="Phase 5"):
        build_interface(False)

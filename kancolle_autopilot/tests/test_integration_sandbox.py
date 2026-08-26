"""Phase 4 のタスクを、Phase 5 の操作層とサンドボックスに対して通す統合テスト。

論理名で書かれたタスクが、座標解決・当たり判定・画面遷移まで含めて
動作するかを確かめる。シミュレーション実装では座標の間違いは見つからない。
"""

from __future__ import annotations

import pytest

from automation.controller import ControlledInterface
from automation.interface import Screen
from automation.keyboard_controller import KeyboardController, VirtualKeyboard
from automation.mouse_controller import MouseController
from automation.screen_detector import ScreenDetector
from sandbox.environment import SandboxEnvironment, SandboxPointer
from tasks.base_task import TaskContext
from tasks.construction_task import ConstructionTask
from tasks.daily_task import DailyTask
from tasks.dismantle_task import DismantleTask
from tasks.expedition_task import ExpeditionTask
from tasks.sortie_task import SortieTask
from tests.task_helpers import (
    T0,
    add_build_docks,
    free_fleet,
    make_safety,
    make_state,
)


@pytest.fixture
def env() -> SandboxEnvironment:
    return SandboxEnvironment(ship_order=[101, 102, 103])


@pytest.fixture
def keyboard() -> VirtualKeyboard:
    return VirtualKeyboard()


@pytest.fixture
def interface(
    env: SandboxEnvironment, keyboard: VirtualKeyboard
) -> ControlledInterface:
    ticks = iter(range(0, 10_000))
    return ControlledInterface(
        detector=ScreenDetector(env, dynamic=env),
        mouse=MouseController(SandboxPointer(env)),
        keyboard=KeyboardController(keyboard),
        clock=lambda: float(next(ticks)),
        sleep=lambda _: None,
    )


def context(state, interface, safety=None) -> TaskContext:
    return TaskContext(
        game_state=state,
        safety=safety or make_safety(),
        interface=interface,
        now=T0,
    )


def test_sortie_reaches_the_map(
    interface: ControlledInterface, env: SandboxEnvironment
) -> None:
    state = free_fleet(make_state())
    result = SortieTask(fleet_id=2, map_area=1, map_no=5).execute(
        context(state, interface)
    )

    assert result.ok is True
    assert env.pressed_targets == [
        "sortie_button",
        "area_1",
        "map_5",
        "sortie_decide",
        "fleet_2",
        "sortie_start",
    ]
    assert env.screen is Screen.SORTIE_MAP
    assert env.misses == []


def test_expedition_returns_home(
    interface: ControlledInterface, env: SandboxEnvironment
) -> None:
    state = free_fleet(make_state())
    result = ExpeditionTask(fleet_id=2, mission_id=5).execute(context(state, interface))

    assert result.ok is True
    assert env.pressed_targets == [
        "expedition_button",
        "mission_5",
        "mission_decide",
        "fleet_2",
        "mission_start",
    ]
    assert env.screen is Screen.HOME


def test_construction_navigates_through_arsenal(
    interface: ControlledInterface, env: SandboxEnvironment
) -> None:
    state = add_build_docks(make_state())
    result = ConstructionTask().execute(context(state, interface))

    assert result.ok is True
    assert env.pressed_targets == [
        "arsenal_button",
        "build_button",
        "dock_1",
        "recipe_input",
        "build_start",
    ]


def test_daily_opens_quest_screen(
    interface: ControlledInterface, env: SandboxEnvironment
) -> None:
    from core.state import Quest, QuestState

    state = make_state()
    state.quests[201] = Quest(quest_id=201, state=QuestState.COMPLETE)
    result = DailyTask([201]).execute(context(state, interface))

    assert result.ok is True
    assert env.pressed_targets == ["quest_button", "tab_daily"]


def test_dismantle_clicks_the_right_row(
    interface: ControlledInterface, env: SandboxEnvironment
) -> None:
    """一覧の並び順から、承認された艦だけを正しい行で押す。"""
    state = make_state()
    state.fleets[2].ship_ids = []
    result = DismantleTask([101, 102, 103]).execute(context(state, interface))

    assert result.ok is True
    assert env.pressed_targets == [
        "arsenal_button",
        "dismantle_button",
        "ship_102",
        "dismantle_confirm",
    ]
    assert env.misses == []


def test_dismantle_fails_when_ship_is_not_listed(
    interface: ControlledInterface, env: SandboxEnvironment
) -> None:
    """一覧に無い艦は位置が決まらないので、押さずに失敗する。"""
    env.ship_order = [101, 103]  # #102 が一覧に無い
    state = make_state()
    state.fleets[2].ship_ids = []
    ctx = context(state, interface)
    result = DismantleTask([102]).execute(ctx)

    assert result.ok is False
    assert "位置が分かりません" in result.message
    assert "ship_102" not in env.pressed_targets
    assert ctx.safety.is_stopped is True


def test_kill_switch_stops_a_running_task(
    interface: ControlledInterface,
    env: SandboxEnvironment,
    keyboard: VirtualKeyboard,
) -> None:
    """タスク実行中でも、キルスイッチが押されていれば操作しない。"""
    keyboard.hold("f12")
    state = free_fleet(make_state())
    ctx = context(state, interface)
    result = SortieTask(fleet_id=2, map_area=1, map_no=5).execute(ctx)

    assert result.ok is False
    assert env.pressed_targets == []
    assert ctx.safety.is_stopped is True


def test_action_budget_stops_a_running_task(
    interface: ControlledInterface, env: SandboxEnvironment
) -> None:
    interface.reset_budget(2)
    state = free_fleet(make_state())
    ctx = context(state, interface)
    result = SortieTask(fleet_id=2, map_area=1, map_no=5).execute(ctx)

    assert result.ok is False
    assert len(env.pressed_targets) == 2
    assert ctx.safety.is_stopped is True

"""個々のタスクのテスト。"""

from __future__ import annotations

import pytest

from automation.interface import Screen
from automation.simulation import SimulationInterface
from core.state import BuildDock, Quest, QuestState, Resources
from tasks.construction_task import MINIMUM_RECIPE, ConstructionTask, Recipe
from tasks.daily_task import DailyTask
from tasks.dismantle_task import DismantleTask
from tasks.expedition_task import ExpeditionTask
from tasks.sortie_task import SortieTask
from tests.task_helpers import (
    add_build_docks,
    free_fleet,
    make_context,
    make_safety,
    make_state,
)


# ======================================================================
# 遠征
# ======================================================================


@pytest.fixture
def expedition_interface() -> SimulationInterface:
    return SimulationInterface(
        screen=Screen.HOME,
        transitions={(Screen.EXPEDITION, "mission_start"): Screen.HOME},
    )


def test_expedition_success(expedition_interface: SimulationInterface) -> None:
    ctx = make_context(free_fleet(make_state()), interface=expedition_interface)
    result = ExpeditionTask(fleet_id=2, mission_id=5).execute(ctx)

    assert result.ok is True
    assert expedition_interface.action_targets == [
        Screen.EXPEDITION.value,
        "mission_5",
        "mission_decide",
        "fleet_2",
        "mission_start",
        Screen.HOME.value,
    ]


def test_expedition_rejects_first_fleet() -> None:
    """健全な第1艦隊でも、遠征には出せない。"""
    state = free_fleet(make_state(), 1)
    state.fleets[1].ship_ids = [101]  # 大破艦を外し、安全判定を通す
    result = ExpeditionTask(fleet_id=1, mission_id=5).execute(make_context(state))
    assert result.ok is False
    assert "第1艦隊は遠征に出せません" in result.message


def test_expedition_rejects_fleet_already_out() -> None:
    """フィクスチャの第2艦隊は遠征中。"""
    result = ExpeditionTask(fleet_id=2, mission_id=5).execute(make_context())
    assert result.ok is False
    assert "既に遠征中です" in result.message


def test_expedition_rejects_empty_fleet() -> None:
    state = free_fleet(make_state())
    state.fleets[2].ship_ids = []
    result = ExpeditionTask(fleet_id=2, mission_id=5).execute(make_context(state))
    assert result.ok is False


def test_expedition_stops_when_screen_never_returns_home() -> None:
    """遷移が起きなければ結果確認で失敗し、緊急停止する。"""
    ctx = make_context(free_fleet(make_state()))
    result = ExpeditionTask(fleet_id=2, mission_id=5).execute(ctx)
    assert result.ok is False
    assert ctx.safety.is_stopped is True


# ======================================================================
# 出撃
# ======================================================================


@pytest.fixture
def sortie_interface() -> SimulationInterface:
    return SimulationInterface(
        screen=Screen.HOME,
        transitions={(Screen.SORTIE_SELECT, "sortie_start"): Screen.SORTIE_MAP},
    )


def test_sortie_success(sortie_interface: SimulationInterface) -> None:
    ctx = make_context(free_fleet(make_state()), interface=sortie_interface)
    result = SortieTask(fleet_id=2, map_area=1, map_no=5).execute(ctx)

    assert result.ok is True
    assert sortie_interface.action_targets == [
        Screen.SORTIE_SELECT.value,
        "area_1",
        "map_5",
        "sortie_decide",
        "fleet_2",
        "sortie_start",
        Screen.SORTIE_MAP.value,
    ]


def test_sortie_blocked_by_heavy_damage(sortie_interface: SimulationInterface) -> None:
    """大破艦を含む艦隊では出撃しない。"""
    ctx = make_context(make_state(), interface=sortie_interface)
    result = SortieTask(fleet_id=1, map_area=1, map_no=5).execute(ctx)
    assert result.ok is False
    assert "大破" in result.message
    assert sortie_interface.actions == []


def test_sortie_blocked_while_already_sortieing(
    sortie_interface: SimulationInterface,
) -> None:
    from core.state import Sortie
    from tests.task_helpers import T0

    state = free_fleet(make_state())
    state.sortie = Sortie(map_area=5, map_no=5, started_at=T0)
    result = SortieTask(fleet_id=2, map_area=1, map_no=5).execute(
        make_context(state, interface=sortie_interface)
    )
    assert result.ok is False
    assert "既に出撃中です" in result.message


def test_sortie_blocked_when_fleet_on_expedition(
    sortie_interface: SimulationInterface,
) -> None:
    result = SortieTask(fleet_id=2, map_area=1, map_no=5).execute(
        make_context(interface=sortie_interface)
    )
    assert result.ok is False
    assert "遠征中" in result.message


# ======================================================================
# デイリー
# ======================================================================


def test_daily_requires_tracked_quests() -> None:
    result = DailyTask().execute(make_context())
    assert result.ok is False
    assert "設定されていません" in result.message


def test_daily_reports_remaining() -> None:
    state = make_state()
    state.quests[201] = Quest(quest_id=201, state=QuestState.IN_PROGRESS)
    state.quests[303] = Quest(quest_id=303, state=QuestState.COMPLETE)
    result = DailyTask([201, 303]).execute(make_context(state))

    assert result.ok is True
    assert result.details["remaining"] == [201]
    assert result.details["completed"] == [303]
    assert DailyTask.is_finished(result) is False


def test_daily_reports_all_done() -> None:
    state = make_state()
    state.quests[201] = Quest(quest_id=201, state=QuestState.COMPLETE)
    result = DailyTask([201]).execute(make_context(state))
    assert "消化済み" in result.message
    assert DailyTask.is_finished(result) is True


def test_unknown_quest_is_not_treated_as_done() -> None:
    """把握できていない任務を「達成済み」に倒さない。"""
    result = DailyTask([999]).execute(make_context())
    assert result.details["unknown"] == [999]
    assert DailyTask.is_finished(result) is False


def test_daily_uses_game_day_boundary() -> None:
    """ゲーム日は JST 05:00 区切りで記録される。"""
    state = make_state()
    state.quests[201] = Quest(quest_id=201, state=QuestState.COMPLETE)
    result = DailyTask([201]).execute(make_context(state))
    # T0 = 2024-05-02 12:00 UTC = 21:00 JST → ゲーム日は 5/2
    assert result.details["game_day"] == "2024-05-02"


# ======================================================================
# 建造
# ======================================================================


def test_construction_success() -> None:
    ctx = make_context(add_build_docks(make_state()))
    result = ConstructionTask().execute(ctx)

    assert result.ok is True
    assert result.details["dock_id"] == 1
    assert result.details["recipe"] == {
        "fuel": 30,
        "ammo": 30,
        "steel": 30,
        "bauxite": 30,
    }


def test_construction_requires_free_dock() -> None:
    state = make_state()
    state.build_docks[1] = BuildDock(dock_id=1, state=2)  # 建造中
    result = ConstructionTask().execute(make_context(state))
    assert result.ok is False
    assert "空いている建造ドックがありません" in result.message


def test_construction_requires_dock_information() -> None:
    """ドック情報が無い状態で建造しない。"""
    result = ConstructionTask().execute(make_context(make_state()))
    assert result.ok is False
    assert "建造ドックの情報がありません" in result.message


def test_construction_respects_specified_dock() -> None:
    state = add_build_docks(make_state(), free_count=2)
    result = ConstructionTask(dock_id=2).execute(make_context(state))
    assert result.details["dock_id"] == 2


def test_construction_rejects_busy_specified_dock() -> None:
    state = add_build_docks(make_state(), free_count=1)
    result = ConstructionTask(dock_id=3).execute(make_context(state))
    assert result.ok is False


def test_construction_stops_before_crossing_threshold() -> None:
    """建造したら閾値を割る場合は、実行前に止める。"""
    state = add_build_docks(make_state())
    # 燃料は下限 1000。1020 から 30 使うと 990 になる。
    state.resources = Resources(**{**vars(state.resources), "fuel": 1020})
    result = ConstructionTask().execute(make_context(state))

    assert result.ok is False
    assert "建造すると" in result.message


def test_construction_allows_exactly_at_threshold() -> None:
    state = add_build_docks(make_state())
    state.resources = Resources(**{**vars(state.resources), "fuel": 1030})
    assert ConstructionTask().execute(make_context(state)).ok is True


def test_large_recipe_is_checked_against_all_resources() -> None:
    state = add_build_docks(make_state())
    state.resources = Resources(**{**vars(state.resources), "bauxite": 1100})
    result = ConstructionTask(Recipe(300, 300, 300, 300)).execute(make_context(state))
    assert result.ok is False
    assert "BAUXITE" in result.message


def test_minimum_recipe_values() -> None:
    assert MINIMUM_RECIPE.as_payload() == {
        "fuel": 30,
        "ammo": 30,
        "steel": 30,
        "bauxite": 30,
    }


# ======================================================================
# 解体
# ======================================================================


def test_dismantle_requires_candidates() -> None:
    result = DismantleTask([]).execute(make_context())
    assert result.ok is False
    assert "解体候補が指定されていません" in result.message


def test_dismantle_only_touches_approved_ships() -> None:
    """ロック艦・大破艦を候補に混ぜても、承認されたものだけ操作する。"""
    state = make_state()
    state.fleets[2].ship_ids = []  # #102 を編成から外す
    interface = SimulationInterface(screen=Screen.HOME)
    task = DismantleTask([101, 102, 103])
    result = task.execute(make_context(state, interface=interface))

    assert result.ok is True
    assert task.approved_ids == (102,)
    assert "ship_102" in interface.action_targets
    assert "ship_101" not in interface.action_targets
    assert "ship_103" not in interface.action_targets


def test_dismantle_stops_when_nothing_approved() -> None:
    result = DismantleTask([101]).execute(make_context())
    assert result.ok is False
    assert "承認された艦がありません" in result.message


def test_dismantle_blocked_by_unconfigured_blacklist() -> None:
    """ブラックリスト未設定なら 1 隻も解体しない。"""
    from safety.safety_manager import SafetyManager

    state = make_state()
    state.fleets[2].ship_ids = []
    result = DismantleTask([102]).execute(
        make_context(state, safety=SafetyManager())
    )
    assert result.ok is False


def test_dismantle_blocked_by_pending_drop_protection() -> None:
    from monitor.api_parser import Event, EventType
    from tests.task_helpers import T0

    state = make_state()
    state.fleets[2].ship_ids = []
    safety = make_safety()
    safety.observe(
        [Event(EventType.UNKNOWN_SHIP_DROPPED, {"master_id": 543, "name": "黄平"}, T0)]
    )
    result = DismantleTask([102]).execute(make_context(state, safety=safety))
    assert result.ok is False

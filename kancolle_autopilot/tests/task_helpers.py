"""タスク系テストの共通土台。"""

from __future__ import annotations

from datetime import datetime, timezone

from automation.interface import Screen
from automation.simulation import SimulationInterface
from core.state import BuildDock, FleetMission
from monitor.api_parser import APIParser
from monitor.game_state import GameState
from safety.lock_guard import Blacklist, DismantlePolicy, LockGuard
from safety.safety_manager import SafetyManager
from tasks.base_task import TaskContext
from tests.helpers import load_fixture

#: テストで使う固定時刻（JST では 2024-05-02 21:00、デイリー切替後）。
T0 = datetime(2024, 5, 2, 12, 0, tzinfo=timezone.utc)

#: 判定ロジックそのものを見たいので、空でも使えるブラックリスト。
EMPTY_OK = Blacklist(allow_empty=True, source="test")


def make_state() -> GameState:
    """母港応答を適用した状態を作る。

    第1艦隊 = [101(無傷), 103(大破)]、第2艦隊 = [102(無傷)]。
    第2艦隊は遠征中なので、遠征・出撃のテストでは解除して使う。
    """
    state = GameState(clock=lambda: T0)
    state.apply_all(APIParser().parse_record(load_fixture("port.json"), T0))
    return state


def free_fleet(state: GameState, fleet_id: int = 2) -> GameState:
    """艦隊を遠征から戻す。"""
    state.fleets[fleet_id].mission = FleetMission()
    return state


def add_build_docks(state: GameState, free_count: int = 2) -> GameState:
    """建造ドックを用意する（``state=0`` が空き）。"""
    for dock_id in range(1, 5):
        state.build_docks[dock_id] = BuildDock(
            dock_id=dock_id, state=0 if dock_id <= free_count else -1
        )
    return state


def make_safety() -> SafetyManager:
    """ブラックリストを使える状態にした SafetyManager。"""
    return SafetyManager(
        lock_guard=LockGuard(EMPTY_OK, DismantlePolicy(protect_newest_count=1))
    )


def make_context(
    state: GameState | None = None,
    safety: SafetyManager | None = None,
    interface: SimulationInterface | None = None,
) -> TaskContext:
    """タスク実行用のコンテキストを組み立てる。"""
    return TaskContext(
        game_state=state if state is not None else make_state(),
        safety=safety if safety is not None else make_safety(),
        interface=interface or SimulationInterface(screen=Screen.HOME),
        now=T0,
    )

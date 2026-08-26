"""サンドボックスの初期状態を作る。

テストと CLI の両方から同じ初期状態を使えるようにする。乱数の種を
渡せば戦闘結果まで完全に再現できる。
"""

from __future__ import annotations

import random
from datetime import datetime, timezone
from typing import Callable

from core.state import ResourceKind
from sandbox.battle import BattleModel
from sandbox.game import SHIP_MASTERS, SandboxFleet, SandboxGame, SandboxShip

#: 既定の初期資材。
DEFAULT_RESOURCES = {
    ResourceKind.FUEL: 25000,
    ResourceKind.AMMO: 24000,
    ResourceKind.STEEL: 30000,
    ResourceKind.BAUXITE: 12000,
    ResourceKind.FAST_BUILD: 300,
    ResourceKind.FAST_REPAIR: 120,
    ResourceKind.DEV_MATERIAL: 800,
    ResourceKind.IMPROVE_MATERIAL: 500,
}

#: 初期艦。``(所有ID, 艦種, レベル, ロック)``。
_STARTING_SHIPS = (
    (101, 1002, 80, True),
    (102, 1001, 65, True),
    (103, 1001, 62, True),
    (104, 1003, 70, True),
    (105, 1001, 1, False),
    (106, 1006, 1, False),
)


def new_game(
    seed: int = 0, clock: Callable[[], datetime] | None = None
) -> SandboxGame:
    """遊べる状態のサンドボックスを作る。

    Args:
        seed: 戦闘乱数の種。同じ種なら結果は毎回同じ。
        clock: 現在時刻を返す関数。省略時は固定時刻。

    Returns:
        初期化済みのゲーム。
    """
    fixed = datetime(2024, 5, 2, 12, 0, tzinfo=timezone.utc)
    tick = clock or (lambda: fixed)

    game = SandboxGame(
        resources=dict(DEFAULT_RESOURCES),
        battle=BattleModel(rng=random.Random(seed)),
        clock=tick,
    )

    for instance_id, master_id, level, locked in _STARTING_SHIPS:
        name, max_hp, max_fuel, max_ammo = SHIP_MASTERS[master_id]
        game.ships[instance_id] = SandboxShip(
            instance_id=instance_id,
            master_id=master_id,
            level=level,
            exp=level * 1000,
            hp=max_hp,
            max_hp=max_hp,
            fuel=max_fuel,
            ammo=max_ammo,
            max_fuel=max_fuel,
            max_ammo=max_ammo,
            cond=49,
            locked=locked,
            obtained_at=tick(),
        )
    game._next_ship_id = max(game.ships)

    game.fleets[1] = SandboxFleet(1, "第一艦隊", [101, 102, 103, 104])
    game.fleets[2] = SandboxFleet(2, "第二艦隊", [105, 106])
    game.fleets[3] = SandboxFleet(3, "第三艦隊", [])
    game.fleets[4] = SandboxFleet(4, "第四艦隊", [])

    for dock_id in (1, 2):
        game.build_docks[dock_id] = {"state": 0, "created_ship_id": 0, "complete_at": None}
    for dock_id in (3, 4):
        game.build_docks[dock_id] = {"state": -1, "created_ship_id": 0, "complete_at": None}
    for dock_id in (1, 2):
        game.repair_docks[dock_id] = {"state": 0, "ship_id": 0, "complete_at": None}
    for dock_id in (3, 4):
        game.repair_docks[dock_id] = {"state": -1, "ship_id": 0, "complete_at": None}

    return game

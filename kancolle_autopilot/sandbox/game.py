"""サンドボックスのゲーム状態と、その kcsapi 形式での出力。

追加指示書 §4〜§7 の担当。艦・艦隊・資源・ドック・海域・ゲージ・戦果を
保持し、操作を受けて状態を進める。

**重要なのは、状態変化を kcsapi 形式のレコードとして返すこと。** AI Core
はそのレコードを :mod:`monitor.api_parser` で読むので、相手が
サンドボックスか実ゲームかを知らずに済む（追加指示書 §2）。副次的に、
パーサ自身の検証にもなる。

艦種マスタ ID（:data:`SHIP_MASTERS`）はこのサンドボックス用に作った値で、
実ゲームの ID とは無関係。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Callable, Mapping, Sequence

from core.state import ResourceKind, utcnow
from sandbox.battle import BattleModel, CombatShip

logger = logging.getLogger(__name__)

#: サンドボックス用の艦種マスタ。``master_id -> (名前, 最大HP, 燃料, 弾薬)``。
SHIP_MASTERS: Mapping[int, tuple[str, int, int, int]] = {
    1001: ("試製駆逐", 16, 15, 20),
    1002: ("試製軽巡", 28, 25, 30),
    1003: ("試製重巡", 38, 35, 55),
    1004: ("試製戦艦", 62, 90, 120),
    1005: ("試製空母", 45, 60, 60),
    1006: ("試製潜水", 14, 10, 15),
}

#: 入渠 1 HP あたりの所要秒数と資材。
REPAIR_SECONDS_PER_HP = 60
REPAIR_FUEL_PER_HP = 3
REPAIR_STEEL_PER_HP = 5

#: 建造にかかる時間。
BUILD_DURATION = timedelta(minutes=20)

#: 遠征にかかる時間と報酬。``mission_id -> (所要時間, 報酬)``。
MISSIONS: Mapping[int, tuple[timedelta, Mapping[ResourceKind, int]]] = {
    2: (timedelta(minutes=30), {ResourceKind.FUEL: 100, ResourceKind.AMMO: 30}),
    5: (
        timedelta(hours=1, minutes=30),
        {ResourceKind.FUEL: 240, ResourceKind.STEEL: 200},
    ),
    21: (timedelta(minutes=15), {ResourceKind.BAUXITE: 40}),
}


@dataclass
class SandboxShip:
    """サンドボックス上の艦 1 隻。"""

    instance_id: int
    master_id: int
    level: int = 1
    exp: int = 0
    hp: int = 0
    max_hp: int = 0
    fuel: int = 0
    ammo: int = 0
    max_fuel: int = 0
    max_ammo: int = 0
    cond: int = 40
    locked: bool = False
    obtained_at: datetime | None = None

    @property
    def name(self) -> str:
        """艦名。"""
        return SHIP_MASTERS.get(self.master_id, ("不明", 0, 0, 0))[0]

    @property
    def hp_ratio(self) -> float:
        """残 HP 比率。"""
        return self.hp / self.max_hp if self.max_hp else 0.0

    @property
    def is_heavily_damaged(self) -> bool:
        """大破していれば ``True``。"""
        return self.hp_ratio <= 0.25

    def to_api(self) -> dict[str, Any]:
        """``api_ship`` の 1 要素へ変換する。"""
        return {
            "api_id": self.instance_id,
            "api_ship_id": self.master_id,
            "api_lv": self.level,
            "api_exp": [self.exp, 0, 0],
            "api_nowhp": self.hp,
            "api_maxhp": self.max_hp,
            "api_fuel": self.fuel,
            "api_bull": self.ammo,
            "api_cond": self.cond,
            "api_locked": 1 if self.locked else 0,
            "api_sally_area": 0,
        }


@dataclass
class SandboxFleet:
    """サンドボックス上の艦隊。"""

    fleet_id: int
    name: str = ""
    ship_ids: list[int] = field(default_factory=list)
    mission_state: int = 0
    mission_id: int = 0
    mission_complete_at: datetime | None = None

    def to_api(self) -> dict[str, Any]:
        """``api_deck_port`` の 1 要素へ変換する。"""
        slots = list(self.ship_ids) + [-1] * (6 - len(self.ship_ids))
        complete = (
            int(self.mission_complete_at.timestamp() * 1000)
            if self.mission_complete_at
            else 0
        )
        return {
            "api_id": self.fleet_id,
            "api_name": self.name or f"第{self.fleet_id}艦隊",
            "api_mission": [self.mission_state, self.mission_id, complete, 0],
            "api_ship": slots[:6],
        }


@dataclass
class MapGauge:
    """海域のゲージ。"""

    maximum: int
    current: int

    @property
    def is_broken(self) -> bool:
        """割り切っていれば ``True``。"""
        return self.current <= 0

    def reduce(self) -> bool:
        """1 段階削る。

        Returns:
            この一撃で割り切ったなら ``True``。
        """
        if self.current <= 0:
            return False
        self.current -= 1
        return self.current == 0


@dataclass
class SandboxMap:
    """海域 1 つ。"""

    area: int
    number: int
    cells: int
    boss_cell: int | None
    enemy_strength: float
    drop_pool: Sequence[int] = ()
    gauge: MapGauge | None = None

    @property
    def label(self) -> str:
        """``"5-5"`` 形式の表記。"""
        return f"{self.area}-{self.number}"


def default_maps() -> dict[str, SandboxMap]:
    """追加指示書 §4 が要求する海域を用意する。"""
    return {
        "1-5": SandboxMap(1, 5, cells=5, boss_cell=5, enemy_strength=30.0,
                          drop_pool=(1001, 1006)),
        # 1-6 はボスマスが無く、最終セット到達で完了する。
        "1-6": SandboxMap(1, 6, cells=6, boss_cell=None, enemy_strength=18.0,
                          drop_pool=(1001,)),
        "5-5": SandboxMap(5, 5, cells=15, boss_cell=15, enemy_strength=220.0,
                          drop_pool=(1003, 1004, 1005),
                          gauge=MapGauge(maximum=5, current=5)),
    }


@dataclass
class SortieState:
    """進行中の出撃。"""

    fleet_id: int
    map_key: str
    cell: int = 1

    @property
    def is_active(self) -> bool:
        """常に ``True``（存在すること自体が出撃中を意味する）。"""
        return True


@dataclass
class SandboxGame:
    """サンドボックスのゲーム本体。

    操作系のメソッドは **kcsapi 形式のレコードのリスト** を返す。
    呼び出し側はそれを :meth:`~monitor.api_parser.APIParser.parse_record`
    へ渡せば、実ゲームと同じ経路で状態を組み立てられる。
    """

    ships: dict[int, SandboxShip] = field(default_factory=dict)
    fleets: dict[int, SandboxFleet] = field(default_factory=dict)
    resources: dict[ResourceKind, int] = field(default_factory=dict)
    build_docks: dict[int, dict[str, Any]] = field(default_factory=dict)
    repair_docks: dict[int, dict[str, Any]] = field(default_factory=dict)
    maps: dict[str, SandboxMap] = field(default_factory=default_maps)
    rank_points: int = 0
    #: 直近の戦闘の勝利判定。
    last_battle_rank: str = ""
    sortie: SortieState | None = None
    battle: BattleModel = field(default_factory=BattleModel)
    clock: Callable[[], datetime] = utcnow
    _next_ship_id: int = 100
    #: ゲージを割り切った海域。
    cleared_maps: list[str] = field(default_factory=list)

    # ------------------------------------------------------------------
    # 参照
    # ------------------------------------------------------------------

    def fleet_ships(self, fleet_id: int) -> list[SandboxShip]:
        """艦隊に編成されている艦を返す。"""
        fleet = self.fleets.get(fleet_id)
        if fleet is None:
            return []
        return [self.ships[i] for i in fleet.ship_ids if i in self.ships]

    def resource(self, kind: ResourceKind) -> int:
        """資材の保有量。"""
        return self.resources.get(kind, 0)

    # ------------------------------------------------------------------
    # レコード生成
    # ------------------------------------------------------------------

    def port_record(self) -> dict[str, Any]:
        """母港応答（``api_port/port``）を作る。"""
        return self._record(
            "api_port/port",
            {
                "api_material": [
                    {"api_id": int(kind), "api_value": value}
                    for kind, value in sorted(self.resources.items())
                ],
                "api_basic": {
                    "api_nickname": "サンドボックス提督",
                    "api_level": 99,
                    "api_max_chara": 330,
                    "api_max_slotitem": 1000,
                },
                "api_ship": [ship.to_api() for ship in self.ships.values()],
                "api_deck_port": [fleet.to_api() for fleet in self.fleets.values()],
                "api_ndock": [
                    {
                        "api_id": dock_id,
                        "api_state": dock["state"],
                        "api_ship_id": dock.get("ship_id", 0),
                        "api_complete_time": self._epoch_ms(dock.get("complete_at")),
                    }
                    for dock_id, dock in sorted(self.repair_docks.items())
                ],
            },
        )

    def fleet_ships_record(self, fleet_id: int) -> dict[str, Any]:
        """艦隊の艦の現状（``api_get_member/ship_deck``）を作る。

        戦闘結果（``battleresult``）には HP が含まれない。これを流さないと、
        AI は出撃中の損傷を知らないまま進撃を判断することになる。
        """
        return self._record(
            "api_get_member/ship_deck",
            {
                "api_ship_data": [
                    ship.to_api() for ship in self.fleet_ships(fleet_id)
                ],
                "api_deck_data": [self.fleets[fleet_id].to_api()]
                if fleet_id in self.fleets
                else [],
            },
        )

    def kdock_record(self) -> dict[str, Any]:
        """建造ドック一覧（``api_get_member/kdock``）を作る。"""
        return self._record(
            "api_get_member/kdock",
            [
                {
                    "api_id": dock_id,
                    "api_state": dock["state"],
                    "api_created_ship_id": dock.get("created_ship_id", 0),
                    "api_complete_time": self._epoch_ms(dock.get("complete_at")),
                }
                for dock_id, dock in sorted(self.build_docks.items())
            ],
        )

    # ------------------------------------------------------------------
    # 操作
    # ------------------------------------------------------------------

    def settle(self, now: datetime | None = None) -> list[dict[str, Any]]:
        """こちらが見ていない間に進んだことを反映する。

        時間で決まる変化を、実ゲームと同じ粒度で扱う。

        * **入渠は自動的に完了する。** 時間が来れば艦はドックから出る。
          プレイヤーの操作は要らない。
        * **遠征は帰投済みになるだけ。** 報酬の受け取りは操作が要るので、
          状態を ``RETURNED`` にして止める。
        * **建造も完成済みになるだけ。** 艦の受け取りは操作が要る。

        Args:
            now: 現在時刻。省略時は :attr:`clock`。

        Returns:
            変化があった場合の kcsapi レコード。無ければ空。
        """
        moment = now or self.clock()
        changed = False

        for dock_id, dock in self.repair_docks.items():
            complete_at = dock.get("complete_at")
            if dock["state"] == 1 and complete_at is not None and moment >= complete_at:
                ship = self.ships.get(dock.get("ship_id", 0))
                if ship is not None:
                    ship.hp = ship.max_hp
                dock.update({"state": 0, "ship_id": 0, "complete_at": None})
                logger.info("入渠が完了しました: ドック%s", dock_id)
                changed = True

        for fleet in self.fleets.values():
            if (
                fleet.mission_state == 2
                and fleet.mission_complete_at is not None
                and moment >= fleet.mission_complete_at
            ):
                fleet.mission_state = 3  # 帰投済み（未回収）
                logger.info("遠征が帰投しました: 第%s艦隊", fleet.fleet_id)
                changed = True

        for dock_id, dock in self.build_docks.items():
            complete_at = dock.get("complete_at")
            if dock["state"] == 2 and complete_at is not None and moment >= complete_at:
                dock["state"] = 3  # 完成（受け取り待ち）
                logger.info("建造が完了しました: ドック%s", dock_id)
                changed = True

        if not changed:
            return []
        return [self.port_record(), self.kdock_record()]

    def set_lock(self, ship_id: int, locked: bool = True) -> list[dict[str, Any]]:
        """艦のロックを切り替える。"""
        ship = self.ships.get(ship_id)
        if ship is None:
            logger.warning("存在しない艦のロック操作です: #%s", ship_id)
            return []
        ship.locked = locked
        logger.info("艦 #%s のロックを %s にしました", ship_id, locked)
        return [self.port_record()]

    def start_sortie(self, fleet_id: int, map_key: str) -> list[dict[str, Any]]:
        """出撃を開始する。

        Raises:
            ValueError: 海域が無い、艦隊が空、または既に出撃中の場合。
        """
        if map_key not in self.maps:
            raise ValueError(f"未知の海域です: {map_key}")
        if self.sortie is not None:
            raise ValueError("既に出撃中です")
        if not self.fleet_ships(fleet_id):
            raise ValueError(f"第{fleet_id}艦隊が空です")

        target = self.maps[map_key]
        self.sortie = SortieState(fleet_id=fleet_id, map_key=map_key, cell=1)
        return [
            self._record(
                "api_req_map/start",
                {
                    "api_maparea_id": target.area,
                    "api_mapinfo_no": target.number,
                    "api_no": 1,
                    "api_bosscell_no": target.boss_cell or 0,
                    "api_event_id": 4,
                },
            )
        ]

    def advance(self) -> list[dict[str, Any]]:
        """次のマスへ進む。

        Raises:
            ValueError: 出撃中でない場合。
        """
        if self.sortie is None:
            raise ValueError("出撃中ではありません")
        target = self.maps[self.sortie.map_key]
        self.sortie.cell = min(self.sortie.cell + 1, target.cells)
        return [
            self._record(
                "api_req_map/next",
                {
                    "api_maparea_id": target.area,
                    "api_mapinfo_no": target.number,
                    "api_no": self.sortie.cell,
                    "api_bosscell_no": target.boss_cell or 0,
                    "api_event_id": 4,
                },
            )
        ]

    @property
    def at_boss(self) -> bool:
        """現在のマスがボスマスなら ``True``。"""
        if self.sortie is None:
            return False
        target = self.maps[self.sortie.map_key]
        return target.boss_cell is not None and self.sortie.cell == target.boss_cell

    def fight(self) -> list[dict[str, Any]]:
        """現在のマスで戦闘する。

        Raises:
            ValueError: 出撃中でない場合。
        """
        if self.sortie is None:
            raise ValueError("出撃中ではありません")

        target = self.maps[self.sortie.map_key]
        ships = self.fleet_ships(self.sortie.fleet_id)
        outcome = self.battle.resolve(
            [
                CombatShip(s.instance_id, s.level, s.hp, s.max_hp)
                for s in ships
            ],
            target.enemy_strength,
            self.at_boss,
            target.drop_pool,
        )

        for ship in ships:
            ship.hp = max(0, ship.hp - outcome.damage.get(ship.instance_id, 0))
            ship.cond = max(0, ship.cond - 3)
            ship.exp += 30 if outcome.is_victory else 10
        for kind, amount in outcome.resource_consumption.items():
            self.resources[kind] = max(0, self.resource(kind) - amount)

        self.rank_points += outcome.rank_points
        self.last_battle_rank = outcome.rank

        body: dict[str, Any] = {
            "api_win_rank": outcome.rank,
            "api_get_exp": 100 if outcome.is_victory else 30,
        }
        drop_ship: SandboxShip | None = None
        if outcome.drop_master_id is not None:
            drop_ship = self._create_ship(outcome.drop_master_id)
            body["api_get_ship"] = {
                "api_ship_id": drop_ship.master_id,
                "api_ship_type": "サンドボックス艦",
                "api_ship_name": drop_ship.name,
            }

        if outcome.gauge_broken and target.gauge is not None:
            if target.gauge.reduce():
                self.cleared_maps.append(target.label)
                logger.info("%s のゲージを割りました", target.label)

        return [
            self._record("api_req_sortie/battleresult", body),
            # 損傷を AI から見えるようにする。実ゲームでも戦闘中の応答に
            # 現在 HP が含まれる。
            self.fleet_ships_record(self.sortie.fleet_id),
        ]

    def return_to_port(self) -> list[dict[str, Any]]:
        """母港へ帰投する。"""
        self.sortie = None
        return [self.port_record()]

    def start_expedition(
        self, fleet_id: int, mission_id: int
    ) -> list[dict[str, Any]]:
        """遠征へ出す。

        Raises:
            ValueError: 艦隊が空、既に遠征中、または未知の遠征の場合。
        """
        fleet = self.fleets.get(fleet_id)
        if fleet is None or not fleet.ship_ids:
            raise ValueError(f"第{fleet_id}艦隊が使えません")
        if fleet.mission_state != 0:
            raise ValueError(f"第{fleet_id}艦隊は既に遠征中です")
        if mission_id not in MISSIONS:
            raise ValueError(f"未知の遠征です: {mission_id}")

        duration, _ = MISSIONS[mission_id]
        fleet.mission_state = 2
        fleet.mission_id = mission_id
        fleet.mission_complete_at = self.clock() + duration
        return [self.port_record()]

    def complete_expedition(self, fleet_id: int) -> list[dict[str, Any]]:
        """遠征を帰投させて報酬を受け取る。

        Raises:
            ValueError: その艦隊が遠征に出ていない場合。
        """
        fleet = self.fleets.get(fleet_id)
        if fleet is None or fleet.mission_state == 0:
            raise ValueError(f"第{fleet_id}艦隊は遠征に出ていません")
        if fleet.mission_id not in MISSIONS:
            raise ValueError(f"未知の遠征です: {fleet.mission_id}")

        _, reward = MISSIONS[fleet.mission_id]
        for kind, amount in reward.items():
            self.resources[kind] = self.resource(kind) + amount
        mission_id = fleet.mission_id
        fleet.mission_state = 0
        fleet.mission_id = 0
        fleet.mission_complete_at = None

        return [
            self._record(
                "api_req_mission/result",
                {
                    "api_quest_name": f"遠征{mission_id}",
                    "api_clear_result": 1,
                    "api_get_material": [
                        reward.get(ResourceKind.FUEL, 0),
                        reward.get(ResourceKind.AMMO, 0),
                        reward.get(ResourceKind.STEEL, 0),
                        reward.get(ResourceKind.BAUXITE, 0),
                    ],
                },
            ),
            self.port_record(),
        ]

    def build(
        self, dock_id: int, recipe: Mapping[str, int]
    ) -> list[dict[str, Any]]:
        """建造を開始する。

        Raises:
            ValueError: ドックが空いていない、または資材が足りない場合。
        """
        dock = self.build_docks.get(dock_id)
        if dock is None or dock["state"] != 0:
            raise ValueError(f"ドック{dock_id}は使えません")

        costs = {
            ResourceKind.FUEL: recipe.get("fuel", 0),
            ResourceKind.AMMO: recipe.get("ammo", 0),
            ResourceKind.STEEL: recipe.get("steel", 0),
            ResourceKind.BAUXITE: recipe.get("bauxite", 0),
        }
        for kind, amount in costs.items():
            if self.resource(kind) < amount:
                raise ValueError(f"{kind.name} が足りません")
        for kind, amount in costs.items():
            self.resources[kind] = self.resource(kind) - amount

        # レシピの合計が大きいほど良い艦が出る、という程度の粗いモデル。
        total = sum(costs.values())
        master_ids = sorted(SHIP_MASTERS)
        index = min(total // 120, len(master_ids) - 1)
        dock.update(
            {
                "state": 2,
                "created_ship_id": master_ids[index],
                "complete_at": self.clock() + BUILD_DURATION,
            }
        )

        return [
            self._record(
                "api_req_kousyou/createship",
                {"api_result": 1},
                request={
                    "api_kdock_id": str(dock_id),
                    "api_item1": str(recipe.get("fuel", 0)),
                    "api_item2": str(recipe.get("ammo", 0)),
                    "api_item3": str(recipe.get("steel", 0)),
                    "api_item4": str(recipe.get("bauxite", 0)),
                    "api_item5": "0",
                    "api_large_flag": "0",
                },
            ),
            self.kdock_record(),
            self.port_record(),
        ]

    def receive_ship(self, dock_id: int) -> list[dict[str, Any]]:
        """建造完了した艦を受け取る。

        Raises:
            ValueError: そのドックが完了していない場合。
        """
        dock = self.build_docks.get(dock_id)
        if dock is None or dock["state"] not in (2, 3):
            raise ValueError(f"ドック{dock_id}に受け取れる艦がありません")
        if dock["state"] == 2 and (
            dock.get("complete_at") and self.clock() < dock["complete_at"]
        ):
            raise ValueError(f"ドック{dock_id}はまだ建造中です")

        ship = self._create_ship(dock["created_ship_id"])
        dock.update({"state": 0, "created_ship_id": 0, "complete_at": None})
        return [
            self._record("api_req_kousyou/getship", {"api_ship": ship.to_api()}),
            self.kdock_record(),
            self.port_record(),
        ]

    def destroy_ships(self, ship_ids: Sequence[int]) -> list[dict[str, Any]]:
        """艦を解体する。

        ロックされた艦、編成中の艦は拒否する。サンドボックス側にも
        同じ制約を置いておかないと、AI 側の保護が効いているのか
        たまたま起きなかっただけなのか区別できない。

        Raises:
            ValueError: 保護された艦が含まれている場合。
        """
        assigned = {
            ship_id for fleet in self.fleets.values() for ship_id in fleet.ship_ids
        }
        for ship_id in ship_ids:
            ship = self.ships.get(ship_id)
            if ship is None:
                raise ValueError(f"艦 #{ship_id} がいません")
            if ship.locked:
                raise ValueError(f"艦 #{ship_id} はロックされています")
            if ship_id in assigned:
                raise ValueError(f"艦 #{ship_id} は編成中です")

        gained = {ResourceKind.FUEL: 0, ResourceKind.STEEL: 0}
        for ship_id in ship_ids:
            ship = self.ships.pop(ship_id)
            gained[ResourceKind.FUEL] += ship.max_fuel // 2
            gained[ResourceKind.STEEL] += ship.max_hp

        for kind, amount in gained.items():
            self.resources[kind] = self.resource(kind) + amount

        return [
            self._record(
                "api_req_kousyou/destroyship",
                {
                    "api_material": [
                        self.resource(ResourceKind.FUEL),
                        self.resource(ResourceKind.AMMO),
                        self.resource(ResourceKind.STEEL),
                        self.resource(ResourceKind.BAUXITE),
                    ]
                },
                request={"api_ship_id": ",".join(str(i) for i in ship_ids)},
            ),
            self.port_record(),
        ]

    def supply(self, fleet_id: int) -> list[dict[str, Any]]:
        """艦隊へ補給する。"""
        for ship in self.fleet_ships(fleet_id):
            self.resources[ResourceKind.FUEL] = max(
                0, self.resource(ResourceKind.FUEL) - (ship.max_fuel - ship.fuel)
            )
            self.resources[ResourceKind.AMMO] = max(
                0, self.resource(ResourceKind.AMMO) - (ship.max_ammo - ship.ammo)
            )
            ship.fuel = ship.max_fuel
            ship.ammo = ship.max_ammo
        return [self.port_record()]

    def repair(self, dock_id: int, ship_id: int) -> list[dict[str, Any]]:
        """入渠させる。

        Raises:
            ValueError: ドックが使えない、または艦がいない場合。
        """
        dock = self.repair_docks.get(dock_id)
        if dock is None or dock["state"] != 0:
            raise ValueError(f"入渠ドック{dock_id}は使えません")
        ship = self.ships.get(ship_id)
        if ship is None:
            raise ValueError(f"艦 #{ship_id} がいません")

        missing = ship.max_hp - ship.hp
        self.resources[ResourceKind.FUEL] = max(
            0, self.resource(ResourceKind.FUEL) - missing * REPAIR_FUEL_PER_HP
        )
        self.resources[ResourceKind.STEEL] = max(
            0, self.resource(ResourceKind.STEEL) - missing * REPAIR_STEEL_PER_HP
        )
        dock.update(
            {
                "state": 1,
                "ship_id": ship_id,
                "complete_at": self.clock()
                + timedelta(seconds=missing * REPAIR_SECONDS_PER_HP),
            }
        )
        return [self.port_record()]

    def use_bucket(self, ship_id: int) -> list[dict[str, Any]]:
        """高速修復材で即座に修復する。

        Raises:
            ValueError: 艦がいない、またはバケツが足りない場合。
        """
        ship = self.ships.get(ship_id)
        if ship is None:
            raise ValueError(f"艦 #{ship_id} がいません")
        if self.resource(ResourceKind.FAST_REPAIR) < 1:
            raise ValueError("高速修復材が足りません")
        self.resources[ResourceKind.FAST_REPAIR] = (
            self.resource(ResourceKind.FAST_REPAIR) - 1
        )
        ship.hp = ship.max_hp
        logger.info("バケツで修復しました: #%s", ship_id)
        return [self.port_record()]

    def finish_repair(self, dock_id: int) -> list[dict[str, Any]]:
        """入渠を完了させる。

        Raises:
            ValueError: そのドックが入渠中でない場合。
        """
        dock = self.repair_docks.get(dock_id)
        if dock is None or dock["state"] != 1:
            raise ValueError(f"入渠ドック{dock_id}は空です")
        ship = self.ships.get(dock["ship_id"])
        if ship is not None:
            ship.hp = ship.max_hp
        dock.update({"state": 0, "ship_id": 0, "complete_at": None})
        return [self.port_record()]

    # ------------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------------

    def _create_ship(self, master_id: int) -> SandboxShip:
        """新しい艦を所有に加える。"""
        name, max_hp, max_fuel, max_ammo = SHIP_MASTERS.get(
            master_id, ("不明", 10, 10, 10)
        )
        self._next_ship_id += 1
        ship = SandboxShip(
            instance_id=self._next_ship_id,
            master_id=master_id,
            level=1,
            hp=max_hp,
            max_hp=max_hp,
            fuel=max_fuel,
            ammo=max_ammo,
            max_fuel=max_fuel,
            max_ammo=max_ammo,
            obtained_at=self.clock(),
        )
        self.ships[ship.instance_id] = ship
        logger.info("艦を入手しました: #%s %s", ship.instance_id, name)
        return ship

    def _record(
        self,
        path: str,
        data: Any,
        request: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """kcsapi 形式のログレコードを組み立てる。"""
        record: dict[str, Any] = {
            "path": f"/kcsapi/{path}",
            "time": int(self.clock().timestamp() * 1000),
            "body": {"api_result": 1, "api_data": data},
        }
        if request is not None:
            record["postBody"] = dict(request)
        return record

    @staticmethod
    def _epoch_ms(moment: datetime | None) -> int:
        """時刻をミリ秒エポックへ（``None`` は 0）。"""
        return int(moment.timestamp() * 1000) if moment else 0

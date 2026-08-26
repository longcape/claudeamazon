"""戦闘の抽象モデル。

追加指示書 §5 のとおり、艦これの完全再現ではなく **AI の判断を検証する
のに必要な最小限** から始める。敵の強さと自軍の戦力比で勝敗を決め、
損傷・資材消費・ドロップを返すだけ。後から式を差し替えられるよう、
:class:`BattleModel` の 1 メソッドに閉じてある。

乱数について。ここで使う乱数は **ゲーム側の不確実性（被弾・ドロップ）を
再現するためのもの** で、操作の間隔や座標には一切関わらない。
:class:`random.Random` を種付きで持つので、テストでは完全に再現できる。
"""

from __future__ import annotations

import logging
import random
from dataclasses import dataclass, field
from typing import Mapping, Sequence

from core.state import ResourceKind

logger = logging.getLogger(__name__)

#: 勝利判定に使う戦力比のしきい値（高い順に評価する）。
_RANK_THRESHOLDS: tuple[tuple[float, str], ...] = (
    (2.0, "S"),
    (1.4, "A"),
    (1.0, "B"),
    (0.7, "C"),
    (0.4, "D"),
)

#: 勝利判定ごとの戦果。ボスマスでは :data:`BOSS_RANK_POINT_BONUS` 倍。
RANK_POINTS: Mapping[str, int] = {"S": 5, "A": 3, "B": 2, "C": 1, "D": 0, "E": 0}

#: ボスマスでの戦果倍率。
BOSS_RANK_POINT_BONUS = 3

#: ゲージを削れる最低の勝利判定。
GAUGE_BREAKING_RANKS = frozenset({"S", "A"})

#: 1 戦闘あたりの資材消費（1 隻あたり）。
FUEL_PER_SHIP = 12
AMMO_PER_SHIP = 18


@dataclass(frozen=True)
class CombatShip:
    """戦闘に参加する艦の、戦闘モデルが見る面だけ。"""

    instance_id: int
    level: int
    hp: int
    max_hp: int


@dataclass
class BattleOutcome:
    """1 戦闘の結果。

    Attributes:
        damage: 艦の所有 ID ごとの被弾量。
        resource_consumption: 消費した資材。
        drop_master_id: ドロップした艦種。無ければ ``None``。
        gauge_broken: ボスを撃破してゲージを削れたなら ``True``。
    """

    rank: str
    damage: dict[int, int] = field(default_factory=dict)
    resource_consumption: dict[ResourceKind, int] = field(default_factory=dict)
    drop_master_id: int | None = None
    rank_points: int = 0
    gauge_broken: bool = False

    @property
    def is_victory(self) -> bool:
        """B 判定以上なら ``True``。"""
        return self.rank in ("S", "A", "B")


@dataclass
class BattleModel:
    """戦力比から戦闘結果を決める。

    Args:
        rng: 乱数源。種を固定すれば結果は完全に再現できる。
        drop_rate: 通常マスでのドロップ確率。
        boss_drop_rate: ボスマスでのドロップ確率。
    """

    rng: random.Random = field(default_factory=random.Random)
    drop_rate: float = 0.3
    boss_drop_rate: float = 0.7

    def fleet_power(self, ships: Sequence[CombatShip]) -> float:
        """艦隊の戦力を返す。

        レベルと残 HP 比の積を足し合わせる。大破した艦は戦力として
        ほとんど数えない、という程度の粗さで十分。
        """
        total = 0.0
        for ship in ships:
            ratio = ship.hp / ship.max_hp if ship.max_hp else 0.0
            total += (ship.level + 1) * ratio
        return total

    def resolve(
        self,
        ships: Sequence[CombatShip],
        enemy_strength: float,
        at_boss: bool,
        drop_pool: Sequence[int] = (),
    ) -> BattleOutcome:
        """戦闘を解決する。

        Args:
            ships: 参加する艦。
            enemy_strength: 敵の強さ。
            at_boss: ボスマスなら ``True``。
            drop_pool: ドロップしうる艦種マスタ ID。

        Returns:
            戦闘結果。艦が 1 隻もいなければ E 判定。
        """
        if not ships:
            return BattleOutcome(rank="E")

        power = self.fleet_power(ships)
        strength = max(enemy_strength, 1.0)
        # 戦力比を ±20% ゆらす。実ゲームの命中・回避のばらつきに相当する。
        ratio = (power / strength) * self.rng.uniform(0.8, 1.2)
        rank = self._rank_for(ratio)

        outcome = BattleOutcome(
            rank=rank,
            resource_consumption={
                ResourceKind.FUEL: FUEL_PER_SHIP * len(ships),
                ResourceKind.AMMO: AMMO_PER_SHIP * len(ships),
            },
            rank_points=self._rank_points(rank, at_boss),
            gauge_broken=at_boss and rank in GAUGE_BREAKING_RANKS,
        )
        outcome.damage = self._distribute_damage(ships, ratio)

        if drop_pool:
            chance = self.boss_drop_rate if at_boss else self.drop_rate
            if outcome.is_victory and self.rng.random() < chance:
                outcome.drop_master_id = self.rng.choice(list(drop_pool))

        logger.debug(
            "戦闘結果: rank=%s ratio=%.2f damage=%s", rank, ratio, outcome.damage
        )
        return outcome

    def _rank_for(self, ratio: float) -> str:
        """戦力比から勝利判定を返す。"""
        for threshold, rank in _RANK_THRESHOLDS:
            if ratio >= threshold:
                return rank
        return "E"

    @staticmethod
    def _rank_points(rank: str, at_boss: bool) -> int:
        """戦果を返す。"""
        base = RANK_POINTS.get(rank, 0)
        return base * BOSS_RANK_POINT_BONUS if at_boss else base

    def _distribute_damage(
        self, ships: Sequence[CombatShip], ratio: float
    ) -> dict[int, int]:
        """被弾を艦へ割り振る。

        戦力比が低いほど大きく被弾する。狙われる艦は毎回ランダムに
        選ぶので、同じ編成でも大破する艦は変わる。
        """
        # 圧勝なら被弾も小さい。劣勢なら 1 隻あたり最大 HP 近くまで入る。
        severity = max(0.0, min(1.2, 1.4 / max(ratio, 0.2)))
        damage: dict[int, int] = {}
        for ship in ships:
            if self.rng.random() > min(0.9, severity):
                continue
            amount = int(ship.max_hp * severity * self.rng.uniform(0.15, 0.55))
            if amount > 0:
                damage[ship.instance_id] = min(amount, ship.hp)
        return damage

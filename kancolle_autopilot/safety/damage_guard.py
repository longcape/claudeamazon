"""損傷と疲労を監視する安全装置。

開発指示書 §8 のうち「大破艦を含む危険な出撃」と「状態不明」を担当する。

判定の原則は 2 つ。

* **大破は停止。** 大破艦を含む艦隊は出撃させない。
* **不明も停止。** 艦データが取れていない、HP が分からない、艦隊自体を
  把握できていない場合も停止する。「たぶん無傷だろう」で進めない。

疲労（cond）は停止条件ではなく警告として返す。遠征効率や被弾率には
効くが、これ自体で艦を失うわけではないため、扱いは上位に委ねる。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Mapping

from core.state import DamageState, Ship
from monitor.game_state import GameState
from safety.verdict import SafetyVerdict

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DamagePolicy:
    """損傷・疲労の判定基準。"""

    #: 中破を警告として扱うか。``False`` なら中破は無視する。
    warn_on_medium_damage: bool = True
    #: この cond 未満を疲労とみなす（警告）。
    min_cond: int = 30

    @classmethod
    def from_mapping(cls, values: Mapping[str, object]) -> "DamagePolicy":
        """``config["safety"]`` 相当の辞書から生成する。"""
        known: dict[str, object] = {}
        if "min_cond" in values:
            known["min_cond"] = values["min_cond"]
        return cls(**known)  # type: ignore[arg-type]


class DamageGuard:
    """艦隊の損傷状態を判定する。

    Example:
        >>> guard = DamageGuard()
        >>> guard.check_fleet(state, fleet_id=1).should_stop
        False
    """

    def __init__(self, policy: DamagePolicy | None = None) -> None:
        self._policy = policy or DamagePolicy()

    @property
    def policy(self) -> DamagePolicy:
        """現在の判定基準。"""
        return self._policy

    def check_fleet(self, state: GameState, fleet_id: int) -> SafetyVerdict:
        """出撃前の艦隊を判定する。

        Args:
            state: 現在のゲーム状態。
            fleet_id: 対象の艦隊 ID。

        Returns:
            判定結果。大破・状態不明があれば ``STOP``、
            中破や疲労だけなら ``WARNING``。
        """
        fleet = state.fleets.get(fleet_id)
        if fleet is None:
            return SafetyVerdict.stop(
                [f"第{fleet_id}艦隊の情報がありません"], {"fleet_id": fleet_id}
            )
        if not fleet.ship_ids:
            return SafetyVerdict.stop(
                [f"第{fleet_id}艦隊が空です"], {"fleet_id": fleet_id}
            )

        stops: list[str] = []
        warnings: list[str] = []
        details: dict[str, object] = {"fleet_id": fleet_id}

        unknown = state.unknown_damage_ships(fleet_id)
        if unknown:
            stops.append(
                f"第{fleet_id}艦隊に状態を把握できない艦がいます: {unknown}"
            )
            details["unknown_ship_ids"] = unknown

        heavy: list[int] = []
        medium: list[int] = []
        fatigued: list[int] = []
        for ship in state.fleet_ships(fleet_id):
            if ship is None:
                continue
            if ship.damage_state is DamageState.HEAVY:
                heavy.append(ship.instance_id)
            elif ship.damage_state is DamageState.MEDIUM:
                medium.append(ship.instance_id)
            if self._is_fatigued(ship):
                fatigued.append(ship.instance_id)

        if heavy:
            stops.append(f"大破艦がいます: {heavy}")
            details["heavy_ship_ids"] = heavy
        if medium and self._policy.warn_on_medium_damage:
            warnings.append(f"中破艦がいます: {medium}")
            details["medium_ship_ids"] = medium
        if fatigued:
            warnings.append(
                f"疲労している艦がいます（cond < {self._policy.min_cond}）: {fatigued}"
            )
            details["fatigued_ship_ids"] = fatigued

        if stops:
            logger.warning("損傷判定により停止します: %s", "; ".join(stops))
            return SafetyVerdict.stop(stops + warnings, details)
        if warnings:
            return SafetyVerdict.warn(warnings, details)
        return SafetyVerdict.ok(details)

    def check_all_fleets(self, state: GameState) -> SafetyVerdict:
        """把握しているすべての艦隊を判定して統合する。

        艦隊を 1 つも把握していない場合は ``STOP``（状態不明）。
        """
        if not state.fleets:
            return SafetyVerdict.stop(["艦隊情報がありません"])
        return SafetyVerdict.merge(
            self.check_fleet(state, fleet_id) for fleet_id in sorted(state.fleets)
        )

    def _is_fatigued(self, ship: Ship) -> bool:
        """cond が閾値未満なら ``True``。cond 不明は損傷側で扱うため ``False``。"""
        return ship.cond is not None and ship.cond < self._policy.min_cond

"""タスクが従う制約。

追加指示書 §8 の制約条件を、実行時に読める形にする。payload に載って
届いた値（:mod:`llm.task_planner` が入れる）をここで型にし、各タスクが
参照する。

区別しておきたいのは **出撃と進撃** の違い。

* 大破艦を含む艦隊で **出撃する** ことは、制約に関係なく
  :class:`~safety.damage_guard.DamageGuard` が止める。入渠すれば済む話で、
  わざわざ大破のまま出す理由が無い。
* 出撃中に大破が出たあと **次のマスへ進む** かどうかが、
  ``advance_with_heavy_damage`` の対象。ここは「捨て艦戦法を許可」と
  組み合わせて初めて選べるようにする。

既定は撤退。許可が明示されていない限り進撃しない。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

from core.state import DamageState, Ship

logger = logging.getLogger(__name__)

#: 進撃に関わる禁止事項。
ADVANCE_WITH_HEAVY_DAMAGE = "advance_with_heavy_damage"
#: バケツの使用を禁じる。
USE_BUCKETS = "use_buckets"
#: 解体そのものを禁じる。
DISMANTLE_SHIPS = "dismantle_ships"
#: 大型建造を禁じる。
LARGE_BUILD = "large_build"

#: 資源効率ごとの、安全閾値に対する上乗せ倍率。
#:
#: **1.0 未満は用意しない。** 「節約重視」は厳しくする方向にしか働かない。
#: 安全閾値そのものは :class:`~safety.resource_guard.ResourceGuard` が持つ
#: 絶対の下限で、指示で緩められては困る。
EFFICIENCY_MARGIN: Mapping[str, float] = {
    "low": 1.0,
    "normal": 1.0,
    "high": 1.5,
}

#: これを超える資材合計を「大型建造」とみなす。
LARGE_BUILD_TOTAL = 1000


@dataclass(frozen=True)
class TaskConstraints:
    """1 つのタスクが従う制約。"""

    prohibit: frozenset[str] = frozenset()
    resource_efficiency: str = "normal"
    disposable_ship_strategy: str = "forbidden"

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "TaskConstraints":
        """タスクの payload から読み取る。

        欠けている項目は既定値（もっとも安全な側）にする。
        """
        raw = payload.get("constraints") or ()
        if isinstance(raw, (str, bytes)) or not isinstance(raw, Iterable):
            raw = ()
        efficiency = payload.get("resource_efficiency", "normal")
        if efficiency not in EFFICIENCY_MARGIN:
            logger.warning("未知の資源効率です。normal として扱います: %r", efficiency)
            efficiency = "normal"
        return cls(
            prohibit=frozenset(str(entry) for entry in raw),
            resource_efficiency=efficiency,
            disposable_ship_strategy=str(
                payload.get("disposable_ship_strategy", "forbidden")
            ),
        )

    def forbids(self, action: str) -> bool:
        """その行動が禁止されていれば ``True``。"""
        return action in self.prohibit

    @property
    def disposable_allowed(self) -> bool:
        """捨て艦戦法が許可されていれば ``True``。"""
        return self.disposable_ship_strategy == "allowed"

    @property
    def resource_margin(self) -> float:
        """安全閾値に対する上乗せ倍率。"""
        return EFFICIENCY_MARGIN.get(self.resource_efficiency, 1.0)

    def describe(self) -> str:
        """ログ用の 1 行表記。"""
        parts = [f"効率={self.resource_efficiency}"]
        if self.prohibit:
            parts.append("禁止=" + ",".join(sorted(self.prohibit)))
        if self.disposable_allowed:
            parts.append("捨て艦=許可")
        return " ".join(parts)


#: 何も指定されていない場合の制約。
NO_CONSTRAINTS = TaskConstraints()


@dataclass(frozen=True)
class AdvanceDecision:
    """次のマスへ進むかどうかの判断。

    Attributes:
        sacrificed: 進撃する場合に、失う覚悟がある艦。
    """

    advance: bool
    reason_code: str
    reason: str
    sacrificed: tuple[int, ...] = ()

    def describe(self) -> str:
        """ログ用の 1 行表記。"""
        head = "進撃" if self.advance else "撤退"
        tail = f"（捨て艦: {list(self.sacrificed)}）" if self.sacrificed else ""
        return f"{head}: {self.reason}{tail}"


def decide_advance(
    ships: Sequence[Ship | None], constraints: TaskConstraints = NO_CONSTRAINTS
) -> AdvanceDecision:
    """出撃中の艦隊について、次のマスへ進むかを判断する。

    判断の順序は次のとおり。

    1. 艦の状態が把握できていなければ撤退する。
    2. 大破がいなければ進撃する。
    3. 大破がいる場合、``advance_with_heavy_damage`` が禁止されていれば撤退。
    4. 捨て艦戦法が許可されていれば、その艦を失う前提で進撃する。
    5. どちらでもなければ撤退する（既定）。

    Args:
        ships: 出撃中の艦隊の艦。未取得の位置は ``None``。
        constraints: このタスクに与えられた制約。

    Returns:
        判断結果。
    """
    if not ships:
        return AdvanceDecision(False, "NO_FLEET", "艦隊の情報がありません")

    unknown = [index for index, ship in enumerate(ships) if ship is None]
    if unknown:
        return AdvanceDecision(
            False, "UNKNOWN_STATE", f"状態を把握できない艦がいます（位置 {unknown}）"
        )

    damaged = [
        ship.instance_id
        for ship in ships
        if ship is not None and ship.damage_state is DamageState.UNKNOWN
    ]
    if damaged:
        return AdvanceDecision(
            False, "UNKNOWN_DAMAGE", f"損傷状態が不明な艦がいます: {damaged}"
        )

    heavy = tuple(
        ship.instance_id
        for ship in ships
        if ship is not None and ship.damage_state is DamageState.HEAVY
    )
    if not heavy:
        return AdvanceDecision(True, "NO_HEAVY_DAMAGE", "大破艦なし")

    if constraints.forbids(ADVANCE_WITH_HEAVY_DAMAGE):
        return AdvanceDecision(
            False, "PROHIBITED", f"大破進撃は禁止されています: {list(heavy)}"
        )

    if constraints.disposable_allowed:
        logger.info("捨て艦戦法により進撃します: %s", list(heavy))
        return AdvanceDecision(
            True,
            "DISPOSABLE_ALLOWED",
            f"捨て艦戦法が許可されています: {list(heavy)}",
            sacrificed=heavy,
        )

    return AdvanceDecision(
        False, "HEAVY_DAMAGE", f"大破艦がいます: {list(heavy)}"
    )

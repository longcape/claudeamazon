"""資材の下限を監視する安全装置。

開発指示書 §8 のうち、資材に関する停止条件を担当する。判定は
:class:`SafetyVerdict` を返すだけで、停止処理そのものは Phase 2 の
``SafetyManager`` が行う。

原則として **不明は正常ではない**。資材がまだ一度も取得できて
いない場合、閾値と比較できないため ``STOP`` を返す。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Mapping

from core.state import ResourceKind, Resources
from safety.verdict import SafetyLevel, SafetyVerdict

logger = logging.getLogger(__name__)


#: 監視対象の資材と、対応する設定キー・表示名。
_WATCHED: tuple[tuple[ResourceKind, str, str], ...] = (
    (ResourceKind.FUEL, "min_fuel", "燃料"),
    (ResourceKind.AMMO, "min_ammo", "弾薬"),
    (ResourceKind.STEEL, "min_steel", "鋼材"),
    (ResourceKind.BAUXITE, "min_bauxite", "ボーキサイト"),
    (ResourceKind.FAST_REPAIR, "min_buckets", "高速修復材"),
)


@dataclass(frozen=True)
class ResourceThresholds:
    """資材の下限値。"""

    min_fuel: int = 1000
    min_ammo: int = 1000
    min_steel: int = 1000
    min_bauxite: int = 1000
    min_buckets: int = 20

    @classmethod
    def from_mapping(cls, values: Mapping[str, object]) -> "ResourceThresholds":
        """設定辞書（``config["safety"]`` 相当）から生成する。

        未知のキーは無視し、欠けているキーは既定値を使う。
        """
        known = {
            name: values[name]
            for name in cls.__dataclass_fields__
            if name in values
        }
        return cls(**known)  # type: ignore[arg-type]

    def get(self, config_key: str) -> int:
        """設定キー名で閾値を取得する。"""
        return int(getattr(self, config_key))


class ResourceGuard:
    """資材の下限割れを検出する。

    Example:
        >>> guard = ResourceGuard(ResourceThresholds(min_fuel=1000))
        >>> guard.check(Resources(fuel=900, ammo=5000, steel=5000,
        ...                       bauxite=5000, fast_repair=50)).should_stop
        True
    """

    def __init__(self, thresholds: ResourceThresholds | None = None) -> None:
        self._thresholds = thresholds or ResourceThresholds()

    @property
    def thresholds(self) -> ResourceThresholds:
        """現在の閾値。"""
        return self._thresholds

    def check(self, resources: Resources) -> SafetyVerdict:
        """資材が閾値を満たしているか判定する。

        Args:
            resources: 現在の資材。

        Returns:
            判定結果。1 つでも下限割れ、または値が不明なら
            :attr:`SafetyLevel.STOP`。
        """
        reasons: list[str] = []
        details: dict[str, object] = {}

        for kind, config_key, label in _WATCHED:
            limit = self._thresholds.get(config_key)
            value = resources.get(kind)
            if value is None:
                reasons.append(f"{label}の残量が不明です")
                details[kind.name] = None
                continue
            details[kind.name] = value
            if value < limit:
                reasons.append(f"{label}が下限を下回りました（{value} < {limit}）")

        if reasons:
            logger.warning("資材の安全判定に失敗しました: %s", "; ".join(reasons))
            return SafetyVerdict.stop(reasons, details)
        return SafetyVerdict(SafetyLevel.OK, (), details)

"""ゲーム状態を表すドメインモデル（値オブジェクトとエンティティ）。

このモジュールは「艦これの状態をどう表現するか」だけを定義し、
kcsapi の形式にも GUI にも依存しない。API 依存の変換は
:mod:`monitor.api_parser` が、状態の集約は
:mod:`monitor.game_state` が担当する。

重要な設計方針として、**不明な値は ``None`` で表現する**。
``0`` や ``False`` で埋めると「ロック状態が分からない艦」が
「ロックされていない艦」に化けるため、破棄判定で致命的になる。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import IntEnum
from typing import Iterable, Mapping

# --------------------------------------------------------------------------
# 定数
# --------------------------------------------------------------------------

#: 大破と判定する HP 比率の上限（これ以下なら大破）。
HEAVY_DAMAGE_RATIO = 0.25
#: 中破と判定する HP 比率の上限。
MEDIUM_DAMAGE_RATIO = 0.50
#: 小破と判定する HP 比率の上限。
LIGHT_DAMAGE_RATIO = 0.75
#: この cond 値未満を「疲労」とみなす（オレンジ顔の境界）。
FATIGUE_COND_THRESHOLD = 30


def epoch_ms_to_datetime(value: int | float | None) -> datetime | None:
    """kcsapi のミリ秒エポックを UTC の :class:`datetime` へ変換する。

    Args:
        value: ミリ秒エポック。``0`` や ``None`` は「時刻なし」とみなす。

    Returns:
        変換結果。``value`` が偽値の場合は ``None``。
    """
    if not value:
        return None
    return datetime.fromtimestamp(value / 1000.0, tz=timezone.utc)


def utcnow() -> datetime:
    """現在時刻（UTC, tz-aware）。テストから差し替えやすいよう関数化する。"""
    return datetime.now(tz=timezone.utc)


# --------------------------------------------------------------------------
# 資源
# --------------------------------------------------------------------------


class ResourceKind(IntEnum):
    """kcsapi の ``api_material`` における資材 ID。"""

    FUEL = 1
    AMMO = 2
    STEEL = 3
    BAUXITE = 4
    FAST_BUILD = 5  # 高速建造材（バーナー）
    FAST_REPAIR = 6  # 高速修復材（バケツ）
    DEV_MATERIAL = 7  # 開発資材
    IMPROVE_MATERIAL = 8  # 改修資材


@dataclass(frozen=True)
class Resources:
    """資材の保有量。``None`` は「未取得＝不明」を意味する。"""

    fuel: int | None = None
    ammo: int | None = None
    steel: int | None = None
    bauxite: int | None = None
    fast_build: int | None = None
    fast_repair: int | None = None
    dev_material: int | None = None
    improve_material: int | None = None

    #: :class:`ResourceKind` と属性名の対応。
    _FIELD_BY_KIND = {
        ResourceKind.FUEL: "fuel",
        ResourceKind.AMMO: "ammo",
        ResourceKind.STEEL: "steel",
        ResourceKind.BAUXITE: "bauxite",
        ResourceKind.FAST_BUILD: "fast_build",
        ResourceKind.FAST_REPAIR: "fast_repair",
        ResourceKind.DEV_MATERIAL: "dev_material",
        ResourceKind.IMPROVE_MATERIAL: "improve_material",
    }

    @property
    def buckets(self) -> int | None:
        """高速修復材（バケツ）の別名。"""
        return self.fast_repair

    @property
    def is_complete(self) -> bool:
        """主要 4 資源とバケツがすべて既知なら ``True``。"""
        return all(
            value is not None
            for value in (
                self.fuel,
                self.ammo,
                self.steel,
                self.bauxite,
                self.fast_repair,
            )
        )

    def get(self, kind: ResourceKind) -> int | None:
        """資材 ID を指定して保有量を取得する。"""
        return getattr(self, self._FIELD_BY_KIND[kind])

    def merged_with(self, updates: Mapping[ResourceKind, int]) -> "Resources":
        """一部の資材だけを更新した新しい :class:`Resources` を返す。

        Args:
            updates: 更新する資材 ID と値の対応。

        Returns:
            更新後の新しいインスタンス（自身は変更しない）。
        """
        values = {
            name: getattr(self, name) for name in self._FIELD_BY_KIND.values()
        }
        for kind, value in updates.items():
            values[self._FIELD_BY_KIND[kind]] = value
        return Resources(**values)


# --------------------------------------------------------------------------
# 艦
# --------------------------------------------------------------------------


class DamageState(IntEnum):
    """損傷区分。数値が大きいほど深刻。"""

    UNKNOWN = -1
    NORMAL = 0
    LIGHT = 1  # 小破
    MEDIUM = 2  # 中破
    HEAVY = 3  # 大破

    @property
    def label(self) -> str:
        """日本語表記。"""
        return {
            DamageState.UNKNOWN: "不明",
            DamageState.NORMAL: "無傷",
            DamageState.LIGHT: "小破",
            DamageState.MEDIUM: "中破",
            DamageState.HEAVY: "大破",
        }[self]


@dataclass
class Ship:
    """所有している艦 1 隻。

    Attributes:
        instance_id: ``api_id``。所有艦を一意に指す ID（入手順に増える）。
        master_id: ``api_ship_id``。艦種マスタ ID（図鑑上の艦の種類）。
        locked: ロック状態。``None`` は不明で、保護側に倒して扱う。
    """

    instance_id: int
    master_id: int | None = None
    name: str | None = None
    level: int | None = None
    exp: int | None = None
    hp: int | None = None
    max_hp: int | None = None
    fuel: int | None = None
    ammo: int | None = None
    cond: int | None = None
    locked: bool | None = None
    sally_area: int | None = None
    updated_at: datetime | None = None

    @property
    def hp_ratio(self) -> float | None:
        """残 HP 比率。HP が不明、または最大 HP が 0 以下なら ``None``。"""
        if self.hp is None or not self.max_hp or self.max_hp <= 0:
            return None
        return self.hp / self.max_hp

    @property
    def damage_state(self) -> DamageState:
        """損傷区分。HP が不明なら :attr:`DamageState.UNKNOWN`。"""
        ratio = self.hp_ratio
        if ratio is None:
            return DamageState.UNKNOWN
        if ratio <= HEAVY_DAMAGE_RATIO:
            return DamageState.HEAVY
        if ratio <= MEDIUM_DAMAGE_RATIO:
            return DamageState.MEDIUM
        if ratio <= LIGHT_DAMAGE_RATIO:
            return DamageState.LIGHT
        return DamageState.NORMAL

    @property
    def is_heavily_damaged(self) -> bool:
        """大破していれば ``True``。不明な場合は ``False`` を返すので、
        危険判定には :attr:`damage_state` を直接見ること。"""
        return self.damage_state is DamageState.HEAVY

    @property
    def is_damage_unknown(self) -> bool:
        """損傷状態が判定できないなら ``True``。"""
        return self.damage_state is DamageState.UNKNOWN

    @property
    def is_fatigued(self) -> bool | None:
        """疲労しているか。cond 不明なら ``None``。"""
        if self.cond is None:
            return None
        return self.cond < FATIGUE_COND_THRESHOLD

    @property
    def is_protected(self) -> bool:
        """破棄してはならない艦なら ``True``。

        ロック状態が不明な場合も保護対象として扱う（安全側 fail）。
        """
        return self.locked is not False


# --------------------------------------------------------------------------
# 艦隊・遠征
# --------------------------------------------------------------------------


class FleetMissionState(IntEnum):
    """``api_mission[0]`` の遠征状態。"""

    IDLE = 0  # 未出撃
    PREPARING = 1  # 遠征準備中
    UNDERWAY = 2  # 遠征中
    RETURNED = 3  # 帰投済み（未回収）


@dataclass(frozen=True)
class FleetMission:
    """艦隊に紐づく遠征の状態。"""

    state: FleetMissionState = FleetMissionState.IDLE
    mission_id: int | None = None
    complete_at: datetime | None = None

    @property
    def is_active(self) -> bool:
        """遠征に出ている（準備中含む）なら ``True``。"""
        return self.state in (
            FleetMissionState.PREPARING,
            FleetMissionState.UNDERWAY,
        )


@dataclass
class Fleet:
    """艦隊 1 つ。"""

    fleet_id: int
    name: str | None = None
    ship_ids: list[int] = field(default_factory=list)
    mission: FleetMission = FleetMission()
    updated_at: datetime | None = None

    @property
    def size(self) -> int:
        """編成されている艦数。"""
        return len(self.ship_ids)


# --------------------------------------------------------------------------
# ドック
# --------------------------------------------------------------------------


@dataclass
class RepairDock:
    """入渠ドック 1 つ。"""

    dock_id: int
    state: int | None = None  # -1:未開放 0:空 1:入渠中
    ship_id: int | None = None
    complete_at: datetime | None = None

    @property
    def is_busy(self) -> bool:
        """入渠中なら ``True``。"""
        return self.state == 1


@dataclass
class BuildDock:
    """建造ドック 1 つ。"""

    dock_id: int
    state: int | None = None  # -1:未開放 0:空 2:建造中 3:完了
    created_ship_id: int | None = None
    complete_at: datetime | None = None

    @property
    def is_busy(self) -> bool:
        """建造中なら ``True``。"""
        return self.state == 2

    @property
    def is_complete(self) -> bool:
        """建造完了（受け取り待ち）なら ``True``。"""
        return self.state == 3


# --------------------------------------------------------------------------
# 任務・出撃・ドロップ
# --------------------------------------------------------------------------


class QuestState(IntEnum):
    """``api_state``（任務の状態）。"""

    UNKNOWN = 0
    AVAILABLE = 1  # 未受注
    IN_PROGRESS = 2  # 遂行中
    COMPLETE = 3  # 達成（未報告）


@dataclass
class Quest:
    """任務 1 件。

    Attributes:
        progress_flag: 進捗フラグ。0:未達 1:50%超 2:80%超。
    """

    quest_id: int
    name: str | None = None
    state: QuestState = QuestState.UNKNOWN
    progress_flag: int | None = None
    category: int | None = None
    period_type: int | None = None

    @property
    def is_in_progress(self) -> bool:
        """遂行中なら ``True``。"""
        return self.state is QuestState.IN_PROGRESS


@dataclass
class Sortie:
    """進行中、または直近の出撃。"""

    map_area: int
    map_no: int
    started_at: datetime
    cell_no: int | None = None
    boss_cell_no: int | None = None
    ended_at: datetime | None = None

    @property
    def map_label(self) -> str:
        """``"5-5"`` 形式の海域表記。"""
        return f"{self.map_area}-{self.map_no}"

    @property
    def is_active(self) -> bool:
        """まだ母港へ戻っていなければ ``True``。"""
        return self.ended_at is None

    @property
    def at_boss(self) -> bool | None:
        """現在セルがボスマスなら ``True``。判定不能なら ``None``。"""
        if self.cell_no is None or self.boss_cell_no is None:
            return None
        return self.cell_no == self.boss_cell_no


@dataclass
class DropRecord:
    """戦闘結果で得た艦の記録。

    Attributes:
        master_id: 艦種マスタ ID。``None`` の場合は艦種が特定できていない。
        is_new: 未所持艦だったか。``None`` は判定不能を表し、
            この場合は保護処理へ進まず停止すべき状態にあたる。
    """

    master_id: int | None
    name: str | None = None
    ship_type: str | None = None
    occurred_at: datetime | None = None
    is_new: bool | None = None


@dataclass
class PlayerInfo:
    """提督（プレイヤー）の基本情報。"""

    nickname: str | None = None
    level: int | None = None
    ship_capacity: int | None = None
    slot_capacity: int | None = None

    def remaining_ship_slots(self, owned: int) -> int | None:
        """艦娘保有枠の残り。上限が不明なら ``None``。"""
        if self.ship_capacity is None:
            return None
        return self.ship_capacity - owned


def summarize_damage(ships: Iterable[Ship]) -> dict[DamageState, int]:
    """艦の集合を損傷区分ごとに数える。

    Args:
        ships: 対象の艦。

    Returns:
        損傷区分をキー、隻数を値とする辞書（0 件の区分は含まない）。
    """
    counts: dict[DamageState, int] = {}
    for ship in ships:
        counts[ship.damage_state] = counts.get(ship.damage_state, 0) + 1
    return counts

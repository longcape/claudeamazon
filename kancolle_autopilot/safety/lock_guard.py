"""艦の破棄を止めるための安全装置。

開発指示書 §9 の担当。**このモジュールは解体を実行しない。** 提示された
候補について「触ってよいか」を判定するだけで、承認が出た場合でも実行は
上位（Phase 4 以降の Task）が行う。

§9 の 5 段階のうち、ここが担うのは 2 と 3、および 5 の照合。

1. candidate            … 候補の抽出（呼び出し側）
2. validation           … :meth:`LockGuard.evaluate`
3. safety approval      … :meth:`LockGuard.approve`
4. execute              … 未実装（Phase 4 以降）
5. result verification  … :meth:`LockGuard.verify_result`

判定は「1 つでも不明なら除外」。ロック状態が取れていない、レベルが
分からない、艦種が特定できない、ブラックリストが未設定 —— どれも
「たぶん大丈夫」ではなく除外側に倒す。壊れるのは常に、条件を
甘く見た側なので。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Mapping, Sequence

from monitor.game_state import GameState
from safety.verdict import SafetyVerdict

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Blacklist:
    """破棄してはならない艦種の一覧。

    Attributes:
        master_ids: 保護する艦種マスタ ID。
        names: 表示用の ID → 名前。
        allow_empty: 空のブラックリストを明示的に許可するか。
        source: 読み込み元のパス（診断用）。
    """

    master_ids: frozenset[int] = frozenset()
    names: Mapping[int, str] = field(default_factory=dict)
    allow_empty: bool = False
    source: str = ""

    @property
    def is_configured(self) -> bool:
        """使用してよい状態なら ``True``。

        空のまま運用すると保護が丸ごと効かないため、明示的に
        ``allow_empty`` を立てない限り未設定として扱う。
        """
        return bool(self.master_ids) or self.allow_empty

    def contains(self, master_id: int) -> bool:
        """艦種が保護対象なら ``True``。"""
        return master_id in self.master_ids

    def label(self, master_id: int) -> str:
        """表示用の名前（未登録なら ID 文字列）。"""
        return self.names.get(master_id, str(master_id))


def load_blacklist(path: str | Path) -> Blacklist:
    """``blacklist.json`` を読み込む。

    ファイルが無い・壊れている場合は **未設定の** :class:`Blacklist` を
    返す。例外は投げないが、その場合 :meth:`LockGuard.evaluate` は
    すべての候補を拒否する。

    Args:
        path: JSON ファイルのパス。

    Returns:
        読み込んだブラックリスト。
    """
    file_path = Path(path)
    if not file_path.exists():
        logger.warning("ブラックリストがありません: %s", file_path)
        return Blacklist(source=str(file_path))

    try:
        raw = json.loads(file_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.error("ブラックリストを読めません: %s: %s", file_path, exc)
        return Blacklist(source=str(file_path))

    if not isinstance(raw, Mapping):
        logger.error("ブラックリストの形式が不正です: %s", file_path)
        return Blacklist(source=str(file_path))

    master_ids: set[int] = set()
    names: dict[int, str] = {}
    for entry in raw.get("entries", []):
        if not isinstance(entry, Mapping):
            continue
        master_id = entry.get("master_id")
        if not isinstance(master_id, int) or isinstance(master_id, bool):
            logger.warning("ブラックリストの master_id が不正です: %r", entry)
            continue
        master_ids.add(master_id)
        name = entry.get("name")
        if isinstance(name, str):
            names[master_id] = name

    blacklist = Blacklist(
        master_ids=frozenset(master_ids),
        names=names,
        allow_empty=bool(raw.get("allow_empty", False)),
        source=str(file_path),
    )
    logger.info(
        "ブラックリストを読み込みました: %d 件（%s）",
        len(blacklist.master_ids),
        file_path,
    )
    return blacklist


@dataclass(frozen=True)
class DismantlePolicy:
    """破棄候補として許容する条件。"""

    #: これ以下のレベルのみ候補になりうる。
    max_level: int = 1
    #: 入手が新しい順にこの隻数を保護する。
    protect_newest_count: int = 1

    @classmethod
    def from_mapping(cls, values: Mapping[str, object]) -> "DismantlePolicy":
        """``config["safety"]`` 相当の辞書から生成する。"""
        known: dict[str, object] = {}
        if "max_dismantle_level" in values:
            known["max_level"] = values["max_dismantle_level"]
        if "protect_newest_count" in values:
            known["protect_newest_count"] = values["protect_newest_count"]
        return cls(**known)  # type: ignore[arg-type]


@dataclass(frozen=True)
class DismantleDecision:
    """1 隻分の判定結果。"""

    ship_id: int
    verdict: SafetyVerdict

    @property
    def approved(self) -> bool:
        """破棄してよいなら ``True``。"""
        return not self.verdict.should_stop

    @property
    def reasons(self) -> tuple[str, ...]:
        """拒否理由（承認時は空）。"""
        return self.verdict.reasons


class LockGuard:
    """破棄候補を検証する。

    Example:
        >>> guard = LockGuard(load_blacklist("data/blacklist.json"))
        >>> guard.evaluate(state, ship_id=102).should_stop
        True
    """

    def __init__(
        self,
        blacklist: Blacklist | None = None,
        policy: DismantlePolicy | None = None,
    ) -> None:
        self._blacklist = blacklist or Blacklist()
        self._policy = policy or DismantlePolicy()

    @property
    def blacklist(self) -> Blacklist:
        """使用中のブラックリスト。"""
        return self._blacklist

    @property
    def policy(self) -> DismantlePolicy:
        """使用中の判定基準。"""
        return self._policy

    def protected_newest_ids(self, state: GameState) -> frozenset[int]:
        """入手順で保護される艦の ID を返す。

        所有艦 ID は入手順に増えるため、大きいものから
        :attr:`DismantlePolicy.protect_newest_count` 隻を保護する。
        """
        count = self._policy.protect_newest_count
        if count <= 0 or not state.ships:
            return frozenset()
        newest = sorted(state.ships, reverse=True)[:count]
        return frozenset(newest)

    def evaluate(self, state: GameState, ship_id: int) -> SafetyVerdict:
        """1 隻について破棄してよいかを判定する。

        Args:
            state: 現在のゲーム状態。
            ship_id: 判定する艦の所有 ID。

        Returns:
            ``STOP`` なら破棄してはならない。``OK`` なら条件は満たす
            （実行可否は上位の :class:`~safety.safety_manager.SafetyManager`
            が最終判断する）。
        """
        details: dict[str, object] = {"ship_id": ship_id}

        if not self._blacklist.is_configured:
            return SafetyVerdict.stop(
                [
                    "ブラックリストが未設定です"
                    f"（{self._blacklist.source or '読み込み元不明'}）"
                ],
                details,
            )

        ship = state.ships.get(ship_id)
        if ship is None:
            return SafetyVerdict.stop([f"艦 #{ship_id} の情報がありません"], details)

        reasons: list[str] = []

        # 1) ロック艦は無条件で除外。不明も除外（is_protected が None を含む）。
        if ship.locked is None:
            reasons.append("ロック状態が不明です")
        elif ship.locked:
            reasons.append("ロックされています")

        # 2) レベル条件。
        if ship.level is None:
            reasons.append("レベルが不明です")
        elif ship.level > self._policy.max_level:
            reasons.append(
                f"レベルが条件を超えています（Lv{ship.level} > Lv{self._policy.max_level}）"
            )

        # 3) 艦種とブラックリスト。
        if ship.master_id is None:
            reasons.append("艦種が特定できません")
        elif self._blacklist.contains(ship.master_id):
            reasons.append(
                f"ブラックリストの艦種です（{self._blacklist.label(ship.master_id)}）"
            )

        # 4) 直近に入手した艦を保護。
        if ship_id in self.protected_newest_ids(state):
            reasons.append("直近に入手した艦です")

        # 5) 編成中・入渠中の艦は触らない。
        fleet_id = self._assigned_fleet(state, ship_id)
        if fleet_id is not None:
            reasons.append(f"第{fleet_id}艦隊に編成されています")
        if self._is_in_repair(state, ship_id):
            reasons.append("入渠中です")

        # 6) 直近ドロップの保護が未確定なら、艦の増減を触らせない。
        if state.last_drop is not None and state.last_drop.is_new is not False:
            reasons.append("未確認ドロップの保護が完了していません")

        if reasons:
            logger.info("破棄候補を除外しました: #%s (%s)", ship_id, "; ".join(reasons))
            return SafetyVerdict.stop(reasons, details)

        details["level"] = ship.level
        details["master_id"] = ship.master_id
        return SafetyVerdict.ok(details)

    def approve(
        self, state: GameState, ship_ids: Iterable[int]
    ) -> tuple[list[DismantleDecision], list[DismantleDecision]]:
        """候補をまとめて判定する。

        Args:
            state: 現在のゲーム状態。
            ship_ids: 候補の所有 ID。

        Returns:
            ``(承認, 却下)`` の 2 つのリスト。
        """
        approved: list[DismantleDecision] = []
        rejected: list[DismantleDecision] = []
        for ship_id in ship_ids:
            decision = DismantleDecision(ship_id, self.evaluate(state, ship_id))
            (approved if decision.approved else rejected).append(decision)
        return approved, rejected

    def verify_result(
        self,
        before: GameState,
        after: GameState,
        expected_removed: Sequence[int],
    ) -> SafetyVerdict:
        """破棄後に、消えた艦が想定どおりかを照合する（§9 の 5 段階目）。

        Args:
            before: 実行前の状態スナップショット。
            after: 実行後の状態。
            expected_removed: 消えるはずだった艦の ID。

        Returns:
            想定外の艦が消えていれば ``STOP``。想定した艦が残って
            いる場合も ``STOP``（実行が失敗した可能性がある）。
        """
        removed = set(before.ships) - set(after.ships)
        expected = set(expected_removed)

        reasons: list[str] = []
        unexpected = sorted(removed - expected)
        if unexpected:
            reasons.append(f"想定外の艦が消えました: {unexpected}")
        remaining = sorted(expected - removed)
        if remaining:
            reasons.append(f"破棄したはずの艦が残っています: {remaining}")

        details = {"removed": sorted(removed), "expected": sorted(expected)}
        if reasons:
            logger.error("破棄結果の照合に失敗しました: %s", "; ".join(reasons))
            return SafetyVerdict.stop(reasons, details)
        return SafetyVerdict.ok(details)

    @staticmethod
    def _assigned_fleet(state: GameState, ship_id: int) -> int | None:
        """艦が編成されている艦隊 ID（無ければ ``None``）。"""
        for fleet in state.fleets.values():
            if ship_id in fleet.ship_ids:
                return fleet.fleet_id
        return None

    @staticmethod
    def _is_in_repair(state: GameState, ship_id: int) -> bool:
        """入渠中なら ``True``。"""
        return any(
            dock.ship_id == ship_id and dock.is_busy
            for dock in state.repair_docks.values()
        )

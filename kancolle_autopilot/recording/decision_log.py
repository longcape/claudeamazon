"""AI Decision Log。

追加指示書 §13 の担当。**LLM の内部思考は保存しない。** 残すのは
「どんな状態を見て」「どの制約の下で」「何を選び」「何を期待し」
「実際どうなったか」だけ。

後から読む人間が知りたいのは思考の流れではなく、判断の入力と結果の
食い違いなので。期待と実際がずれた判断だけを取り出せるようにしてある。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Mapping, Sequence

from core.state import utcnow
from monitor.game_state import GameState

logger = logging.getLogger(__name__)


@dataclass
class Decision:
    """1 回の判断の記録。

    Attributes:
        reason_code: 判断の理由を表す短い符号（自由文ではない）。
        input_state_summary: 判断時に見えていた状態の要約。
        expected_result: 期待した結果。
        actual_result: 実際の結果。未確定なら ``None``。
    """

    decision: str
    reason_code: str
    input_state_summary: Mapping[str, Any] = field(default_factory=dict)
    constraints: tuple[str, ...] = ()
    selected_action: str = ""
    expected_result: str = ""
    actual_result: str | None = None
    task_id: str | None = None
    at: datetime = field(default_factory=utcnow)

    @property
    def is_resolved(self) -> bool:
        """結果が判明していれば ``True``。"""
        return self.actual_result is not None

    @property
    def matched_expectation(self) -> bool | None:
        """期待どおりだったか。未確定なら ``None``。"""
        if self.actual_result is None:
            return None
        return self.actual_result == self.expected_result

    def resolve(self, actual_result: str) -> "Decision":
        """実際の結果を書き込む。"""
        self.actual_result = actual_result
        if not self.matched_expectation:
            logger.info(
                "判断と結果がずれました: %s 期待=%s 実際=%s",
                self.decision,
                self.expected_result,
                actual_result,
            )
        return self

    def describe(self) -> str:
        """複数行の表示用テキストにする。"""
        lines = [
            f"decision: {self.decision}",
            f"reason_code: {self.reason_code}",
        ]
        if self.constraints:
            lines.append(f"constraints: {', '.join(self.constraints)}")
        if self.selected_action:
            lines.append(f"selected_action: {self.selected_action}")
        if self.expected_result:
            lines.append(f"expected_result: {self.expected_result}")
        if self.actual_result is not None:
            lines.append(f"actual_result: {self.actual_result}")
        return "\n".join(lines)

    def to_dict(self) -> dict[str, Any]:
        """永続化用の辞書へ変換する。"""
        return {
            "decision": self.decision,
            "reason_code": self.reason_code,
            "input_state_summary": dict(self.input_state_summary),
            "constraints": list(self.constraints),
            "selected_action": self.selected_action,
            "expected_result": self.expected_result,
            "actual_result": self.actual_result,
            "task_id": self.task_id,
            "at": self.at.isoformat(),
        }


def summarize_state(state: GameState) -> dict[str, Any]:
    """判断時の状態を要約する。

    全部を持つとタイムラインが肥大するので、後から「なぜその判断に
    なったか」を追える最小限にする。詳細が要る場合はスナップショットを
    見る。
    """
    resources = state.resources
    return {
        "fuel": resources.fuel,
        "ammo": resources.ammo,
        "steel": resources.steel,
        "bauxite": resources.bauxite,
        "buckets": resources.buckets,
        "ships": len(state.ships),
        "heavy_damage": [ship.instance_id for ship in state.heavily_damaged_ships()],
        "sortie": state.sortie.map_label if state.sortie else None,
        "last_drop": state.last_drop.name if state.last_drop else None,
    }


@dataclass
class DecisionLog:
    """判断の記録の集まり。"""

    decisions: list[Decision] = field(default_factory=list)

    def __len__(self) -> int:
        """記録数。"""
        return len(self.decisions)

    def __iter__(self):
        """先頭から順に返す。"""
        return iter(self.decisions)

    def record(self, decision: Decision) -> Decision:
        """判断を追加する。"""
        self.decisions.append(decision)
        return decision

    def latest(self, task_id: str | None = None) -> Decision | None:
        """直近の判断を返す（タスクを指定すればその中で）。"""
        for decision in reversed(self.decisions):
            if task_id is None or decision.task_id == task_id:
                return decision
        return None

    def mismatched(self) -> list[Decision]:
        """期待と実際がずれた判断を返す。"""
        return [
            decision
            for decision in self.decisions
            if decision.matched_expectation is False
        ]

    def unresolved(self) -> list[Decision]:
        """結果が未確定の判断を返す。"""
        return [decision for decision in self.decisions if not decision.is_resolved]

    def to_list(self) -> list[dict[str, Any]]:
        """永続化用のリストへ変換する。"""
        return [decision.to_dict() for decision in self.decisions]

"""タイムライン・判断・スナップショットをまとめて記録する。

追加指示書 §12・§13・§15・§17・§18 の担当。

スナップショット（§15）は **メモリ上にだけ持つ**。「この判断をした瞬間、
AI は何を知っていたか」を後から確認するのが目的で、そのために
:class:`~monitor.game_state.GameState` を丸ごと複製する。ディスクへは
タイムラインと判断だけを書き出す。状態の完全な復元まで永続化すると、
形式の互換性の面倒がリプレイの価値を上回る。

ステップ実行（§17）とブレークポイント（§18）は、どちらも
「イベントを積んだ直後に止まる」という同じ仕組みで実現する。止まった
ときに何をするかは :attr:`SessionRecorder.on_pause` に委ねる。CLI なら
入力待ち、テストなら記録するだけ。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from automation.interface import ActionKind, ActionResult
from automation.mouse_controller import CursorSample
from core.persistence import write_json_atomic
from core.state import utcnow
from monitor.game_state import GameState
from recording.decision_log import Decision, DecisionLog, summarize_state
from recording.timeline import (
    BreakpointSet,
    EventKind,
    Timeline,
    TimelineEvent,
)

logger = logging.getLogger(__name__)

#: :class:`~automation.interface.ActionKind` とイベント種別の対応。
_ACTION_KINDS: Mapping[ActionKind, EventKind] = {
    ActionKind.CLICK: EventKind.CLICK,
    ActionKind.NAVIGATE: EventKind.SCREEN_CHANGE,
    ActionKind.WAIT: EventKind.WAIT,
}


@dataclass
class SessionRecorder:
    """1 回の稼働の記録。

    Attributes:
        snapshots: タイムライン上の位置 → その時点の状態。
        paused_at: 停止したイベント。
        on_pause: 停止時に呼ばれる関数。``None`` なら止まらずに続ける。
    """

    timeline: Timeline = field(default_factory=Timeline)
    decisions: DecisionLog = field(default_factory=DecisionLog)
    snapshots: dict[int, GameState] = field(default_factory=dict)
    breakpoints: BreakpointSet = field(default_factory=BreakpointSet)
    step_mode: bool = False
    on_pause: Callable[[TimelineEvent], None] | None = None
    clock: Callable[[], datetime] = utcnow
    paused_at: list[TimelineEvent] = field(default_factory=list)

    # ------------------------------------------------------------------
    # 記録
    # ------------------------------------------------------------------

    def record(
        self,
        kind: EventKind,
        label: str = "",
        task_id: str | None = None,
        screen: str | None = None,
        detail: Mapping[str, Any] | None = None,
    ) -> TimelineEvent:
        """イベントを 1 件記録する。

        記録した直後に、ブレークポイントとステップ実行の判定を行う。
        """
        event = TimelineEvent(
            kind=kind,
            label=label,
            at=self.clock(),
            task_id=task_id,
            screen=screen,
            detail=dict(detail or {}),
        )
        self.timeline.append(event)
        self._maybe_pause(event)
        return event

    def record_action(
        self, result: ActionResult, task_id: str | None = None
    ) -> TimelineEvent:
        """操作の結果を記録する。"""
        kind = _ACTION_KINDS.get(result.action.kind, EventKind.CLICK)
        return self.record(
            kind,
            result.action.target,
            task_id=task_id,
            screen=result.screen.value,
            detail={"ok": result.ok, "message": result.message},
        )

    def record_actions(
        self, results: Sequence[ActionResult], task_id: str | None = None
    ) -> None:
        """操作の結果をまとめて記録する。"""
        for result in results:
            self.record_action(result, task_id)

    def record_cursor(
        self, samples: Sequence[CursorSample], task_id: str | None = None
    ) -> None:
        """カーソル軌跡を記録する（追加指示書 §10）。

        点が多いので、``MOVE`` は間引かず全部残す代わりに、
        :meth:`Timeline.of_kind` で除外して読めるようにしてある。
        """
        for sample in samples:
            self.record(
                EventKind.MOVE if sample.event == "MOVE" else EventKind.CLICK,
                f"({sample.point.x}, {sample.point.y})",
                task_id=task_id,
                detail={"x": sample.point.x, "y": sample.point.y},
            )

    def record_decision(self, decision: Decision) -> Decision:
        """判断を記録し、タイムラインにも 1 行残す。"""
        self.decisions.record(decision)
        self.record(
            EventKind.DECISION,
            decision.decision,
            task_id=decision.task_id,
            detail={
                "reason_code": decision.reason_code,
                "expected_result": decision.expected_result,
            },
        )
        return decision

    def decide(
        self,
        state: GameState,
        decision: str,
        reason_code: str,
        selected_action: str = "",
        expected_result: str = "",
        constraints: Sequence[str] = (),
        task_id: str | None = None,
    ) -> Decision:
        """状態の要約を添えて判断を記録する。"""
        return self.record_decision(
            Decision(
                decision=decision,
                reason_code=reason_code,
                input_state_summary=summarize_state(state),
                constraints=tuple(constraints),
                selected_action=selected_action,
                expected_result=expected_result,
                task_id=task_id,
                at=self.clock(),
            )
        )

    def snapshot(self, state: GameState, label: str = "") -> int:
        """状態のスナップショットを取る（§15）。

        Returns:
            対応するタイムライン上の位置。
        """
        event = self.record(EventKind.SNAPSHOT, label)
        index = len(self.timeline) - 1
        self.snapshots[index] = state.snapshot()
        logger.debug("スナップショットを取りました: #%d %s", index, label)
        return index

    def screen_changed(
        self, before: str, after: str, task_id: str | None = None
    ) -> TimelineEvent | None:
        """画面が変わったことを記録する（変化が無ければ何もしない）。"""
        if before == after:
            return None
        return self.record(
            EventKind.SCREEN_CHANGE,
            after,
            task_id=task_id,
            screen=after,
            detail={"from": before},
        )

    # ------------------------------------------------------------------
    # 参照
    # ------------------------------------------------------------------

    def snapshot_at(self, index: int) -> GameState | None:
        """その位置以前で最も近いスナップショットを返す。

        「この時点で AI は何を知っていたか」を引くための入口。
        """
        candidates = [key for key in self.snapshots if key <= index]
        if not candidates:
            return None
        return self.snapshots[max(candidates)]

    def summary(self) -> dict[str, Any]:
        """記録の要約。"""
        return {
            "events": len(self.timeline),
            "decisions": len(self.decisions),
            "mismatched_decisions": len(self.decisions.mismatched()),
            "snapshots": len(self.snapshots),
            "paused": len(self.paused_at),
            "breakpoints": self.breakpoints.names(),
        }

    # ------------------------------------------------------------------
    # 永続化
    # ------------------------------------------------------------------

    def save(self, directory: str | Path) -> dict[str, Path]:
        """タイムラインと判断を書き出す。

        スナップショットは書き出さない（メモリ上のみ）。

        Args:
            directory: 出力先ディレクトリ。

        Returns:
            書き出したファイルのパス。
        """
        target = Path(directory)
        timeline_path = target / "timeline.jsonl"
        decisions_path = target / "decisions.json"

        self.timeline.save(timeline_path)
        write_json_atomic(decisions_path, self.decisions.to_list())
        logger.info(
            "記録を保存しました: %s（イベント %d 件 / 判断 %d 件）",
            target,
            len(self.timeline),
            len(self.decisions),
        )
        return {"timeline": timeline_path, "decisions": decisions_path}

    # ------------------------------------------------------------------
    # 停止
    # ------------------------------------------------------------------

    def _maybe_pause(self, event: TimelineEvent) -> None:
        """ブレークポイントとステップ実行を判定する。"""
        if not (self.step_mode or self.breakpoints.matches(event)):
            return
        self.paused_at.append(event)
        reason = "ステップ実行" if self.step_mode else "ブレークポイント"
        logger.info("%s で停止: %s", reason, event.describe())
        if self.on_pause is not None:
            self.on_pause(event)

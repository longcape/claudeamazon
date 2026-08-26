"""デイリー任務の進捗を確認するタスク。

開発指示書 §16 の「状態確認 → 未達成タスク確認 → 実行可能条件確認」
までを担当する。ここでは **何が終わっていないかを出すだけ** で、
実際の消化（建造・遠征・出撃）は個別のタスクが行う。

追跡する任務 ID は呼び出し側が渡す。kcsapi の ``api_type``
（任務の周期区分）の数値がデイリー／ウィークリーのどれに対応するかは
環境依存の推測になるため、コードに埋め込まない。取り違えると
「終わっていない任務を終わったことにする」向きの誤りが起きうる。
"""

from __future__ import annotations

import logging
from typing import ClassVar, Sequence

from automation.interface import Screen
from core.gametime import format_game_day
from core.state import QuestState
from core.task_queue import TaskPriority
from safety.verdict import SafetyVerdict
from tasks.base_task import BaseTask, TaskContext, TaskResult

logger = logging.getLogger(__name__)


class DailyTask(BaseTask):
    """追跡対象のデイリー任務のうち、未達成のものを洗い出す。

    Args:
        quest_ids: 追跡するデイリー任務の ID。空なら何も判定しない。
    """

    name: ClassVar[str] = "daily"
    priority: ClassVar[TaskPriority] = TaskPriority.DAILY_TASK

    def __init__(self, quest_ids: Sequence[int] = ()) -> None:
        self.quest_ids = tuple(quest_ids)

    def preconditions(self, ctx: TaskContext) -> SafetyVerdict:
        """追跡対象が設定されているかを見る。"""
        if not self.quest_ids:
            return SafetyVerdict.stop(
                ["追跡するデイリー任務が設定されていません"],
            )
        return SafetyVerdict.ok({"tracked": len(self.quest_ids)})

    def perform(self, ctx: TaskContext) -> TaskResult:
        """任務画面を開いて進捗を読む。"""
        interface = ctx.interface
        self.step(ctx, interface.navigate(Screen.QUEST))
        self.step(ctx, interface.click("tab_daily", Screen.QUEST, "デイリータブ"))
        self.step(ctx, interface.wait_for_state(Screen.QUEST))

        quests = ctx.game_state.quests
        completed: list[int] = []
        remaining: list[int] = []
        unknown: list[int] = []

        for quest_id in self.quest_ids:
            quest = quests.get(quest_id)
            if quest is None or quest.state is QuestState.UNKNOWN:
                # 把握できていない任務を「達成済み」に倒さない。
                unknown.append(quest_id)
            elif quest.state is QuestState.COMPLETE:
                completed.append(quest_id)
            else:
                remaining.append(quest_id)

        game_day = format_game_day(ctx.now)
        details = {
            "game_day": game_day,
            "completed": completed,
            "remaining": remaining,
            "unknown": unknown,
        }

        if unknown:
            # 状態が読めない任務があるうちは「全部終わった」と言えない。
            return TaskResult.succeeded(
                f"{game_day} のデイリー: 未達成 {len(remaining)} 件 /"
                f" 状態不明 {len(unknown)} 件",
                details,
            )
        if remaining:
            return TaskResult.succeeded(
                f"{game_day} のデイリー: 未達成 {len(remaining)} 件", details
            )
        return TaskResult.succeeded(f"{game_day} のデイリーは消化済みです", details)

    @staticmethod
    def is_finished(result: TaskResult) -> bool:
        """結果を見て「今日の分は終わっている」と言えるなら ``True``。

        状態不明の任務が 1 件でもあれば ``False``。
        """
        if not result.ok:
            return False
        return not result.details.get("remaining") and not result.details.get("unknown")

"""外部から受け取る管理コマンド。

開発指示書 §17 の担当。``status`` / ``stop`` / ``resume`` / ``queue`` /
``cancel <task_id>`` を受け付ける。

**自然言語をそのまま実行しない。** 知っている語彙以外は
:class:`CommandError` にする。自然言語からタスクを組み立てる経路は
Phase 7 の parser が担い、そこでも構造化 → 検証 → SafetyManager →
TaskQueue の順を通す。ここで「それらしい文字列」を解釈し始めると、
その順序が崩れる。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Sequence

from core.state_machine import StateMachine
from core.task_queue import TaskQueue
from monitor.game_state import GameState
from safety.safety_manager import SafetyManager

logger = logging.getLogger(__name__)


class CommandName(str, Enum):
    """受け付ける管理コマンド。"""

    STATUS = "status"
    STOP = "stop"
    RESUME = "resume"
    QUEUE = "queue"
    CANCEL = "cancel"

    @property
    def needs_argument(self) -> bool:
        """引数が必須なら ``True``。"""
        return self is CommandName.CANCEL


@dataclass(frozen=True)
class Command:
    """解釈済みのコマンド。"""

    name: CommandName
    argument: str = ""


class CommandError(Exception):
    """コマンドとして解釈できなかった。"""


def parse_command(text: str) -> Command:
    """1 行の入力をコマンドへ変換する。

    Args:
        text: 受け取った文字列。

    Returns:
        解釈したコマンド。

    Raises:
        CommandError: 空、未知の語彙、または引数が足りない場合。
    """
    stripped = text.strip()
    if not stripped:
        raise CommandError("コマンドが空です")

    parts = stripped.split()
    verb = parts[0].lower().lstrip("!/")
    try:
        name = CommandName(verb)
    except ValueError as exc:
        raise CommandError(
            f"未知のコマンドです: {parts[0]}"
            f"（使えるのは {', '.join(c.value for c in CommandName)}）。"
            "自然言語の指示はここでは実行しません。"
        ) from exc

    argument = " ".join(parts[1:]).strip()
    if name.needs_argument and not argument:
        raise CommandError(f"{name.value} には引数が必要です")
    return Command(name, argument)


@dataclass
class CommandHandler:
    """コマンドを実行して、返す文面を組み立てる。

    Attributes:
        state_machine: 状態を表示するため。``None`` でも動く。
    """

    safety: SafetyManager
    queue: TaskQueue
    game_state: GameState
    state_machine: StateMachine | None = None

    def handle_text(self, text: str) -> str:
        """文字列を受け取って実行する。

        Raises:
            CommandError: 解釈できなかった場合。
        """
        return self.handle(parse_command(text))

    def handle(self, command: Command) -> str:
        """コマンドを実行する。"""
        handlers = {
            CommandName.STATUS: self._status,
            CommandName.STOP: self._stop,
            CommandName.RESUME: self._resume,
            CommandName.QUEUE: self._queue,
            CommandName.CANCEL: self._cancel,
        }
        logger.info("コマンドを受け付けました: %s %s", command.name.value, command.argument)
        return handlers[command.name](command)

    # ------------------------------------------------------------------
    # 各コマンド
    # ------------------------------------------------------------------

    def _status(self, command: Command) -> str:
        """現在の様子を返す。"""
        resources = self.game_state.resources
        verdict = self.safety.evaluate(self.game_state)
        lines = [
            f"安全判定: {verdict.level.name}",
            f"資材: 燃{resources.fuel} 弾{resources.ammo} "
            f"鋼{resources.steel} ボ{resources.bauxite} バケツ{resources.buckets}",
            f"所有艦: {len(self.game_state.ships)}",
            f"待機タスク: {len(self.queue)}",
        ]
        if self.state_machine is not None:
            lines.append(f"状態: {self.state_machine.state.value}")
        if self.safety.is_stopped:
            lines.append("緊急停止中:")
            lines.extend(f"  ・{reason}" for reason in self.safety.latched_reasons)
        for pending in self.safety.pending_protections:
            lines.append(f"保護待ち: {pending.name or pending.master_id}")
        for reason in verdict.reasons:
            lines.append(f"  ・{reason}")
        return "\n".join(lines)

    def _stop(self, command: Command) -> str:
        """緊急停止をかける。"""
        reason = command.argument or "外部からの停止要求"
        self.safety.trigger_emergency_stop(reason)
        cancelled = self.queue.cancel_all(reason)
        return f"緊急停止しました（{reason}）。待機タスク {cancelled} 件を取り消しました。"

    def _resume(self, command: Command) -> str:
        """緊急停止を解除する。

        **保護待ちは解除しない。** 未所持艦のロックが確認できていない
        状態で再開すると、保護のために止めた意味が無くなる。ロックの
        確認は状態から判定するので、人の一声では消さない。
        """
        if not self.safety.is_stopped:
            return "緊急停止はかかっていません。"

        cleared = list(self.safety.latched_reasons)
        self.safety.clear_emergency_stop()
        message = f"緊急停止を解除しました（{len(cleared)} 件）。"
        if self.safety.pending_protections:
            names = [
                pending.name or str(pending.master_id)
                for pending in self.safety.pending_protections
            ]
            message += (
                f" ただし保護待ちが残っています: {', '.join(names)}。"
                "ロックが確認できるまで実行は止まったままです。"
            )
        return message

    def _queue(self, command: Command) -> str:
        """待機中のタスクを並べる。"""
        pending = self.queue.pending()
        if not pending:
            return "待機中のタスクはありません。"
        lines = [f"待機タスク {len(pending)} 件:"]
        lines.extend(f"  {task.describe()}" for task in pending)
        return "\n".join(lines)

    def _cancel(self, command: Command) -> str:
        """タスクを取り消す。"""
        if self.queue.cancel(command.argument, "外部からの取り消し"):
            return f"取り消しました: {command.argument}"
        return f"該当する待機タスクがありません: {command.argument}"


def available_commands() -> Sequence[str]:
    """使えるコマンドの一覧（ヘルプ用）。"""
    return [
        "status — 現在の資材・安全判定・待機タスクを表示",
        "stop [理由] — 緊急停止し、待機タスクを取り消す",
        "resume — 緊急停止を解除する（保護待ちは解除しない）",
        "queue — 待機中のタスクを表示",
        "cancel <task_id> — 指定したタスクを取り消す",
    ]

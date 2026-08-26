"""Discord から管理コマンドを受ける部分のテスト。

``discord`` パッケージも通信も使わず、:class:`LoopbackGateway` で確かめる。
"""

from __future__ import annotations

import pytest

from core.orchestrator import Orchestrator
from core.scheduler import Scheduler
from core.task_queue import Task, TaskPriority, TaskQueue
from notify.bot import (
    REFUSAL_NO_ALLOWLIST,
    REFUSAL_UNKNOWN_USER,
    CommandBot,
    CommandChannel,
    LoopbackGateway,
)
from sandbox.session import SandboxSession

ALLOWED = "111"
STRANGER = "999"


@pytest.fixture
def gateway() -> LoopbackGateway:
    return LoopbackGateway()


@pytest.fixture
def bot(gateway: LoopbackGateway) -> CommandBot:
    bot = CommandBot(gateway=gateway, allowed_user_ids=frozenset({ALLOWED}))
    bot.start()
    return bot


# ======================================================================
# 受け渡し
# ======================================================================


def test_channel_queues_and_drains() -> None:
    channel = CommandChannel()
    channel.submit("status")
    channel.submit("  ")  # 空白は捨てる
    channel.submit("queue")
    assert channel.drain() == ["status", "queue"]
    assert channel.drain() == []


def test_channel_reply_without_sink_does_not_fail() -> None:
    CommandChannel().reply("応答")


def test_channel_reply_survives_a_failing_sink() -> None:
    """返答が送れなくても稼働は止めない。"""

    def explode(text: str) -> None:
        raise RuntimeError("送信失敗")

    channel = CommandChannel()
    channel.bind_reply(explode)
    channel.reply("応答")  # 例外が外へ出ない


# ======================================================================
# 許可
# ======================================================================


def test_allowed_user_command_is_queued(
    bot: CommandBot, gateway: LoopbackGateway
) -> None:
    gateway.deliver(ALLOWED, "status")
    assert list(bot.drain()) == ["status"]
    assert bot.rejected == []


def test_stranger_is_refused(bot: CommandBot, gateway: LoopbackGateway) -> None:
    """許可していない相手のコマンドは実行しない。"""
    gateway.deliver(STRANGER, "stop")
    assert list(bot.drain()) == []
    assert bot.rejected == [(STRANGER, "stop")]
    assert gateway.sent == [REFUSAL_UNKNOWN_USER]


def test_empty_allowlist_refuses_everyone(gateway: LoopbackGateway) -> None:
    """設定漏れで誰でも止められる状態を作らない。"""
    bot = CommandBot(gateway=gateway)
    bot.start()
    assert bot.has_allowlist is False

    gateway.deliver(ALLOWED, "stop")
    assert list(bot.drain()) == []
    assert gateway.sent == [REFUSAL_NO_ALLOWLIST]


def test_from_config_reads_the_allowlist() -> None:
    gateway = LoopbackGateway()
    bot = CommandBot.from_config(
        {"bot_token": "t", "channel_id": "1", "allowed_user_ids": ["111", "222"]},
        gateway=gateway,
    )
    assert bot.allowed_user_ids == frozenset({"111", "222"})


def test_from_config_requires_token_and_channel() -> None:
    with pytest.raises(ValueError, match="bot_token"):
        CommandBot.from_config({"allowed_user_ids": ["111"]})


def test_replies_go_back_to_the_gateway(
    bot: CommandBot, gateway: LoopbackGateway
) -> None:
    bot.channel.reply("了解")
    assert "了解" in gateway.sent


# ======================================================================
# 常駐ループとの接続
# ======================================================================


@pytest.fixture
def session() -> SandboxSession:
    session = SandboxSession.create(seed=7)
    session.bootstrap()
    return session


def wire(session: SandboxSession, bot: CommandBot) -> Orchestrator:
    orchestrator = Orchestrator(
        source=session,
        game_state=session.game_state,
        safety=session.safety,
        queue=TaskQueue(),
        scheduler=Scheduler(),
        execute=session.run_and_resolve,
    )
    orchestrator.command_source = bot.drain
    orchestrator.command_sink = bot.channel.reply
    return orchestrator


def test_status_round_trip(
    session: SandboxSession, bot: CommandBot, gateway: LoopbackGateway
) -> None:
    orchestrator = wire(session, bot)
    gateway.deliver(ALLOWED, "status")
    orchestrator.handle_commands()

    assert any("資材:" in message for message in gateway.sent)


def test_stop_from_discord_halts_the_loop(
    session: SandboxSession, bot: CommandBot, gateway: LoopbackGateway
) -> None:
    orchestrator = wire(session, bot)
    orchestrator.queue.push(
        Task("sortie", TaskPriority.SORTIE, {"map": "1-5", "fleet_id": 1})
    )

    gateway.deliver(ALLOWED, "stop 点検")
    orchestrator.handle_commands()
    report = orchestrator.tick()

    assert orchestrator.safety.is_stopped is True
    assert report.executed is None
    assert any("緊急停止しました" in message for message in gateway.sent)


def test_resume_from_discord(
    session: SandboxSession, bot: CommandBot, gateway: LoopbackGateway
) -> None:
    orchestrator = wire(session, bot)
    gateway.deliver(ALLOWED, "stop")
    orchestrator.handle_commands()
    gateway.deliver(ALLOWED, "resume")
    orchestrator.handle_commands()

    assert orchestrator.safety.is_stopped is False


def test_natural_language_is_refused_over_discord(
    session: SandboxSession, bot: CommandBot, gateway: LoopbackGateway
) -> None:
    """入口が変わっても、自然言語をそのまま実行しない。"""
    orchestrator = wire(session, bot)
    gateway.deliver(ALLOWED, "1-5を10周しておいて")
    orchestrator.handle_commands()

    assert any(
        "自然言語の指示はここでは実行しません" in message for message in gateway.sent
    )
    assert orchestrator.queue.is_empty is True


def test_stranger_cannot_reach_the_loop(
    session: SandboxSession, bot: CommandBot, gateway: LoopbackGateway
) -> None:
    orchestrator = wire(session, bot)
    gateway.deliver(STRANGER, "stop")
    orchestrator.handle_commands()
    assert orchestrator.safety.is_stopped is False


def test_failing_sink_does_not_break_the_loop(session: SandboxSession) -> None:
    orchestrator = Orchestrator(
        source=session,
        game_state=session.game_state,
        safety=session.safety,
        queue=TaskQueue(),
        scheduler=Scheduler(),
        execute=session.run_and_resolve,
    )
    orchestrator.command_source = lambda: ["status"]

    def explode(text: str) -> None:
        raise RuntimeError("送信失敗")

    orchestrator.command_sink = explode
    assert len(orchestrator.handle_commands()) == 1

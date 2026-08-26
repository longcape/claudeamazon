"""NotificationDispatcher / CommandHandler のテスト。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from core.state import Resources
from core.state_machine import StateMachine, SystemState
from core.task_queue import Task, TaskPriority, TaskQueue
from monitor.api_parser import APIParser, Event, EventType
from monitor.game_state import GameState
from notify.commands import (
    Command,
    CommandError,
    CommandHandler,
    CommandName,
    available_commands,
    parse_command,
)
from notify.dispatcher import NotificationDispatcher
from notify.message import NotificationKind, NotificationLevel
from notify.notifier import RecordingNotifier
from safety.lock_guard import Blacklist, DismantlePolicy, LockGuard
from safety.safety_manager import SafetyManager
from safety.verdict import SafetyVerdict
from tests.helpers import load_fixture

T0 = datetime(2024, 5, 2, 10, 52, tzinfo=timezone.utc)


@pytest.fixture
def notifier() -> RecordingNotifier:
    return RecordingNotifier()


@pytest.fixture
def clock():
    """呼ばれるたびに 1 秒進む時計。"""
    counter = iter(range(0, 10_000))
    return lambda: T0 + timedelta(seconds=next(counter))


@pytest.fixture
def dispatcher(notifier: RecordingNotifier, clock) -> NotificationDispatcher:
    return NotificationDispatcher(notifier, clock=clock)


@pytest.fixture
def state() -> GameState:
    state = GameState(clock=lambda: T0)
    state.apply_all(APIParser().parse_record(load_fixture("port.json"), T0))
    return state


# ======================================================================
# 通知の振り分け
# ======================================================================


def test_safety_stop_notification(
    dispatcher: NotificationDispatcher, notifier: RecordingNotifier
) -> None:
    dispatcher.safety_stop(SafetyVerdict.stop(["大破艦がいます: [103]"]))
    assert notifier.kinds() == ["SAFETY STOP"]
    assert "大破艦" in notifier.sent[0].body


def test_resource_low_notification(
    dispatcher: NotificationDispatcher,
    notifier: RecordingNotifier,
    state: GameState,
) -> None:
    dispatcher.resource_low(state.resources, {"min_fuel": 1000})
    assert notifier.sent[0].fields["燃料"] == "25000"


def test_damage_notification(
    dispatcher: NotificationDispatcher, notifier: RecordingNotifier
) -> None:
    dispatcher.damage_detected([103, 101])
    assert "2 隻" in notifier.sent[0].title


def test_drop_protected_severity_depends_on_lock(
    dispatcher: NotificationDispatcher, notifier: RecordingNotifier
) -> None:
    """ロック前は最優先、ロック後は情報。"""
    dispatcher.drop_protected("黄平", 543, locked=False)
    dispatcher.drop_protected("黄平", 543, locked=True)

    assert notifier.sent[0].severity is NotificationLevel.CRITICAL
    assert notifier.sent[1].severity is NotificationLevel.INFO


def test_task_notifications(
    dispatcher: NotificationDispatcher, notifier: RecordingNotifier
) -> None:
    dispatcher.task_finished("sortie", ok=True)
    dispatcher.task_finished("daily", ok=False, message="事前条件を満たしません")
    assert notifier.kinds() == ["TASK COMPLETED", "TASK FAILED"]


def test_all_tasks_completed(
    dispatcher: NotificationDispatcher, notifier: RecordingNotifier
) -> None:
    dispatcher.all_tasks_completed({"戦果": 105})
    assert notifier.sent[0].fields["戦果"] == "105"


def test_stop_cleared(
    dispatcher: NotificationDispatcher, notifier: RecordingNotifier
) -> None:
    dispatcher.stop_cleared(["資材の急減"])
    assert notifier.kinds() == ["STOP CLEARED"]


# ======================================================================
# 連投抑止
# ======================================================================


def test_same_notification_is_suppressed(
    dispatcher: NotificationDispatcher, notifier: RecordingNotifier
) -> None:
    """資材の下限割れは判定のたびに起きるので、そのまま送らない。"""
    resources = Resources(fuel=900, ammo=1, steel=1, bauxite=1, fast_repair=1)
    assert dispatcher.resource_low(resources, {}) is True
    assert dispatcher.resource_low(resources, {}) is False
    assert len(notifier.sent) == 1
    assert dispatcher.suppressed == 1


def test_different_targets_are_not_suppressed(
    dispatcher: NotificationDispatcher, notifier: RecordingNotifier
) -> None:
    dispatcher.damage_detected([101])
    dispatcher.damage_detected([102])
    assert len(notifier.sent) == 2


def test_cooldown_expires(notifier: RecordingNotifier) -> None:
    moments = iter([T0, T0 + timedelta(seconds=1), T0 + timedelta(seconds=400)])
    dispatcher = NotificationDispatcher(
        notifier, cooldown_seconds=300, clock=lambda: next(moments)
    )
    resources = Resources(fuel=900)

    assert dispatcher.resource_low(resources, {}) is True
    assert dispatcher.resource_low(resources, {}) is False
    assert dispatcher.resource_low(resources, {}) is True


def test_reset_cooldown_by_kind(
    dispatcher: NotificationDispatcher, notifier: RecordingNotifier
) -> None:
    dispatcher.damage_detected([101])
    dispatcher.reset_cooldown(NotificationKind.DAMAGE_DETECTED)
    assert dispatcher.damage_detected([101]) is True


def test_failed_send_does_not_start_cooldown(clock) -> None:
    """送れなかったものは冷却に入れない（次回また試す）。"""
    notifier = RecordingNotifier(should_fail=True)
    dispatcher = NotificationDispatcher(notifier, clock=clock)

    assert dispatcher.damage_detected([101]) is False
    notifier.should_fail = False
    assert dispatcher.damage_detected([101]) is True


# ======================================================================
# 判定からの振り分け
# ======================================================================


def test_observe_verdict_splits_resource_and_other(
    dispatcher: NotificationDispatcher,
    notifier: RecordingNotifier,
    state: GameState,
) -> None:
    verdict = SafetyVerdict.stop(
        ["燃料が下限を下回りました（900 < 1000）", "大破艦がいます: [103]"]
    )
    dispatcher.observe_verdict(verdict, state, {"min_fuel": 1000})
    assert set(notifier.kinds()) == {"RESOURCE LOW", "SAFETY STOP"}


def test_observe_verdict_ignores_ok(
    dispatcher: NotificationDispatcher,
    notifier: RecordingNotifier,
    state: GameState,
) -> None:
    dispatcher.observe_verdict(SafetyVerdict.ok(), state)
    assert notifier.sent == []


def test_observe_verdict_ignores_warning(
    dispatcher: NotificationDispatcher,
    notifier: RecordingNotifier,
    state: GameState,
) -> None:
    dispatcher.observe_verdict(SafetyVerdict.warn(["中破艦がいます"]), state)
    assert notifier.sent == []


# ======================================================================
# コマンドの解釈
# ======================================================================


@pytest.mark.parametrize(
    "text, expected",
    [
        ("status", Command(CommandName.STATUS)),
        ("  STOP  ", Command(CommandName.STOP)),
        ("!queue", Command(CommandName.QUEUE)),
        ("/resume", Command(CommandName.RESUME)),
        ("cancel abc123", Command(CommandName.CANCEL, "abc123")),
        ("stop 資材が心配", Command(CommandName.STOP, "資材が心配")),
    ],
)
def test_parse_command(text, expected) -> None:
    assert parse_command(text) == expected


def test_natural_language_is_rejected() -> None:
    """自然言語をここで実行しない（§17）。"""
    with pytest.raises(CommandError, match="自然言語の指示はここでは実行しません"):
        parse_command("1-5のゲージ割っておいて")


def test_empty_command_is_rejected() -> None:
    with pytest.raises(CommandError, match="空です"):
        parse_command("   ")


def test_cancel_requires_argument() -> None:
    with pytest.raises(CommandError, match="引数が必要"):
        parse_command("cancel")


def test_available_commands_lists_all() -> None:
    assert len(available_commands()) == len(CommandName)


# ======================================================================
# コマンドの実行
# ======================================================================


@pytest.fixture
def handler(state: GameState) -> CommandHandler:
    return CommandHandler(
        safety=SafetyManager(
            lock_guard=LockGuard(
                Blacklist(allow_empty=True, source="test"), DismantlePolicy()
            )
        ),
        queue=TaskQueue(),
        game_state=state,
        state_machine=StateMachine(),
    )


def test_status_reports_state(handler: CommandHandler) -> None:
    text = handler.handle_text("status")
    assert "資材:" in text
    assert "所有艦: 3" in text
    assert "状態: IDLE" in text


def test_stop_cancels_queue(handler: CommandHandler) -> None:
    handler.queue.push(Task("sortie", TaskPriority.SORTIE))
    text = handler.handle_text("stop 手動")

    assert handler.safety.is_stopped is True
    assert handler.queue.is_empty is True
    assert "1 件" in text


def test_status_shows_emergency_stop(handler: CommandHandler) -> None:
    handler.handle_text("stop 資材の急減")
    assert "緊急停止中" in handler.handle_text("status")


def test_resume_clears_stop(handler: CommandHandler) -> None:
    handler.handle_text("stop")
    text = handler.handle_text("resume")
    assert handler.safety.is_stopped is False
    assert "解除しました" in text


def test_resume_without_stop(handler: CommandHandler) -> None:
    assert "かかっていません" in handler.handle_text("resume")


def test_resume_does_not_clear_drop_protection(handler: CommandHandler) -> None:
    """未所持艦のロックが未確認なら、再開しても止まったまま。"""
    handler.safety.observe(
        [Event(EventType.UNKNOWN_SHIP_DROPPED, {"master_id": 543, "name": "黄平"}, T0)]
    )
    handler.handle_text("stop")
    text = handler.handle_text("resume")

    assert "保護待ちが残っています" in text
    assert handler.safety.pending_protections
    assert handler.safety.evaluate(handler.game_state, now=T0).should_stop is True


def test_queue_lists_tasks(handler: CommandHandler) -> None:
    assert "ありません" in handler.handle_text("queue")
    handler.queue.push(Task("daily", TaskPriority.DAILY_TASK))
    assert "daily" in handler.handle_text("queue")


def test_cancel_removes_task(handler: CommandHandler) -> None:
    task = handler.queue.push(Task("sortie", TaskPriority.SORTIE))
    assert "取り消しました" in handler.handle_text(f"cancel {task.task_id}")
    assert handler.queue.is_empty is True


def test_cancel_unknown_task(handler: CommandHandler) -> None:
    assert "該当する" in handler.handle_text("cancel nope")


# ======================================================================
# サンドボックスへ繋いだとき
# ======================================================================


def test_session_notifies_without_a_recorder() -> None:
    """通知は記録の有無に依存しない。"""
    from sandbox.session import SandboxSession
    from tasks.sortie_task import SortieTask

    sent = RecordingNotifier()
    session = SandboxSession.create(seed=3, dispatcher=NotificationDispatcher(sent))
    session.bootstrap()
    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))

    assert session.recorder is None
    assert "TASK COMPLETED" in sent.kinds()


def test_session_notifies_unknown_drop() -> None:
    from sandbox.session import SandboxSession
    from tasks.sortie_task import SortieTask

    sent = RecordingNotifier()
    session = SandboxSession.create(seed=3, dispatcher=NotificationDispatcher(sent))
    session.bootstrap()
    session.game.maps["1-5"].drop_pool = (1004,)  # 未所持
    session.game.battle.drop_rate = 1.0

    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    session.fight_through()

    assert "NEW DROP PROTECTED" in sent.kinds()
    protection = next(n for n in sent.sent if n.kind is NotificationKind.NEW_DROP_PROTECTED)
    assert protection.severity is NotificationLevel.CRITICAL


def test_session_notifies_damage() -> None:
    from sandbox.session import SandboxSession
    from tasks.sortie_task import SortieTask

    sent = RecordingNotifier()
    session = SandboxSession.create(seed=3, dispatcher=NotificationDispatcher(sent))
    session.bootstrap()
    session.game.maps["1-5"].enemy_strength = 800.0

    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    session.fight_through()

    assert "DAMAGE DETECTED" in sent.kinds()


def test_session_notifies_task_failure_and_stop() -> None:
    from sandbox.session import SandboxSession
    from tasks.sortie_task import SortieTask

    sent = RecordingNotifier()
    session = SandboxSession.create(seed=1, dispatcher=NotificationDispatcher(sent))
    session.bootstrap()
    for ship in session.game.fleet_ships(1):
        ship.hp = 1
    session.environment.records.append(session.game.port_record())
    session.sync()

    session.run(SortieTask(fleet_id=1, map_area=1, map_no=5))
    assert "TASK FAILED" in sent.kinds()


def test_session_runs_without_a_dispatcher() -> None:
    from sandbox.session import SandboxSession
    from tasks.sortie_task import SortieTask

    session = SandboxSession.create(seed=3)
    session.bootstrap()
    assert session.run(SortieTask(fleet_id=1, map_area=1, map_no=5)).ok is True

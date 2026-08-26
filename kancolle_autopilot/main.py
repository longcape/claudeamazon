"""kcsapi ログから状態を再構築し、安全判定を表示する読み取り専用 CLI。

Phase 1〜2 の成果を人間が目視で検証するための入口。**ゲームへの接続も
GUI 操作も行わない。**

Usage:
    # 保存済みログを再生する
    python main.py replay --log data/fixtures/scenario_unknown_drop.jsonl

    # ディレクトリを監視して、更新のたびに状態と安全判定を表示する
    python main.py watch --log "C:/poi/kcsapi" --fleet 1
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import threading
from pathlib import Path
from datetime import datetime
from typing import Any, Iterator, Sequence

from core.config_manager import ConfigError, ConfigManager
from core.persistence import PersistenceError
from automation.controller import ControlledInterface
from automation.keyboard_controller import KeyboardController, VirtualKeyboard
from automation.mouse_controller import MouseController
from automation.screen_detector import ScreenDetector
from automation.simulation import SimulationInterface, build_interface
from core.scheduler import Scheduler, TaskSpec
from core.task_queue import PRIORITY_BY_TASK_NAME
from monitor.api_parser import APIParser, Event, EventType
from monitor.game_state import GameState
from monitor.log_monitor import LogMonitor
from safety.safety_manager import SafetyManager
from safety.verdict import SafetyLevel, SafetyVerdict

logger = logging.getLogger("kancolle_autopilot")

#: 要約時に一覧すると煩いイベント。
_QUIET_EVENTS = frozenset({EventType.PORT_REFRESHED})

#: ``schedule add`` で使えるタスク名と優先度。
TASK_PRIORITIES = PRIORITY_BY_TASK_NAME

#: 安全判定レベルごとの終了コード。
_EXIT_CODE_BY_LEVEL = {
    SafetyLevel.OK: 0,
    SafetyLevel.WARNING: 0,
    SafetyLevel.STOP: 2,
}


def iter_records(path: Path) -> Iterator[Any]:
    """ログのパスからレコードを 1 件ずつ取り出す。

    単一 JSON オブジェクト・JSON 配列・JSON Lines、およびそれらを
    含むディレクトリ（名前順）に対応する。

    Args:
        path: ファイルまたはディレクトリ。

    Yields:
        レコード（辞書を想定）。
    """
    if path.is_dir():
        for child in sorted(path.iterdir()):
            if child.is_file() and child.suffix in (".json", ".jsonl"):
                yield from iter_records(child)
        return

    text = path.read_text(encoding="utf-8")
    stripped = text.lstrip()
    if stripped.startswith("["):
        try:
            yield from json.loads(text)
            return
        except json.JSONDecodeError:
            logger.warning("JSON 配列として読めません: %s", path)
            return
    if stripped.startswith("{"):
        try:
            yield json.loads(text)
            return
        except json.JSONDecodeError:
            # JSON Lines の可能性があるので行単位で再試行する。
            pass
    for line_no, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            logger.warning("%s:%d の JSON を読めません（スキップ）", path, line_no)


def replay(path: Path, manager: SafetyManager) -> tuple[GameState, list[Event]]:
    """ログを再生して最終状態と派生イベントを返す。"""
    parser = APIParser()
    state = GameState()
    derived: list[Event] = []
    count = 0

    for record in iter_records(path):
        events = parser.parse_record(record)
        if not events:
            continue
        count += len(events)
        new_events = state.apply_all(events)
        manager.observe(new_events)
        derived.extend(new_events)

    logger.info("%d 件のイベントを適用しました", count)
    return state, derived


def render_state(state: GameState) -> str:
    """再構築した状態を人間向けに整形する。"""
    lines: list[str] = []
    resources = state.resources
    lines.append("== 資材 ==")
    lines.append(
        f"  燃料 {resources.fuel} / 弾薬 {resources.ammo} / "
        f"鋼材 {resources.steel} / ボーキ {resources.bauxite} / "
        f"バケツ {resources.buckets}"
    )

    lines.append(f"== 艦（{len(state.ships)} 隻）==")
    for ship in sorted(state.ships.values(), key=lambda s: s.instance_id):
        lock = {True: "ロック", False: "未ロック", None: "ロック状態不明"}[ship.locked]
        lines.append(
            f"  #{ship.instance_id} master={ship.master_id} Lv{ship.level} "
            f"{ship.damage_state.label} cond={ship.cond} {lock}"
        )

    lines.append("== 艦隊 ==")
    for fleet in sorted(state.fleets.values(), key=lambda f: f.fleet_id):
        mission = f" 遠征{fleet.mission.mission_id}" if fleet.mission.is_active else ""
        lines.append(f"  第{fleet.fleet_id}艦隊 {fleet.ship_ids}{mission}")

    if state.sortie is not None:
        status = "出撃中" if state.sortie.is_active else "終了"
        lines.append(f"== 出撃 ==\n  {state.sortie.map_label} ({status})")

    if state.last_drop is not None:
        drop = state.last_drop
        judgement = {True: "未所持", False: "所持済み", None: "判定不能"}[drop.is_new]
        lines.append(f"== 直近ドロップ ==\n  {drop.name} ({judgement})")
    return "\n".join(lines)


def render_events(events: Sequence[Event]) -> str:
    """派生イベントを整形する。"""
    notable = [event for event in events if event.type not in _QUIET_EVENTS]
    if not notable:
        return ""
    lines = ["== 派生イベント =="]
    lines.extend(f"  {event.type.value}: {dict(event.payload)}" for event in notable)
    return "\n".join(lines)


def render_verdict(verdict: SafetyVerdict, manager: SafetyManager) -> str:
    """安全判定を整形する。"""
    lines = ["== 安全判定 ==", f"  レベル: {verdict.level.name}"]
    lines.extend(f"  - {reason}" for reason in verdict.reasons)
    for pending in manager.pending_protections:
        lines.append(f"  ! 保護待ち: {pending.name or pending.master_id}")
    return "\n".join(lines)


def build_manager(config: ConfigManager) -> SafetyManager:
    """設定から SafetyManager を組み立てる。"""
    manager = SafetyManager.from_config(config)
    if not manager.lock_guard.blacklist.is_configured:
        logger.warning(
            "ブラックリストが未設定です。解体候補はすべて拒否されます: %s",
            manager.lock_guard.blacklist.source,
        )
    return manager


def command_replay(args: argparse.Namespace, config: ConfigManager) -> int:
    """保存ログを再生する。"""
    log_path = Path(args.log)
    if not log_path.exists():
        print(f"ログが見つかりません: {log_path}", file=sys.stderr)
        return 1

    manager = build_manager(config)
    state, derived = replay(log_path, manager)
    verdict = manager.evaluate(state, fleet_id=args.fleet)

    sections = [render_state(state), render_events(derived), render_verdict(verdict, manager)]
    print("\n".join(section for section in sections if section))
    return _EXIT_CODE_BY_LEVEL[verdict.level]


def command_watch(args: argparse.Namespace, config: ConfigManager) -> int:
    """ディレクトリを監視して、更新のたびに状態を表示する。"""
    log_dir = args.log or config.get("monitor.log_dir")
    if not log_dir:
        print(
            "監視先が指定されていません（--log か monitor.log_dir）", file=sys.stderr
        )
        return 1

    manager = build_manager(config)
    state = GameState()
    monitor = LogMonitor(
        log_dir,
        APIParser(),
        read_existing=bool(config.get("monitor.read_existing")),
    )
    stop = threading.Event()

    def handle(events: list[Event]) -> None:
        derived = state.apply_all(events)
        manager.observe(derived)
        verdict = manager.evaluate(state, fleet_id=args.fleet)
        sections = [render_state(state), render_events(derived), render_verdict(verdict, manager)]
        print("\n".join(section for section in sections if section), flush=True)
        print("-" * 60, flush=True)

    try:
        monitor.run(
            handle,
            interval=float(config.get("monitor.poll_interval_seconds", 1.0)),
            stop=stop,
        )
    except KeyboardInterrupt:
        stop.set()
        logger.info("監視を終了します")
    return 0


def parse_when(text: str) -> datetime:
    """``--at`` の文字列を tz 付き datetime へ変換する。

    オフセットが無い場合はローカルタイムとして解釈し、採用した
    オフセットを表示する（暗黙に UTC とみなすと時刻がずれるため）。

    Raises:
        ValueError: ISO 8601 として解釈できない場合。
    """
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
        print(f"オフセット省略のためローカル時刻として解釈: {parsed.isoformat()}")
    return parsed


def open_scheduler(config: ConfigManager) -> Scheduler:
    """設定に従って予約ファイルを開く。"""
    path = config.path.parent / str(config.get("scheduler.state_path"))
    return Scheduler.load(path)


def command_schedule(args: argparse.Namespace, config: ConfigManager) -> int:
    """予約の一覧・追加・取り消しを行う。"""
    scheduler = open_scheduler(config)

    if args.action == "list":
        pending = scheduler.pending()
        if not pending:
            print("予約はありません")
            return 0
        print(f"== 予約（{len(pending)} 件）==")
        for reservation in pending:
            print(f"  [{reservation.reservation_id}] {reservation.describe()}")
        return 0

    if args.action == "cancel":
        if scheduler.cancel(args.id):
            print(f"取り消しました: {args.id}")
            return 0
        print(f"該当する待機中の予約がありません: {args.id}", file=sys.stderr)
        return 1

    # add
    try:
        run_at = parse_when(args.at)
    except ValueError as exc:
        print(f"時刻を解釈できません: {args.at}: {exc}", file=sys.stderr)
        return 1

    names = [name.strip() for name in args.tasks.split(",") if name.strip()]
    unknown = [name for name in names if name not in TASK_PRIORITIES]
    if unknown:
        print(
            "未知のタスク名です: " + ", ".join(unknown)
            + "（使えるのは " + ", ".join(sorted(TASK_PRIORITIES)) + "）",
            file=sys.stderr,
        )
        return 1

    specs = [TaskSpec(name, TASK_PRIORITIES[name]) for name in names]
    try:
        reservation = scheduler.reserve(
            run_at, specs, name=args.name or "", max_delay_seconds=args.max_delay
        )
    except (ValueError, PersistenceError) as exc:
        print(f"予約できません: {exc}", file=sys.stderr)
        return 1

    print(f"予約しました: [{reservation.reservation_id}] {reservation.describe()}")
    return 0


def build_task(args: argparse.Namespace) -> Any:
    """``--task`` の指定から Task オブジェクトを組み立てる。

    Raises:
        ValueError: 引数が足りない、または解釈できない場合。
    """
    from tasks.construction_task import ConstructionTask, Recipe
    from tasks.daily_task import DailyTask
    from tasks.dismantle_task import DismantleTask
    from tasks.expedition_task import ExpeditionTask
    from tasks.sortie_task import SortieTask

    if args.task == "sortie":
        if not args.map:
            raise ValueError("sortie には --map が必要です（例 1-5）")
        area, _, number = args.map.partition("-")
        if not number:
            raise ValueError(f"海域の指定が不正です: {args.map}")
        return SortieTask(args.fleet, int(area), int(number))

    if args.task == "expedition":
        if args.mission is None:
            raise ValueError("expedition には --mission が必要です")
        return ExpeditionTask(args.fleet, args.mission)

    if args.task == "daily":
        quests = [int(q) for q in args.quests.split(",") if q.strip()]
        return DailyTask(quests)

    if args.task == "construction":
        values = [int(v) for v in args.recipe.split("/")] if args.recipe else []
        recipe = Recipe(*values) if values else Recipe()
        return ConstructionTask(recipe)

    ships = [int(s) for s in args.ships.split(",") if s.strip()]
    return DismantleTask(ships)


def build_sandbox_interface(state: Any) -> tuple[Any, Any]:
    """サンドボックス環境を組み立てて、操作層と繋ぐ。

    論理名 → 座標 → 当たり判定 → 画面遷移 まで通るので、論理名のまま
    記録するシミュレーションでは分からない座標解決の間違いが表に出る。
    """
    from sandbox.environment import SandboxEnvironment, SandboxPointer

    # 解体画面の並び順は所有 ID 順とする。
    environment = SandboxEnvironment(ship_order=sorted(state.ships))
    interface = ControlledInterface(
        detector=ScreenDetector(environment, dynamic=environment),
        mouse=MouseController(SandboxPointer(environment)),
        keyboard=KeyboardController(VirtualKeyboard()),
    )
    return interface, environment


def command_simulate(args: argparse.Namespace, config: ConfigManager) -> int:
    """保存ログから状態を組み立て、タスクをシミュレーション実行する。

    実際のクリックは行わない。何をしようとしたかがログに出る。
    """
    from tasks.base_task import TaskContext

    log_path = Path(args.log)
    if not log_path.exists():
        print(f"ログが見つかりません: {log_path}", file=sys.stderr)
        return 1

    if not config.get("automation.simulation_mode"):
        print(
            "automation.simulation_mode が false です。"
            "実 GUI 操作は未実装のため実行できません。",
            file=sys.stderr,
        )
        return 1

    try:
        task = build_task(args)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    manager = build_manager(config)
    state, _ = replay(log_path, manager)

    environment = None
    if args.backend == "sandbox":
        interface, environment = build_sandbox_interface(state)
    else:
        interface = build_interface(True)

    ctx = TaskContext(
        game_state=state, safety=manager, interface=interface, now=state.clock()
    )
    result = task.execute(ctx)

    print(f"== タスク: {task.name} ==")
    print(f"  結果: {'成功' if result.ok else '失敗'}")
    if result.message:
        print(f"  {result.message}")
    for key, value in result.details.items():
        print(f"  {key}: {value}")
    if result.actions:
        print("== 実行した操作 ==")
        for action in result.actions:
            print(f"  {action.describe()}")
    if environment is not None:
        print("== サンドボックスが受け取った操作 ==")
        for target in environment.pressed_targets:
            print(f"  {target}")
        print(f"  最終画面: {environment.screen.value}")
        if environment.misses:
            print(f"  当たらなかった座標: {environment.misses}")
        print("== カーソル軌跡（末尾 5 点）==")
        for line in interface.mouse.describe_trace(5):
            print(f"  {line}")
    if manager.is_stopped:
        print("== 緊急停止 ==")
        for reason in manager.latched_reasons:
            print(f"  {reason}")
    return 0 if result.ok else 2


def command_sandbox(args: argparse.Namespace, config: ConfigManager) -> int:
    """サンドボックスで AI の判断ループを一周させる。

    実ゲームには接続しない。ゲーム・環境・AI Core を組み立て、
    出撃 → 戦闘 → 帰投 → 遠征 を回して結果を表示する。
    """
    from sandbox.session import SandboxSession
    from tasks.expedition_task import ExpeditionTask
    from tasks.sortie_task import SortieTask

    from recording.timeline import UnknownBreakpoint

    try:
        recorder = make_recorder(args)
    except UnknownBreakpoint as exc:
        print(str(exc), file=sys.stderr)
        return 1

    dispatcher = None
    if args.notify:
        from notify.dispatcher import NotificationDispatcher
        from notify.notifier import ConsoleNotifier, build_notifier

        notifier = (
            build_notifier(True, str(config.get("discord.webhook_url")))
            if config.get("discord.enabled")
            else ConsoleNotifier()
        )
        dispatcher = NotificationDispatcher(notifier)

    session = SandboxSession.create(
        seed=args.seed, recorder=recorder, dispatcher=dispatcher
    )
    session.bootstrap()

    area, _, number = args.map.partition("-")
    if not number:
        print(f"海域の指定が不正です: {args.map}", file=sys.stderr)
        return 1

    print("== 初期状態 ==")
    for key, value in session.summary().items():
        print(f"  {key}: {value}")

    for cycle in range(1, args.cycles + 1):
        print(f"\n== 周回 {cycle} ==")
        result = session.run(SortieTask(args.fleet, int(area), int(number)))
        print(f"  出撃: {'成功' if result.ok else '失敗'} — {result.message}")
        if not result.ok:
            break
        ranks = session.fight_through()
        print(f"  戦闘: {' '.join(ranks)}")
        if session.safety.pending_protections:
            names = [
                pending.name or str(pending.master_id)
                for pending in session.safety.pending_protections
            ]
            print(f"  ! 未所持艦を検出しました: {names}")
            print("    保護（ロック）が確認できるまで周回を止めます")
            break

    if args.expedition is not None:
        result = session.run(ExpeditionTask(args.expedition_fleet, args.expedition))
        print(f"\n== 遠征 ==\n  {'成功' if result.ok else '失敗'} — {result.message}")
        if result.ok:
            session.complete_all_expeditions()
            print("  帰投しました")

    print("\n== 最終状態 ==")
    for key, value in session.summary().items():
        print(f"  {key}: {value}")

    if recorder is not None:
        print("== 記録 ==")
        for key, value in recorder.summary().items():
            print(f"  {key}: {value}")
        if args.record:
            paths = recorder.save(args.record)
            print(f"  保存先: {paths['timeline'].parent}")
    if session.safety.is_stopped:
        print("== 緊急停止 ==")
        for reason in session.safety.latched_reasons:
            print(f"  {reason}")
        return 2
    return 0


def make_recorder(args: argparse.Namespace) -> Any:
    """``--record`` / ``--break`` / ``--step`` から記録係を作る。

    Returns:
        記録が要らなければ ``None``。

    Raises:
        UnknownBreakpoint: ブレークポイント名が不正な場合。
    """
    from recording.recorder import SessionRecorder
    from recording.timeline import BreakpointSet

    names = [name for name in args.breakpoints.split(",") if name.strip()]
    if not (args.record or names or args.step):
        return None

    recorder = SessionRecorder(breakpoints=BreakpointSet.from_names(names))
    recorder.step_mode = args.step

    interactive = args.step and sys.stdin.isatty()

    def on_pause(event) -> None:
        print(f"  ⏸ {event.describe()}", flush=True)
        if interactive:
            input("     Enter で次へ ")

    recorder.on_pause = on_pause
    return recorder


def command_review(args: argparse.Namespace, config: ConfigManager) -> int:
    """記録したタイムラインを再生する。"""
    from recording.replay import ReplayPlayer, filter_noise, summarize
    from recording.timeline import Timeline

    directory = Path(args.dir)
    timeline_path = directory / "timeline.jsonl"
    if not timeline_path.exists():
        print(f"タイムラインが見つかりません: {timeline_path}", file=sys.stderr)
        return 1

    timeline = Timeline.load(timeline_path)
    if not args.include_cursor:
        timeline = filter_noise(timeline)

    print(f"== 記録 ==\n  {timeline_path}（{len(timeline)} 件）")
    counts = summarize(timeline)
    print("  " + " / ".join(f"{kind}:{count}" for kind, count in sorted(counts.items())))

    decisions_path = directory / "decisions.json"
    if decisions_path.exists():
        decisions = json.loads(decisions_path.read_text(encoding="utf-8"))
        mismatched = [
            d
            for d in decisions
            if d.get("actual_result") is not None
            and d["actual_result"] != d["expected_result"]
        ]
        print(f"== 判断 ==\n  {len(decisions)} 件 / うち期待とずれたもの {len(mismatched)} 件")
        for entry in mismatched:
            print(
                f"  ! {entry['decision']} 期待={entry['expected_result']}"
                f" 実際={entry['actual_result']}"
            )

    if args.summary:
        return 0

    player = ReplayPlayer(timeline)
    if args.start:
        player.jump(args.start)
        player.position = max(0, args.start)

    print("== 再生 ==")
    if args.speed <= 0:
        for event in player.step(args.limit or len(timeline)):
            print(f"  {event.describe()}")
    else:
        player.play(
            speed=args.speed,
            limit=args.limit,
            on_event=lambda event: print(f"  {event.describe()}", flush=True),
        )
    return 0


def command_plan(args: argparse.Namespace, config: ConfigManager) -> int:
    """自然言語または JSON を構造化タスクへ変換し、必要なら適用する。

    ``--text`` は LLM を呼ぶので API キーが要る。``--json`` は同じ検証・
    適用の経路を、LLM 抜きで確かめるための入口。
    """
    from core.task_queue import TaskQueue
    from llm.parser import AnthropicClient, ParseError, TaskParser
    from llm.schema import SchemaError, validate_plan
    from llm.task_planner import TaskPlanner, plan_to_specs

    try:
        if args.json:
            source = Path(args.json)
            raw = json.loads(
                source.read_text(encoding="utf-8")
                if source.exists()
                else args.json
            )
            plan = validate_plan(raw)
        else:
            parser = TaskParser(AnthropicClient(effort=args.effort))
            plan = parser.parse(args.text)
    except (ParseError, SchemaError) as exc:
        print(f"変換できません: {exc}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"JSON として読めません: {exc}", file=sys.stderr)
        return 1

    print("== 構造化タスク ==")
    for line in plan.describe().splitlines():
        print(f"  {line}")

    if not args.apply:
        print("\n（--apply を付けると予約・投入まで行います）")
        return 0

    manager = build_manager(config)
    state = GameState()
    if args.log:
        log_path = Path(args.log)
        if not log_path.exists():
            print(f"ログが見つかりません: {log_path}", file=sys.stderr)
            return 1
        state, _ = replay(log_path, manager)

    scheduler = open_scheduler(config)

    if not plan.schedule.is_scheduled:
        # 時刻指定が無い計画も予約として残す。CLI はキューを持たないので、
        # ここで投入しても常駐プロセスには届かない。発火時刻を「いま」に
        # して、次に起きた常駐が拾えるようにする。
        reservation = scheduler.reserve(
            state.clock(), plan_to_specs(plan), name="immediate", max_delay_seconds=None
        )
        print("\n== 適用結果 ==")
        print(f"  予約: {reservation.describe()}")
        print("  （main.py run が次の周で拾います）")
        return 0

    planner = TaskPlanner(
        scheduler=scheduler,
        queue=TaskQueue(),
        safety=manager,
        game_state=state,
    )
    result = planner.apply(plan)

    print("\n== 適用結果 ==")
    for line in result.describe().splitlines():
        print(f"  {line}")
    return 0 if result.accepted else 2


def stdin_command_source() -> Any:
    """標準入力から管理コマンドを読む。

    Discord bot を繋ぐ場合も、同じ :class:`~notify.commands.CommandHandler`
    へ文字列を渡すだけでよい。ここは入口が 1 つあることを示す最小の実装。

    Returns:
        溜まっている行を返す関数。
    """
    import queue as queue_module

    pending: Any = queue_module.Queue()

    def reader() -> None:
        # 入力が閉じても常駐は止めない。終了は --ticks か割り込みで決める。
        for line in sys.stdin:
            text = line.strip()
            if text:
                pending.put(text)

    threading.Thread(target=reader, daemon=True).start()

    def drain() -> list[str]:
        lines: list[str] = []
        while not pending.empty():
            lines.append(pending.get_nowait())
        return lines

    return drain


def command_run(args: argparse.Namespace, config: ConfigManager) -> int:
    """サンドボックスに対して常駐運用する。

    予約の発火・安全判定・タスク実行・記録・通知を 1 プロセスで回す。
    実ゲームには接続しない。
    """
    from core.orchestrator import Orchestrator
    from core.task_queue import TaskQueue
    from notify.commands import available_commands
    from sandbox.session import SandboxSession

    try:
        recorder = make_recorder(args)
    except Exception as exc:  # noqa: BLE001 - ブレークポイント名の誤り
        print(str(exc), file=sys.stderr)
        return 1

    dispatcher = None
    if args.notify:
        from notify.dispatcher import NotificationDispatcher
        from notify.notifier import ConsoleNotifier, build_notifier

        notifier = (
            build_notifier(True, str(config.get("discord.webhook_url")))
            if config.get("discord.enabled")
            else ConsoleNotifier()
        )
        dispatcher = NotificationDispatcher(notifier)

    session = SandboxSession.create(
        seed=args.seed, recorder=recorder, dispatcher=dispatcher
    )
    session.bootstrap()
    session.environment.records.append(session.game.kdock_record())
    session.sync()

    orchestrator = Orchestrator(
        source=session,
        game_state=session.game_state,
        safety=session.safety,
        queue=TaskQueue(),
        scheduler=open_scheduler(config),
        execute=session.run_and_resolve,
        dispatcher=dispatcher,
    )

    stop = threading.Event()
    bot = None
    if args.discord:
        from notify.bot import CommandBot

        try:
            bot = CommandBot.from_config(config.as_dict()["discord"])
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        if not bot.has_allowlist:
            print(
                "discord.allowed_user_ids が空です。コマンドはすべて拒否されます。",
                file=sys.stderr,
            )
        try:
            bot.start()
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        orchestrator.command_source = bot.drain
        orchestrator.command_sink = bot.channel.reply
        print("== Discord からコマンドを受け付けます ==")
    elif args.commands:
        orchestrator.command_source = stdin_command_source()

    if args.discord or args.commands:
        print("== 管理コマンド ==")
        for line in available_commands():
            print(f"  {line}")

    print(f"== 常駐開始（{args.ticks or '無制限'} 周 / 間隔 {args.interval}s）==")

    def show(report) -> None:
        if args.dashboard:
            print(render_dashboard(session, orchestrator, report), flush=True)
        else:
            print(f"  {report.describe()}", flush=True)

    try:
        orchestrator.run(
            stop=stop,
            interval=args.interval,
            on_tick=show,
            max_ticks=args.ticks or None,
        )
    except KeyboardInterrupt:
        stop.set()
        orchestrator.shutdown("割り込み")
    finally:
        if bot is not None:
            bot.stop()

    print("\n== 最終状態 ==")
    for key, value in session.summary().items():
        print(f"  {key}: {value}")
    if recorder is not None and args.record:
        paths = recorder.save(args.record)
        print(f"  記録: {paths['timeline'].parent}")
        from viz.report import report_from_recorder, write_report

        output = write_report(
            Path(args.record) / "report.html",
            report_from_recorder(recorder, "サンドボックス稼働の記録"),
        )
        print(f"  レポート: {output}")
    return 2 if session.safety.is_stopped else 0


def render_dashboard(session: Any, orchestrator: Any, report: Any) -> str:
    """常時表示用の 1 画面ぶんのテキストを組み立てる（追加指示書 §16）。"""
    state = orchestrator.game_state
    resources = state.resources
    lines = [
        "─" * 62,
        f"状態 {orchestrator.machine.state.value:<16} 安全 {report.verdict.level.name}",
        f"資材 燃{resources.fuel} 弾{resources.ammo} 鋼{resources.steel} "
        f"ボ{resources.bauxite} バケツ{resources.buckets}",
        f"艦 {len(state.ships)} 隻 / 待機タスク {len(orchestrator.queue)} / "
        f"予約 {len(orchestrator.scheduler)}",
    ]

    damaged = state.heavily_damaged_ships()
    if damaged:
        lines.append(f"大破 {[ship.instance_id for ship in damaged]}")

    busy = [
        f"入渠{dock.dock_id}"
        for dock in state.repair_docks.values()
        if dock.is_busy
    ] + [
        f"建造{dock.dock_id}"
        for dock in state.build_docks.values()
        if dock.is_busy
    ]
    waiting = [f"遠征受取 第{i}艦隊" for i in state.returned_expeditions()] + [
        f"建造受取 ドック{i}" for i in state.completed_builds()
    ]
    if busy:
        lines.append("進行中 " + " ".join(busy))
    if waiting:
        lines.append("受け取り待ち " + " ".join(waiting))
    if orchestrator.safety.pending_protections:
        names = [
            pending.name or str(pending.master_id)
            for pending in orchestrator.safety.pending_protections
        ]
        lines.append(f"保護待ち {names}")
    if orchestrator.safety.is_stopped:
        lines.append("緊急停止中: " + " / ".join(orchestrator.safety.latched_reasons))

    trace = session.interface.mouse.describe_trace(1)
    if trace:
        lines.append(f"カーソル {trace[0]}")
    lines.append(f"直近 {report.describe()}")
    return "\n".join(lines)


def command_view(args: argparse.Namespace, config: ConfigManager) -> int:
    """記録から HTML レポートを作る。"""
    from recording.decision_log import Decision
    from recording.timeline import Timeline
    from viz.report import build_report, write_report

    directory = Path(args.dir)
    timeline_path = directory / "timeline.jsonl"
    if not timeline_path.exists():
        print(f"タイムラインが見つかりません: {timeline_path}", file=sys.stderr)
        return 1

    timeline = Timeline.load(timeline_path)
    decisions: list[Decision] = []
    decisions_path = directory / "decisions.json"
    if decisions_path.exists():
        for entry in json.loads(decisions_path.read_text(encoding="utf-8")):
            decisions.append(
                Decision(
                    decision=entry.get("decision", ""),
                    reason_code=entry.get("reason_code", ""),
                    input_state_summary=entry.get("input_state_summary") or {},
                    constraints=tuple(entry.get("constraints") or ()),
                    selected_action=entry.get("selected_action", ""),
                    expected_result=entry.get("expected_result", ""),
                    actual_result=entry.get("actual_result"),
                    task_id=entry.get("task_id"),
                    at=datetime.fromisoformat(entry["at"]),
                )
            )

    html = build_report(timeline, decisions, title=args.title or directory.name)
    output = write_report(args.out or directory / "report.html", html)
    print(f"レポートを書き出しました: {output}")
    print(f"  イベント {len(timeline)} 件 / 判断 {len(decisions)} 件")
    print("  スナップショットは記録に含まれないため、GameState View は空になります")
    return 0


def main(argv: list[str] | None = None) -> int:
    """エントリポイント。

    Returns:
        終了コード。安全判定が STOP なら 2、入力エラーなら 1。
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="config.json", help="設定ファイル")
    parser.add_argument("--verbose", action="store_true", help="デバッグログを出力する")

    subparsers = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("replay", "保存済みログを再生する"),
        ("watch", "ディレクトリを監視する"),
    ):
        sub = subparsers.add_parser(name, help=help_text)
        sub.add_argument(
            "--log",
            required=name == "replay",
            help="kcsapi ログのファイルまたはディレクトリ",
        )
        sub.add_argument(
            "--fleet", type=int, default=None, help="損傷判定の対象とする艦隊 ID"
        )

    simulate = subparsers.add_parser(
        "simulate", help="タスクをシミュレーション実行する（クリックしない）"
    )
    simulate.add_argument("--log", required=True, help="状態を組み立てる kcsapi ログ")
    simulate.add_argument(
        "--task",
        required=True,
        choices=("sortie", "expedition", "daily", "construction", "dismantle"),
        help="実行するタスク",
    )
    simulate.add_argument("--fleet", type=int, default=2, help="対象の艦隊 ID")
    simulate.add_argument("--map", default="", help="出撃先（例 1-5）")
    simulate.add_argument("--mission", type=int, default=None, help="遠征番号")
    simulate.add_argument("--quests", default="", help="追跡するデイリー任務 ID")
    simulate.add_argument("--ships", default="", help="解体候補の所有 ID")
    simulate.add_argument("--recipe", default="", help="建造レシピ（例 30/30/30/30）")
    simulate.add_argument(
        "--backend",
        choices=("logical", "sandbox"),
        default="logical",
        help="logical: 論理名のまま記録 / sandbox: 座標まで解決して仮想環境を叩く",
    )

    sandbox = subparsers.add_parser(
        "sandbox", help="サンドボックスで判断ループを回す（実ゲームに接続しない）"
    )
    sandbox.add_argument("--seed", type=int, default=0, help="戦闘乱数の種")
    sandbox.add_argument("--map", default="1-5", help="周回する海域（例 1-5）")
    sandbox.add_argument("--fleet", type=int, default=1, help="出撃する艦隊 ID")
    sandbox.add_argument("--cycles", type=int, default=3, help="周回する回数")
    sandbox.add_argument(
        "--expedition", type=int, default=None, help="周回後に出す遠征番号"
    )
    sandbox.add_argument(
        "--expedition-fleet",
        dest="expedition_fleet",
        type=int,
        default=2,
        help="遠征に出す艦隊 ID",
    )
    sandbox.add_argument("--record", default="", help="記録の保存先ディレクトリ")
    sandbox.add_argument(
        "--break",
        dest="breakpoints",
        default="",
        help="停止条件をカンマ区切りで指定（例 on_battle_end,on_damage）",
    )
    sandbox.add_argument(
        "--step", action="store_true", help="1 イベントごとに止める"
    )
    sandbox.add_argument(
        "--notify",
        action="store_true",
        help="重要イベントを通知する（discord.enabled が false なら標準出力）",
    )

    run_parser = subparsers.add_parser(
        "run", help="常駐運用する（サンドボックス。実ゲームに接続しない）"
    )
    run_parser.add_argument("--seed", type=int, default=0, help="戦闘乱数の種")
    run_parser.add_argument(
        "--interval", type=float, default=1.0, help="1 周ごとの待ち時間（秒）"
    )
    run_parser.add_argument(
        "--ticks", type=int, default=0, help="回す周回数（0 で無制限）"
    )
    run_parser.add_argument(
        "--commands", action="store_true", help="標準入力から管理コマンドを受ける"
    )
    run_parser.add_argument("--record", default="", help="記録の保存先ディレクトリ")
    run_parser.add_argument(
        "--break", dest="breakpoints", default="", help="停止条件（カンマ区切り）"
    )
    run_parser.add_argument("--step", action="store_true", help="1 イベントごとに止める")
    run_parser.add_argument("--notify", action="store_true", help="重要イベントを通知する")
    run_parser.add_argument(
        "--dashboard", action="store_true", help="毎周、状態を一覧表示する"
    )
    run_parser.add_argument(
        "--discord",
        action="store_true",
        help="Discord から管理コマンドを受ける（bot_token / channel_id / "
        "allowed_user_ids の設定が要る）",
    )

    plan_parser = subparsers.add_parser(
        "plan", help="自然言語を構造化タスクへ変換する"
    )
    plan_parser.add_argument("--text", default="", help="変換する指示（LLM を使う）")
    plan_parser.add_argument(
        "--json", default="", help="検証する計画の JSON（ファイルまたは文字列）"
    )
    plan_parser.add_argument(
        "--apply", action="store_true", help="予約・投入まで行う"
    )
    plan_parser.add_argument(
        "--log", default="", help="安全判定に使う kcsapi ログ（--apply 時）"
    )
    plan_parser.add_argument(
        "--effort", default="low", help="LLM の思考の深さ（low/medium/high）"
    )

    view = subparsers.add_parser("view", help="記録から HTML レポートを作る")
    view.add_argument("--dir", required=True, help="記録の保存先ディレクトリ")
    view.add_argument("--out", default="", help="出力先（既定は <dir>/report.html）")
    view.add_argument("--title", default="", help="レポートの表題")

    review = subparsers.add_parser("review", help="記録したタイムラインを再生する")
    review.add_argument("--dir", required=True, help="記録の保存先ディレクトリ")
    review.add_argument(
        "--speed", type=float, default=0.0, help="再生速度（0 で待たずに一覧表示）"
    )
    review.add_argument("--limit", type=int, default=None, help="表示する最大件数")
    review.add_argument("--start", type=int, default=0, help="開始位置")
    review.add_argument(
        "--include-cursor", action="store_true", help="カーソルの MOVE も表示する"
    )
    review.add_argument("--summary", action="store_true", help="概要だけ表示する")

    schedule = subparsers.add_parser("schedule", help="未来タスクの予約を操作する")
    schedule.add_argument(
        "action", choices=("list", "add", "cancel"), help="操作の種類"
    )
    schedule.add_argument("--at", help="発火時刻（ISO 8601、例 2026-08-27T10:52+09:00）")
    schedule.add_argument(
        "--tasks", default="", help="投入するタスク名をカンマ区切りで指定"
    )
    schedule.add_argument("--name", default="", help="予約の表示名")
    schedule.add_argument("--id", default="", help="cancel する予約 ID")
    schedule.add_argument(
        "--max-delay",
        dest="max_delay",
        type=int,
        default=3600,
        help="発火時刻からこの秒数を過ぎたら失効させる（0 で無期限）",
    )

    args = parser.parse_args(argv)

    if args.command == "schedule":
        if args.action == "add" and not (args.at and args.tasks):
            parser.error("add には --at と --tasks が必要です")
        if args.action == "cancel" and not args.id:
            parser.error("cancel には --id が必要です")
        if args.max_delay == 0:
            args.max_delay = None

    try:
        config = ConfigManager(args.config).load()
    except ConfigError as exc:
        print(f"設定エラー: {exc}", file=sys.stderr)
        return 1

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else config.get("logging.level", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.command == "watch":
        return command_watch(args, config)
    if args.command == "schedule":
        return command_schedule(args, config)
    if args.command == "simulate":
        return command_simulate(args, config)
    if args.command == "sandbox":
        return command_sandbox(args, config)
    if args.command == "review":
        return command_review(args, config)
    if args.command == "view":
        return command_view(args, config)
    if args.command == "run":
        return command_run(args, config)
    if args.command == "plan":
        if not (args.text or args.json):
            parser.error("plan には --text か --json が必要です")
        return command_plan(args, config)
    return command_replay(args, config)


if __name__ == "__main__":
    raise SystemExit(main())

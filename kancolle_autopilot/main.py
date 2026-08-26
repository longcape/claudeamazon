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
from typing import Any, Iterator, Sequence

from core.config_manager import ConfigError, ConfigManager
from monitor.api_parser import APIParser, Event, EventType
from monitor.game_state import GameState
from monitor.log_monitor import LogMonitor
from safety.safety_manager import SafetyManager
from safety.verdict import SafetyLevel, SafetyVerdict

logger = logging.getLogger("kancolle_autopilot")

#: 要約時に一覧すると煩いイベント。
_QUIET_EVENTS = frozenset({EventType.PORT_REFRESHED})

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

    args = parser.parse_args(argv)

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
    return command_replay(args, config)


if __name__ == "__main__":
    raise SystemExit(main())

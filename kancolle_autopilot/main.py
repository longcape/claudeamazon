"""保存済み kcsapi ログを再生して、状態再構築と安全判定を確認する CLI。

Phase 1 のマイルストーン（開発指示書 §24）を人間が目視で検証するための
入口。**読み取り専用**で、ゲームへの接続も GUI 操作も行わない。

Usage:
    python main.py --log tests/fixtures/port.json
    python main.py --log path/to/kcsapi_dir --config config.json
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Iterator

from core.config_manager import ConfigError, ConfigManager
from monitor.api_parser import APIParser, Event, EventType
from monitor.game_state import GameState
from safety.resource_guard import ResourceGuard, ResourceThresholds

logger = logging.getLogger("kancolle_autopilot")

#: 状態へ反映されず、要約時に一覧すると煩いイベント。
_QUIET_EVENTS = frozenset({EventType.PORT_REFRESHED})


def iter_records(path: Path) -> Iterator[Any]:
    """ログのパスからレコードを 1 件ずつ取り出す。

    次の形式に対応する。

    * 単一の JSON オブジェクト（レコード 1 件）
    * JSON 配列（レコード複数件）
    * JSON Lines（1 行 1 レコード）
    * 上記ファイルを含むディレクトリ（名前順）

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
            for record in json.loads(text):
                yield record
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


def replay(path: Path) -> tuple[GameState, list[Event]]:
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
        derived.extend(state.apply_all(events))

    logger.info("%d 件のイベントを適用しました", count)
    return state, derived


def render(state: GameState, derived: list[Event], guard: ResourceGuard) -> str:
    """再構築した状態と安全判定を人間向けに整形する。"""
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
            f"{ship.damage_state.label} {lock}"
        )

    lines.append("== 艦隊 ==")
    for fleet in sorted(state.fleets.values(), key=lambda f: f.fleet_id):
        mission = (
            f" 遠征{fleet.mission.mission_id}" if fleet.mission.is_active else ""
        )
        lines.append(f"  第{fleet.fleet_id}艦隊 {fleet.ship_ids}{mission}")

    if state.sortie is not None:
        status = "出撃中" if state.sortie.is_active else "終了"
        lines.append(f"== 出撃 ==\n  {state.sortie.map_label} ({status})")

    if state.last_drop is not None:
        drop = state.last_drop
        judgement = {True: "未所持", False: "所持済み", None: "判定不能"}[drop.is_new]
        lines.append(f"== 直近ドロップ ==\n  {drop.name} ({judgement})")

    notable = [event for event in derived if event.type not in _QUIET_EVENTS]
    if notable:
        lines.append("== 派生イベント ==")
        for event in notable:
            lines.append(f"  {event.type.value}: {dict(event.payload)}")

    verdict = guard.check(state.resources)
    lines.append("== 安全判定 ==")
    lines.append(f"  レベル: {verdict.level.name}")
    for reason in verdict.reasons:
        lines.append(f"  - {reason}")

    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    """エントリポイント。

    Returns:
        終了コード。安全判定が STOP なら 2、入力エラーなら 1。
    """
    arg_parser = argparse.ArgumentParser(description=__doc__)
    arg_parser.add_argument(
        "--log", required=True, help="kcsapi ログのファイルまたはディレクトリ"
    )
    arg_parser.add_argument("--config", default="config.json", help="設定ファイル")
    arg_parser.add_argument(
        "--verbose", action="store_true", help="デバッグログを出力する"
    )
    args = arg_parser.parse_args(argv)

    try:
        config = ConfigManager(args.config).load()
    except ConfigError as exc:
        print(f"設定エラー: {exc}", file=sys.stderr)
        return 1

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else config.get("logging.level", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    log_path = Path(args.log)
    if not log_path.exists():
        print(f"ログが見つかりません: {log_path}", file=sys.stderr)
        return 1

    state, derived = replay(log_path)
    guard = ResourceGuard(ResourceThresholds.from_mapping(config.as_dict()["safety"]))
    print(render(state, derived, guard))

    return 2 if guard.check(state.resources).should_stop else 0


if __name__ == "__main__":
    raise SystemExit(main())

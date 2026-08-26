"""LogMonitor のテスト。"""

from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from tests.helpers import load_fixture
from monitor.api_parser import EventType
from monitor.log_monitor import LogMonitor, path_from_filename


@pytest.fixture
def port_body() -> dict:
    """母港応答の本文（レコードの body 部分）。"""
    return load_fixture("port.json")["body"]


def write_jsonl(path: Path, records: list[dict]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


# -- ファイル名からのパス復元 ---------------------------------------------


@pytest.mark.parametrize(
    "name, expected",
    [
        ("api_port@port.json", "api_port/port"),
        ("api_get_member@material.json", "api_get_member/material"),
        ("20240101_api_port@port.json", "20240101_api_port/port"),
        ("plain.json", ""),
    ],
)
def test_path_from_filename(name, expected) -> None:
    assert path_from_filename(name) == expected


# -- 基本動作 -------------------------------------------------------------


def test_missing_directory_returns_no_events(tmp_path: Path) -> None:
    """監視先が無くても落ちない。"""
    assert LogMonitor(tmp_path / "absent").poll() == []


def test_new_file_is_picked_up(tmp_path: Path, port_body: dict) -> None:
    monitor = LogMonitor(tmp_path)
    assert monitor.poll() == []  # 初回走査（空ディレクトリ）

    write_jsonl(tmp_path / "kcsapi.jsonl", [{"path": "api_port/port", "body": port_body}])
    events = monitor.poll()
    assert EventType.RESOURCE_UPDATED in {event.type for event in events}


def test_existing_files_are_skipped_by_default(
    tmp_path: Path, port_body: dict
) -> None:
    """起動時に既にあったログは再生しない（古い状態を作らないため）。"""
    write_jsonl(tmp_path / "kcsapi.jsonl", [{"path": "api_port/port", "body": port_body}])
    monitor = LogMonitor(tmp_path)
    assert monitor.poll() == []
    assert monitor.tracked_files == 1


def test_read_existing_replays_old_logs(tmp_path: Path, port_body: dict) -> None:
    write_jsonl(tmp_path / "kcsapi.jsonl", [{"path": "api_port/port", "body": port_body}])
    monitor = LogMonitor(tmp_path, read_existing=True)
    assert monitor.poll() != []


def test_appended_lines_are_read_incrementally(
    tmp_path: Path, port_body: dict
) -> None:
    log = tmp_path / "kcsapi.jsonl"
    monitor = LogMonitor(tmp_path)
    monitor.poll()

    write_jsonl(log, [{"path": "api_port/port", "body": port_body}])
    first = monitor.poll()
    assert first

    # 追記が無ければ再読み込みしない。
    assert monitor.poll() == []

    write_jsonl(log, [load_fixture("map_start.json")])
    second = monitor.poll()
    assert [event.type for event in second] == [EventType.SORTIE_STARTED]


def test_partial_line_is_deferred(tmp_path: Path, port_body: dict) -> None:
    """改行で終わっていない行は書き込み途中とみなして持ち越す。"""
    log = tmp_path / "kcsapi.jsonl"
    log.write_text("", encoding="utf-8")
    monitor = LogMonitor(tmp_path)
    monitor.poll()

    record = json.dumps({"path": "api_req_map/start", "body": load_fixture("map_start.json")["body"]})
    with log.open("a", encoding="utf-8") as handle:
        handle.write(record[:20])
    assert monitor.poll() == []

    with log.open("a", encoding="utf-8") as handle:
        handle.write(record[20:] + "\n")
    assert [event.type for event in monitor.poll()] == [EventType.SORTIE_STARTED]


def test_truncation_restarts_from_beginning(
    tmp_path: Path, port_body: dict
) -> None:
    """ローテートされたら先頭から読み直す。"""
    log = tmp_path / "kcsapi.jsonl"
    monitor = LogMonitor(tmp_path)
    monitor.poll()
    write_jsonl(log, [{"path": "api_port/port", "body": port_body}])
    assert monitor.poll()

    log.write_text("", encoding="utf-8")
    monitor.poll()
    write_jsonl(log, [load_fixture("map_start.json")])
    assert [event.type for event in monitor.poll()] == [EventType.SORTIE_STARTED]


def test_whole_file_log_uses_filename_as_path(tmp_path: Path, port_body: dict) -> None:
    """1 ファイル 1 レコード形式で、パスをファイル名から補う。"""
    monitor = LogMonitor(tmp_path)
    monitor.poll()
    (tmp_path / "api_port@port.json").write_text(
        json.dumps(port_body, ensure_ascii=False), encoding="utf-8"
    )
    events = monitor.poll()
    assert EventType.SHIP_UPDATED in {event.type for event in events}


def test_broken_json_does_not_stop_monitoring(
    tmp_path: Path, port_body: dict
) -> None:
    """壊れた行があっても後続を処理し続ける（§6）。"""
    log = tmp_path / "kcsapi.jsonl"
    monitor = LogMonitor(tmp_path)
    monitor.poll()

    with log.open("a", encoding="utf-8") as handle:
        handle.write("{ broken json\n")
        handle.write(json.dumps({"path": "api_port/port", "body": port_body}) + "\n")

    events = monitor.poll()
    assert EventType.RESOURCE_UPDATED in {event.type for event in events}


def test_unmatched_patterns_are_ignored(tmp_path: Path, port_body: dict) -> None:
    monitor = LogMonitor(tmp_path)
    monitor.poll()
    (tmp_path / "notes.txt").write_text("ignored", encoding="utf-8")
    assert monitor.poll() == []
    assert monitor.tracked_files == 0


# -- 常駐ループ -----------------------------------------------------------


def test_run_stops_on_event(tmp_path: Path, port_body: dict) -> None:
    """stop イベントでループを抜ける。"""
    write_jsonl(tmp_path / "kcsapi.jsonl", [{"path": "api_port/port", "body": port_body}])
    monitor = LogMonitor(tmp_path, read_existing=True)
    stop = threading.Event()
    received: list[list] = []

    def collect(events):
        received.append(events)
        stop.set()

    monitor.run(collect, interval=0.01, stop=stop)
    assert len(received) == 1


def test_run_survives_callback_error(tmp_path: Path, port_body: dict) -> None:
    """コールバックが例外を投げても監視ループを止めない。"""
    write_jsonl(tmp_path / "kcsapi.jsonl", [{"path": "api_port/port", "body": port_body}])
    monitor = LogMonitor(tmp_path, read_existing=True)
    stop = threading.Event()
    calls: list[int] = []

    def explode(events):
        calls.append(1)
        stop.set()
        raise RuntimeError("callback failed")

    monitor.run(explode, interval=0.01, stop=stop)
    assert calls == [1]

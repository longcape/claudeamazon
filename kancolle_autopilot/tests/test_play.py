"""サンドボックスを手で操作する部分のテスト。"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request

import pytest

from automation.interface import Screen
from automation.screen_detector import LAYOUT
from viz.server import create_server
from viz.service import SandboxService


def region_center(screen: Screen, prefix: str, index: str | None = None):
    """配置表から中心点を引く。"""
    entry = LAYOUT[(screen, prefix)]
    region = entry.resolve(index or "")
    assert region is not None
    return region.center


@pytest.fixture
def service() -> SandboxService:
    return SandboxService(seed=11)


# ======================================================================
# 操作
# ======================================================================


def test_initial_snapshot(service: SandboxService) -> None:
    snap = service.snapshot()
    assert snap["screen"] == "HOME"
    assert len(snap["state"]["艦"]) == 6
    assert snap["safety"]["level"] == "OK"
    assert any(w["name"] == "sortie_button" for w in snap["widgets"])


def test_click_moves_the_screen(service: SandboxService) -> None:
    point = region_center(Screen.HOME, "sortie_button")
    snap = service.click(point.x, point.y)
    assert snap["screen"] == "SORTIE_SELECT"
    assert "sortie_button" in snap["log"][-1]


def test_missed_click_is_reported(service: SandboxService) -> None:
    """外したことを、前回押したものと取り違えない。"""
    point = region_center(Screen.HOME, "sortie_button")
    service.click(point.x, point.y)
    snap = service.click(2, 2)
    assert "どのウィジェットにも当たりません" in snap["log"][-1]


def test_game_rejection_is_surfaced(service: SandboxService) -> None:
    """選ばずに出撃を押すと、ゲームが断る。"""
    home = region_center(Screen.HOME, "sortie_button")
    service.click(home.x, home.y)
    start = region_center(Screen.SORTIE_SELECT, "sortie_start")
    snap = service.click(start.x, start.y)

    assert "海域または艦隊が選ばれていません" in snap["log"][-1]
    assert snap["game"]["出撃"] is None


def test_manual_sortie_by_clicking(service: SandboxService) -> None:
    """人間が座標を押すだけで出撃まで到達する。"""
    steps = [
        region_center(Screen.HOME, "sortie_button"),
        region_center(Screen.SORTIE_SELECT, "area", "1"),
        region_center(Screen.SORTIE_SELECT, "map", "5"),
        region_center(Screen.SORTIE_SELECT, "fleet", "1"),
        region_center(Screen.SORTIE_SELECT, "sortie_start"),
    ]
    snap = service.snapshot()
    for point in steps:
        snap = service.click(point.x, point.y)

    assert snap["screen"] == "SORTIE_MAP"
    assert snap["game"]["出撃"] == "1-5"
    assert snap["game"]["直近戦闘"]  # 到着したマスで戦っている
    assert snap["selection"] == {"area": 1, "map": 5, "fleet": 1}


def test_cursor_follows_the_click(service: SandboxService) -> None:
    point = region_center(Screen.HOME, "quest_button")
    snap = service.click(point.x, point.y)
    assert snap["cursor"] == {"x": point.x, "y": point.y}


# ======================================================================
# AI に任せる
# ======================================================================


def test_run_task(service: SandboxService) -> None:
    snap = service.run_task("sortie", {"map": "1-5", "fleet_id": 1})
    assert "sortie: 成功" in snap["log"][-1]
    assert snap["game"]["戦果"] > 0


def test_run_task_with_bad_payload(service: SandboxService) -> None:
    snap = service.run_task("sortie", {})
    assert "組み立てられません" in snap["log"][-1]


def test_enqueue_then_tick(service: SandboxService) -> None:
    snap = service.enqueue("supply", {"fleet_id": 1})
    assert snap["queue"]

    snap = service.tick()
    assert snap["queue"] == []
    assert "supply" in snap["log"][-1]


def test_command(service: SandboxService) -> None:
    assert "資材:" in service.command("status")["log"][-1]


def test_unknown_command_is_refused(service: SandboxService) -> None:
    snap = service.command("1-5を回して")
    assert "自然言語の指示はここでは実行しません" in snap["log"][-1]


def test_reset(service: SandboxService) -> None:
    service.run_task("sortie", {"map": "1-5", "fleet_id": 1})
    snap = service.reset()
    assert snap["game"]["戦果"] == 0
    assert snap["screen"] == "HOME"


def test_report_reflects_the_session(service: SandboxService) -> None:
    service.run_task("sortie", {"map": "1-5", "fleet_id": 1})
    html = service.report_html()
    assert "<!doctype html>" in html
    assert service.snapshot()["events"] > 0


# ======================================================================
# HTTP
# ======================================================================


@pytest.fixture
def server(service: SandboxService):
    """空きポートで起動したサーバ。"""
    httpd = create_server(service, port=0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    host, port = httpd.server_address
    yield f"http://{host}:{port}"
    httpd.shutdown()
    httpd.server_close()


def get(base: str, path: str) -> str:
    return urllib.request.urlopen(base + path).read().decode("utf-8")


def post(base: str, path: str, body: dict) -> dict:
    request = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(request).read())


def test_server_serves_the_page(server: str) -> None:
    page = get(server, "/")
    assert "サンドボックス操作" in page
    assert 'src="http' not in page  # 外部の読み込みが無い


def test_server_state_endpoint(server: str) -> None:
    assert json.loads(get(server, "/api/state"))["screen"] == "HOME"


def test_server_click_endpoint(server: str) -> None:
    point = region_center(Screen.HOME, "arsenal_button")
    assert post(server, "/api/click", {"x": point.x, "y": point.y})["screen"] == "ARSENAL"


def test_server_task_endpoint(server: str) -> None:
    snap = post(server, "/api/task", {"name": "supply", "payload": {"fleet_id": 1}})
    assert "supply" in snap["log"][-1]


def test_server_report_endpoint(server: str) -> None:
    assert "<!doctype html>" in get(server, "/report.html")


def test_server_rejects_bad_json(server: str) -> None:
    request = urllib.request.Request(
        server + "/api/click",
        data=b"{ broken",
        headers={"Content-Type": "application/json"},
    )
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(request)
    assert error.value.code == 400


def test_server_unknown_path(server: str) -> None:
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(server + "/nope")
    assert error.value.code == 404


def test_server_binds_locally_by_default(service: SandboxService) -> None:
    """外から叩ける状態を既定にしない。"""
    httpd = create_server(service, port=0)
    try:
        assert httpd.server_address[0] == "127.0.0.1"
    finally:
        httpd.server_close()

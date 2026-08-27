"""サンドボックス操作ページを配る小さな HTTP サーバ。

標準ライブラリだけで動く。**127.0.0.1 にしか bind しない。** 外から
叩けるようにする理由が無く、認証も無いため。

サーバはリクエストを :class:`~viz.service.SandboxService` へ渡すだけで、
ゲームの判断は一切持たない。
"""

from __future__ import annotations

import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from viz.page import PLAY_PAGE
from viz.service import SandboxService

logger = logging.getLogger(__name__)

#: 受け付ける本文の上限。
MAX_BODY = 64 * 1024


def make_handler(service: SandboxService) -> type[BaseHTTPRequestHandler]:
    """サービスに紐づいたハンドラを作る。"""

    routes: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
        "/api/state": lambda body: service.snapshot(),
        "/api/click": lambda body: service.click(body.get("x", 0), body.get("y", 0)),
        "/api/task": lambda body: service.run_task(
            str(body.get("name", "")), body.get("payload") or {}
        ),
        "/api/enqueue": lambda body: service.enqueue(
            str(body.get("name", "")), body.get("payload") or {}
        ),
        "/api/tick": lambda body: service.tick(),
        "/api/command": lambda body: service.command(str(body.get("text", ""))),
        "/api/reset": lambda body: service.reset(body.get("seed")),
    }

    class Handler(BaseHTTPRequestHandler):
        """操作ページと JSON API を返す。"""

        server_version = "KancolleSandbox/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:
            """既定の標準エラー出力ではなく logging へ流す。"""
            logger.debug("%s - %s", self.address_string(), fmt % args)

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
            self._send(
                status,
                json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8",
            )

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler の規約
            """ページ・レポート・状態を返す。"""
            if self.path in ("/", "/index.html"):
                self._send(200, PLAY_PAGE.encode("utf-8"), "text/html; charset=utf-8")
                return
            if self.path == "/report.html":
                self._send(
                    200,
                    service.report_html().encode("utf-8"),
                    "text/html; charset=utf-8",
                )
                return
            if self.path == "/api/state":
                self._send_json(service.snapshot())
                return
            self._send_json({"error": "not found"}, 404)

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler の規約
            """操作を受け付ける。"""
            handler = routes.get(self.path)
            if handler is None:
                self._send_json({"error": "not found"}, 404)
                return

            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                self._send_json({"error": "body too large"}, 413)
                return
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                self._send_json({"error": "invalid json"}, 400)
                return
            if not isinstance(body, dict):
                self._send_json({"error": "object required"}, 400)
                return

            try:
                self._send_json(handler(body))
            except Exception:  # noqa: BLE001 - 1 回の要求で落とさない
                logger.exception("要求の処理に失敗しました: %s", self.path)
                self._send_json({"error": "internal error"}, 500)

    return Handler


def create_server(
    service: SandboxService, port: int = 8765, host: str = "127.0.0.1"
) -> ThreadingHTTPServer:
    """サーバを作る（まだ動かさない）。

    Args:
        service: 操作対象。
        port: 待ち受けポート。``0`` なら空きを自動で選ぶ。
        host: 待ち受けアドレス。既定は自ホストのみ。
    """
    return ThreadingHTTPServer((host, port), make_handler(service))


def serve(seed: int = 0, port: int = 8765, host: str = "127.0.0.1") -> None:
    """サーバを起動して待ち受ける（Ctrl-C で終了）。"""
    service = SandboxService(seed=seed)
    server = create_server(service, port, host)
    address = server.server_address
    print(f"サンドボックスを http://{address[0]}:{address[1]}/ で開けます")
    print("  Ctrl-C で終了します")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了します")
    finally:
        server.server_close()

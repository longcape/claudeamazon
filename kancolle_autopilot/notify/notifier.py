"""通知の送信手段。

Discord Webhook への送信は標準ライブラリだけで行う（依存を増やさない）。
画像を添付する場合は multipart/form-data、それ以外は JSON。

**通知の失敗で稼働を止めない。** 送れなかったことはログに残すが、
例外は外へ出さない。通知は運用の補助であって、送れないことがゲームの
安全に影響するわけではない。逆に、通知の失敗で本体が落ちると、
止まってほしくない場面で止まる。
"""

from __future__ import annotations

import json
import logging
import mimetypes
import urllib.error
import urllib.request
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

from notify.message import Notification

logger = logging.getLogger(__name__)

#: 送信のタイムアウト（秒）。
DEFAULT_TIMEOUT = 10.0


class Transport(ABC):
    """実際に HTTP を叩く部分。テストでは差し替える。"""

    @abstractmethod
    def post_json(self, url: str, payload: Mapping[str, Any]) -> None:
        """JSON を POST する。"""

    @abstractmethod
    def post_multipart(
        self,
        url: str,
        payload: Mapping[str, Any],
        files: Sequence[Path],
    ) -> None:
        """ファイル付きで POST する。"""


@dataclass
class UrllibTransport(Transport):
    """標準ライブラリで HTTP を叩く。"""

    timeout: float = DEFAULT_TIMEOUT

    def post_json(self, url: str, payload: Mapping[str, Any]) -> None:
        """JSON を POST する。

        Raises:
            urllib.error.URLError: 送信に失敗した場合。
        """
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            url, data=data, headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(request, timeout=self.timeout):
            pass

    def post_multipart(
        self,
        url: str,
        payload: Mapping[str, Any],
        files: Sequence[Path],
    ) -> None:
        """``payload_json`` とファイルを multipart で POST する。

        Raises:
            urllib.error.URLError: 送信に失敗した場合。
            OSError: ファイルを読めない場合。
        """
        boundary = f"----kancolle{uuid.uuid4().hex}"
        body = bytearray()

        body.extend(_part_header(boundary, "payload_json"))
        body.extend(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        body.extend(b"\r\n")

        for index, path in enumerate(files):
            content_type = (
                mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            )
            body.extend(
                _part_header(
                    boundary,
                    f"files[{index}]",
                    filename=path.name,
                    content_type=content_type,
                )
            )
            body.extend(path.read_bytes())
            body.extend(b"\r\n")

        body.extend(f"--{boundary}--\r\n".encode("utf-8"))

        request = urllib.request.Request(
            url,
            data=bytes(body),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        with urllib.request.urlopen(request, timeout=self.timeout):
            pass


def _part_header(
    boundary: str,
    name: str,
    filename: str | None = None,
    content_type: str | None = None,
) -> bytes:
    """multipart の 1 パートのヘッダを組み立てる。"""
    disposition = f'form-data; name="{name}"'
    if filename is not None:
        disposition += f'; filename="{filename}"'
    lines = [f"--{boundary}", f"Content-Disposition: {disposition}"]
    if content_type is not None:
        lines.append(f"Content-Type: {content_type}")
    lines.append("")
    lines.append("")
    return "\r\n".join(lines).encode("utf-8")


class Notifier(ABC):
    """通知の送り先。"""

    @property
    @abstractmethod
    def enabled(self) -> bool:
        """実際に送るなら ``True``。"""

    @abstractmethod
    def send(self, notification: Notification) -> bool:
        """1 件送る。

        Returns:
            送れたら ``True``。失敗しても例外は出さず ``False`` を返す。
        """


class NullNotifier(Notifier):
    """何も送らない。通知を切っているときの既定。"""

    @property
    def enabled(self) -> bool:
        """常に ``False``。"""
        return False

    def send(self, notification: Notification) -> bool:
        """ログにだけ残す。"""
        logger.debug("通知は無効です: %s", notification.describe())
        return False


@dataclass
class ConsoleNotifier(Notifier):
    """標準出力へ書く。Webhook を設定していないときの確認用。"""

    sent: list[Notification] = field(default_factory=list)

    @property
    def enabled(self) -> bool:
        """常に ``True``。"""
        return True

    def send(self, notification: Notification) -> bool:
        """表示して記録する。"""
        self.sent.append(notification)
        print(notification.to_text(), flush=True)
        return True


@dataclass
class WebhookNotifier(Notifier):
    """Discord Webhook へ送る。

    Args:
        url: Webhook の URL。空なら無効。
        transport: HTTP を叩く実体。
    """

    url: str
    transport: Transport = field(default_factory=UrllibTransport)
    #: 送信に成功した件数。
    sent_count: int = 0
    #: 送信に失敗した件数。
    failed_count: int = 0

    @property
    def enabled(self) -> bool:
        """URL が設定されていれば ``True``。"""
        return bool(self.url)

    def send(self, notification: Notification) -> bool:
        """通知を送る。失敗しても例外は出さない。"""
        if not self.enabled:
            logger.debug("Webhook URL が未設定です: %s", notification.describe())
            return False

        payload = notification.to_discord_payload()
        image = notification.image_path
        try:
            if image is not None and image.exists():
                self.transport.post_multipart(self.url, payload, [image])
            else:
                if image is not None:
                    logger.warning("添付画像が見つかりません: %s", image)
                    payload = notification.to_discord_payload()
                    payload["embeds"][0].pop("image", None)
                self.transport.post_json(self.url, payload)
        except (urllib.error.URLError, OSError, ValueError) as exc:
            # 通知の失敗で稼働を止めない。
            self.failed_count += 1
            logger.error("通知を送れませんでした: %s: %s", notification.describe(), exc)
            return False

        self.sent_count += 1
        logger.info("通知を送りました: %s", notification.describe())
        return True


@dataclass
class RecordingNotifier(Notifier):
    """送らずに記録するだけ。テスト用。"""

    sent: list[Notification] = field(default_factory=list)
    should_fail: bool = False

    @property
    def enabled(self) -> bool:
        """常に ``True``。"""
        return True

    def send(self, notification: Notification) -> bool:
        """記録する。``should_fail`` なら失敗を返す。"""
        if self.should_fail:
            return False
        self.sent.append(notification)
        return True

    def kinds(self) -> list[str]:
        """送った通知の種類を並べる。"""
        return [notification.kind.value for notification in self.sent]


def build_notifier(
    enabled: bool, webhook_url: str, transport: Transport | None = None
) -> Notifier:
    """設定から通知先を組み立てる。

    Args:
        enabled: ``config["discord"]["enabled"]``。
        webhook_url: Webhook の URL。
        transport: 差し替える HTTP 実装。

    Returns:
        通知先。無効なら :class:`NullNotifier`。
    """
    if not enabled:
        return NullNotifier()
    if not webhook_url:
        logger.warning("通知が有効ですが Webhook URL がありません")
        return NullNotifier()
    return WebhookNotifier(webhook_url, transport or UrllibTransport())

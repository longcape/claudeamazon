"""Notification / Notifier のテスト。"""

from __future__ import annotations

import json
import urllib.error
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

import pytest

from notify.message import Notification, NotificationKind, NotificationLevel
from notify.notifier import (
    NullNotifier,
    RecordingNotifier,
    Transport,
    WebhookNotifier,
    build_notifier,
)

T0 = datetime(2024, 5, 2, 10, 52, tzinfo=timezone.utc)


@dataclass
class RecordingTransport(Transport):
    """送信内容を記録するだけの Transport。"""

    json_calls: list[tuple[str, Mapping[str, Any]]] = field(default_factory=list)
    multipart_calls: list[tuple[str, Mapping[str, Any], list[Path]]] = field(
        default_factory=list
    )
    error: Exception | None = None

    def post_json(self, url: str, payload: Mapping[str, Any]) -> None:
        if self.error is not None:
            raise self.error
        self.json_calls.append((url, payload))

    def post_multipart(
        self, url: str, payload: Mapping[str, Any], files: Sequence[Path]
    ) -> None:
        if self.error is not None:
            raise self.error
        self.multipart_calls.append((url, payload, list(files)))


# ======================================================================
# 通知の中身
# ======================================================================


def test_default_levels_match_severity() -> None:
    assert NotificationKind.SAFETY_STOP.default_level is NotificationLevel.CRITICAL
    assert NotificationKind.TASK_COMPLETED.default_level is NotificationLevel.INFO


def test_explicit_level_overrides_default() -> None:
    notification = Notification(
        NotificationKind.TASK_COMPLETED, "x", level=NotificationLevel.CRITICAL
    )
    assert notification.severity is NotificationLevel.CRITICAL


def test_dedupe_key_separates_targets() -> None:
    first = Notification(NotificationKind.DAMAGE_DETECTED, "a", dedupe_hint="101")
    second = Notification(NotificationKind.DAMAGE_DETECTED, "a", dedupe_hint="102")
    assert first.dedupe_key != second.dedupe_key


def test_to_text_includes_fields() -> None:
    text = Notification(
        NotificationKind.RESOURCE_LOW, "資材不足", fields={"燃料": "900"}
    ).to_text()
    assert "RESOURCE LOW" in text
    assert "燃料: 900" in text


def test_discord_payload_shape() -> None:
    payload = Notification(
        NotificationKind.SAFETY_STOP,
        "停止",
        body="理由",
        fields={"燃料": "900"},
        at=T0,
    ).to_discord_payload()

    embed = payload["embeds"][0]
    assert embed["title"].startswith("SAFETY STOP")
    assert embed["description"] == "理由"
    assert embed["fields"][0] == {"name": "燃料", "value": "900", "inline": True}
    assert embed["color"] == NotificationLevel.CRITICAL.color


def test_discord_payload_references_attachment(tmp_path: Path) -> None:
    image = tmp_path / "shot.png"
    payload = Notification(
        NotificationKind.NEW_DROP_PROTECTED, "ドロップ", image_path=image
    ).to_discord_payload()
    assert payload["embeds"][0]["image"]["url"] == "attachment://shot.png"


# ======================================================================
# 送信
# ======================================================================


def test_null_notifier_sends_nothing() -> None:
    notifier = NullNotifier()
    assert notifier.enabled is False
    assert notifier.send(Notification(NotificationKind.TASK_COMPLETED, "x")) is False


def test_webhook_posts_json() -> None:
    transport = RecordingTransport()
    notifier = WebhookNotifier("https://example.invalid/hook", transport)

    assert notifier.send(Notification(NotificationKind.TASK_COMPLETED, "完了")) is True
    assert transport.json_calls[0][0] == "https://example.invalid/hook"
    assert notifier.sent_count == 1


def test_webhook_without_url_is_disabled() -> None:
    notifier = WebhookNotifier("", RecordingTransport())
    assert notifier.enabled is False
    assert notifier.send(Notification(NotificationKind.TASK_COMPLETED, "x")) is False


def test_webhook_posts_multipart_when_image_exists(tmp_path: Path) -> None:
    image = tmp_path / "shot.png"
    image.write_bytes(b"fake png")
    transport = RecordingTransport()
    notifier = WebhookNotifier("https://example.invalid/hook", transport)

    notifier.send(
        Notification(NotificationKind.NEW_DROP_PROTECTED, "保護", image_path=image)
    )
    assert transport.multipart_calls[0][2] == [image]
    assert transport.json_calls == []


def test_missing_image_falls_back_to_text(tmp_path: Path) -> None:
    """添付が見つからなくても、通知そのものは落とさない。"""
    transport = RecordingTransport()
    notifier = WebhookNotifier("https://example.invalid/hook", transport)

    assert notifier.send(
        Notification(
            NotificationKind.NEW_DROP_PROTECTED,
            "保護",
            image_path=tmp_path / "absent.png",
        )
    ) is True
    assert transport.json_calls
    assert "image" not in transport.json_calls[0][1]["embeds"][0]


def test_send_failure_does_not_raise() -> None:
    """通知の失敗で稼働を止めない。"""
    transport = RecordingTransport(error=urllib.error.URLError("network down"))
    notifier = WebhookNotifier("https://example.invalid/hook", transport)

    assert notifier.send(Notification(NotificationKind.SAFETY_STOP, "停止")) is False
    assert notifier.failed_count == 1


def test_send_failure_on_os_error(tmp_path: Path) -> None:
    image = tmp_path / "shot.png"
    image.write_bytes(b"x")
    transport = RecordingTransport(error=OSError("disk"))
    notifier = WebhookNotifier("https://example.invalid/hook", transport)
    assert notifier.send(
        Notification(NotificationKind.SAFETY_STOP, "停止", image_path=image)
    ) is False


def test_recording_notifier_collects() -> None:
    notifier = RecordingNotifier()
    notifier.send(Notification(NotificationKind.TASK_FAILED, "失敗"))
    assert notifier.kinds() == ["TASK FAILED"]


# ======================================================================
# 組み立て
# ======================================================================


def test_build_notifier_disabled() -> None:
    assert isinstance(build_notifier(False, "https://x.invalid"), NullNotifier)


def test_build_notifier_without_url() -> None:
    assert isinstance(build_notifier(True, ""), NullNotifier)


def test_build_notifier_enabled() -> None:
    notifier = build_notifier(True, "https://x.invalid", RecordingTransport())
    assert isinstance(notifier, WebhookNotifier)
    assert notifier.enabled is True


# ======================================================================
# multipart の組み立て
# ======================================================================


def test_multipart_body_contains_payload_and_file(tmp_path: Path) -> None:
    """実際に送るバイト列の形を確かめる。"""
    from notify.notifier import UrllibTransport

    image = tmp_path / "shot.png"
    image.write_bytes(b"PNGDATA")

    captured: dict[str, Any] = {}

    class FakeOpener:
        def __init__(self, request, timeout=None):
            captured["body"] = request.data
            captured["headers"] = request.headers

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    import urllib.request

    original = urllib.request.urlopen
    urllib.request.urlopen = FakeOpener  # type: ignore[assignment]
    try:
        UrllibTransport().post_multipart(
            "https://example.invalid/hook", {"embeds": []}, [image]
        )
    finally:
        urllib.request.urlopen = original  # type: ignore[assignment]

    body = captured["body"]
    assert b'name="payload_json"' in body
    assert b'filename="shot.png"' in body
    assert b"PNGDATA" in body
    assert body.endswith(b"--\r\n")

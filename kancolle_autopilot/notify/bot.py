"""Discord から管理コマンドを受ける常駐部分。

開発指示書 §17 の入口。受け取った文字列は
:class:`~notify.commands.CommandHandler` へ渡すだけで、**ここで解釈しない**。
自然言語をそのまま実行しないという方針は入口が変わっても同じ。

安全のための決めごとが 2 つある。

* **許可した相手からのコマンドしか実行しない。** ``allowed_user_ids`` が
  空なら誰からも受け付けない。停止・再開・タスク取り消しが誰でも押せる
  状態を、設定漏れで作らないため。
* **指定したチャンネル以外は無視する。** 別の場所で偶然同じ語を書いた人が
  システムを止められては困る。

Discord への接続は :class:`DiscordGateway` の裏に隠してある。テストでは
:class:`LoopbackGateway` を使い、``discord`` パッケージも通信も要らない。
"""

from __future__ import annotations

import logging
import queue as queue_module
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Callable, Sequence

logger = logging.getLogger(__name__)

#: コマンドを受け付けられなかったときの返答。
REFUSAL_UNKNOWN_USER = "このユーザーからのコマンドは受け付けていません。"
REFUSAL_NO_ALLOWLIST = (
    "コマンドを受け付ける相手が設定されていません"
    "（discord.allowed_user_ids）。"
)


@dataclass
class CommandChannel:
    """受け取ったコマンドと、返す先をつなぐ。

    受信は別スレッド、実行は常駐ループ、という非同期なやり取りになるので、
    間にキューを挟む。
    """

    _pending: queue_module.Queue = field(default_factory=queue_module.Queue)
    _reply_to: Callable[[str], None] | None = None

    def bind_reply(self, sink: Callable[[str], None]) -> None:
        """返答の送り先を設定する。"""
        self._reply_to = sink

    def submit(self, text: str) -> None:
        """コマンドを受け付ける（受信側から呼ぶ）。"""
        line = text.strip()
        if line:
            self._pending.put(line)

    def drain(self) -> list[str]:
        """溜まっているコマンドを取り出す（常駐ループから呼ぶ）。"""
        lines: list[str] = []
        while True:
            try:
                lines.append(self._pending.get_nowait())
            except queue_module.Empty:
                break
        return lines

    def reply(self, text: str) -> None:
        """返答を送る。送り先が無ければログに残すだけ。"""
        if self._reply_to is None:
            logger.info("返答（送り先なし）:\n%s", text)
            return
        try:
            self._reply_to(text)
        except Exception:  # noqa: BLE001 - 返答の失敗で稼働を止めない
            logger.exception("返答を送れませんでした")


class DiscordGateway(ABC):
    """Discord との接続。"""

    @abstractmethod
    def start(self, on_message: Callable[[str, str], None]) -> None:
        """接続を開始する。

        Args:
            on_message: ``(送信者 ID, 本文)`` を受け取る関数。
        """

    @abstractmethod
    def send(self, text: str) -> None:
        """チャンネルへ送る。"""

    @abstractmethod
    def stop(self) -> None:
        """接続を終える。"""


@dataclass
class LoopbackGateway(DiscordGateway):
    """通信しない実装。テストと動作確認用。"""

    sent: list[str] = field(default_factory=list)
    _handler: Callable[[str, str], None] | None = field(default=None, init=False)
    started: bool = field(default=False, init=False)

    def start(self, on_message: Callable[[str, str], None]) -> None:
        """受信ハンドラを覚える。"""
        self._handler = on_message
        self.started = True

    def send(self, text: str) -> None:
        """送信内容を記録する。"""
        self.sent.append(text)

    def stop(self) -> None:
        """接続を終える。"""
        self.started = False

    def deliver(self, author_id: str, text: str) -> None:
        """メッセージが届いたことにする（テストから呼ぶ）。"""
        if self._handler is None:
            raise RuntimeError("start されていません")
        self._handler(author_id, text)


@dataclass
class DiscordPyGateway(DiscordGateway):
    """``discord.py`` を使う実装。

    別スレッドでイベントループを回す。常駐ループは同期的に動くので、
    そちらを非同期化するより、接続側を切り離すほうが影響が小さい。

    Note:
        ``message_content`` は特権インテント。Discord の開発者ポータルで
        有効にしておかないと本文が空で届く。
    """

    token: str
    channel_id: int
    _client: object | None = field(default=None, init=False)
    _thread: threading.Thread | None = field(default=None, init=False)
    _ready: threading.Event = field(default_factory=threading.Event, init=False)

    def start(self, on_message: Callable[[str, str], None]) -> None:
        """接続してメッセージを待つ。

        Raises:
            RuntimeError: ``discord`` パッケージが入っていない場合。
        """
        try:
            import discord
        except ImportError as exc:  # pragma: no cover - 環境依存
            raise RuntimeError(
                "discord.py が入っていません（pip install discord.py）"
            ) from exc

        # デコレータで定義するハンドラ名が discord.py 側で決まっているため、
        # 引数を別名で束縛してから使う。
        deliver = on_message

        intents = discord.Intents.default()
        intents.message_content = True
        client = discord.Client(intents=intents)
        self._client = client

        @client.event
        async def on_ready() -> None:  # pragma: no cover - 通信が要る
            logger.info("Discord へ接続しました: %s", client.user)
            self._ready.set()

        @client.event
        async def on_message(message) -> None:  # pragma: no cover - 通信が要る
            if message.author == client.user:
                return
            if message.channel.id != self.channel_id:
                return
            deliver(str(message.author.id), str(message.content))

        self._thread = threading.Thread(
            target=lambda: client.run(self.token), daemon=True
        )
        self._thread.start()

    def send(self, text: str) -> None:  # pragma: no cover - 通信が要る
        """チャンネルへ送る。"""
        import asyncio

        client = self._client
        if client is None:
            logger.warning("接続していないため送れません")
            return
        channel = client.get_channel(self.channel_id)
        if channel is None:
            logger.warning("チャンネルが見つかりません: %s", self.channel_id)
            return
        asyncio.run_coroutine_threadsafe(channel.send(text), client.loop)

    def stop(self) -> None:  # pragma: no cover - 通信が要る
        """接続を終える。"""
        import asyncio

        client = self._client
        if client is None:
            return
        asyncio.run_coroutine_threadsafe(client.close(), client.loop)


@dataclass
class CommandBot:
    """届いたメッセージを、許可を確かめてからキューへ流す。

    Args:
        gateway: Discord との接続。
        allowed_user_ids: コマンドを受け付けるユーザー ID。空なら誰からも
            受け付けない。
    """

    gateway: DiscordGateway
    channel: CommandChannel = field(default_factory=CommandChannel)
    allowed_user_ids: frozenset[str] = frozenset()
    #: 受け付けなかったメッセージの記録。
    rejected: list[tuple[str, str]] = field(default_factory=list)

    @classmethod
    def from_config(
        cls, discord_config: dict, gateway: DiscordGateway | None = None
    ) -> "CommandBot":
        """``config["discord"]`` から組み立てる。

        Raises:
            ValueError: bot として動かす設定が足りない場合。
        """
        token = str(discord_config.get("bot_token") or "")
        channel_id = str(discord_config.get("channel_id") or "")
        if gateway is None:
            if not token or not channel_id:
                raise ValueError(
                    "discord.bot_token と discord.channel_id が必要です"
                )
            gateway = DiscordPyGateway(token=token, channel_id=int(channel_id))
        return cls(
            gateway=gateway,
            allowed_user_ids=frozenset(
                str(entry) for entry in discord_config.get("allowed_user_ids") or ()
            ),
        )

    @property
    def has_allowlist(self) -> bool:
        """コマンドを受け付ける相手が設定されていれば ``True``。"""
        return bool(self.allowed_user_ids)

    def start(self) -> None:
        """接続を開始し、返答の送り先を設定する。"""
        if not self.has_allowlist:
            logger.warning(
                "コマンドを受け付ける相手が未設定です。すべて拒否します。"
            )
        self.channel.bind_reply(self.gateway.send)
        self.gateway.start(self.on_message)

    def stop(self) -> None:
        """接続を終える。"""
        self.gateway.stop()

    def on_message(self, author_id: str, text: str) -> None:
        """メッセージ 1 件を処理する。"""
        if not self.has_allowlist:
            self.rejected.append((author_id, text))
            self.gateway.send(REFUSAL_NO_ALLOWLIST)
            return
        if author_id not in self.allowed_user_ids:
            logger.warning("許可されていない相手からのコマンド: %s", author_id)
            self.rejected.append((author_id, text))
            self.gateway.send(REFUSAL_UNKNOWN_USER)
            return
        self.channel.submit(text)

    def drain(self) -> Sequence[str]:
        """溜まっているコマンドを取り出す。"""
        return self.channel.drain()

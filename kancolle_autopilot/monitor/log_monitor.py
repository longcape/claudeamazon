"""専ブラが出力する kcsapi ログのディレクトリを監視する。

開発指示書 §6 の担当。ポーリングで新規ファイル・追記を検出し、
:class:`~monitor.api_parser.APIParser` に渡してイベント列を返す。

設計上の判断:

* **ポーリングにする。** 外部依存（watchdog）を増やさず、Windows の
  ネットワークドライブや同期フォルダでも同じ挙動になる。
* **1 回の走査（:meth:`LogMonitor.poll`）を公開単位にする。** スレッドや
  ループを挟まずにテストできるようにするため。常駐は :meth:`run` が担う。
* **既定では起動時に過去ログを読まない。** 古いログを再生すると、
  実際とは違う状態を「現在の状態」として組み立ててしまう。読まない場合
  最初の母港応答までは状態不明のままだが、それは
  :meth:`~monitor.game_state.GameState.is_stale` と安全装置が扱う。
* **どんな入力でも例外を投げない。** 壊れた JSON、読めないファイル、
  途中まで書かれた行はすべてスキップして監視を続ける。
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Sequence

from monitor.api_parser import APIParser, Event, normalize_path

logger = logging.getLogger(__name__)

#: 監視対象とする拡張子の既定値。
DEFAULT_PATTERNS: tuple[str, ...] = ("*.json", "*.jsonl")

#: 1 行ずつ読む（追記型とみなす）拡張子。
_LINE_ORIENTED_SUFFIXES = frozenset({".jsonl", ".log", ".ndjson"})


def path_from_filename(name: str) -> str:
    """ファイル名から API パスを復元する。

    ``api_port@port.json`` のようにパス区切りを ``@`` へ置き換えて
    保存する専ブラがあるため、その形式を戻す。

    Args:
        name: ファイル名（ディレクトリを含まない）。

    Returns:
        ``"api_port/port"`` 形式のパス。復元できなければ空文字列。
    """
    stem = Path(name).stem
    if "@" in stem:
        return normalize_path(stem.replace("@", "/"))
    if "/" in stem:
        return normalize_path(stem)
    return ""


@dataclass
class FileCursor:
    """1 ファイルの読み取り位置。

    Attributes:
        offset: 次に読み始めるバイト位置（行指向ファイルのみ使用）。
        size: 最後に見たファイルサイズ。
        mtime: 最後に見た更新時刻。
    """

    offset: int = 0
    size: int = 0
    mtime: float = 0.0


@dataclass
class LogMonitor:
    """kcsapi ログのディレクトリを監視してイベントを生成する。

    Example:
        >>> monitor = LogMonitor("C:/poi/kcsapi", APIParser())
        >>> events = monitor.poll()
    """

    directory: str | os.PathLike[str]
    parser: APIParser = field(default_factory=APIParser)
    patterns: Sequence[str] = DEFAULT_PATTERNS
    read_existing: bool = False
    _cursors: dict[Path, FileCursor] = field(default_factory=dict, init=False)
    _primed: bool = field(default=False, init=False)

    @property
    def path(self) -> Path:
        """監視対象ディレクトリ。"""
        return Path(self.directory)

    @property
    def tracked_files(self) -> int:
        """現在追跡しているファイル数。"""
        return len(self._cursors)

    # ------------------------------------------------------------------
    # 走査
    # ------------------------------------------------------------------

    def poll(self) -> list[Event]:
        """ディレクトリを 1 回走査し、新しく現れた内容をイベント化する。

        Returns:
            検出したイベント。何も無ければ空リスト。
            ディレクトリが存在しない場合も空リスト（警告を残す）。
        """
        directory = self.path
        if not directory.is_dir():
            logger.warning("監視ディレクトリがありません: %s", directory)
            return []

        events: list[Event] = []
        for file_path in self._iter_files(directory):
            try:
                events.extend(self._consume(file_path))
            except OSError as exc:
                # 書き込み中のロックなどは次回の走査で拾えばよい。
                logger.warning("ログを読めません（スキップ）: %s: %s", file_path, exc)
            except Exception:  # noqa: BLE001 - 監視を止めない
                logger.exception("ログ処理で予期しない失敗: %s", file_path)

        if not self._primed:
            self._primed = True
            if not self.read_existing:
                logger.info(
                    "既存ログ %d 件を読み飛ばしました（末尾から監視します）",
                    len(self._cursors),
                )
        return events

    def run(
        self,
        on_events: Callable[[list[Event]], None],
        interval: float = 1.0,
        stop: threading.Event | None = None,
    ) -> None:
        """停止が指示されるまで走査を繰り返す。

        Args:
            on_events: 1 回の走査で得たイベントを受け取るコールバック。
                空リストのときは呼ばない。
            interval: 走査間隔（秒）。
            stop: 停止用イベント。``set()`` されるとループを抜ける。
        """
        stop = stop or threading.Event()
        logger.info("ログ監視を開始します: %s（間隔 %.1fs）", self.path, interval)
        while not stop.is_set():
            events = self.poll()
            if events:
                try:
                    on_events(events)
                except Exception:  # noqa: BLE001 - 監視ループを止めない
                    logger.exception("イベント処理に失敗しました")
            stop.wait(interval)
        logger.info("ログ監視を停止しました")

    # ------------------------------------------------------------------
    # 内部処理
    # ------------------------------------------------------------------

    def _iter_files(self, directory: Path) -> Iterable[Path]:
        """監視対象のファイルを名前順に返す。"""
        seen: set[Path] = set()
        for pattern in self.patterns:
            for candidate in directory.glob(pattern):
                if candidate.is_file():
                    seen.add(candidate)
        return sorted(seen)

    def _consume(self, file_path: Path) -> list[Event]:
        """1 ファイルの未読部分を読み取ってイベント化する。"""
        stat = file_path.stat()
        cursor = self._cursors.get(file_path)

        if cursor is None:
            cursor = FileCursor()
            self._cursors[file_path] = cursor
            if not self._primed and not self.read_existing:
                # 起動時に存在したファイルは末尾まで読んだことにする。
                cursor.offset = stat.st_size
                cursor.size = stat.st_size
                cursor.mtime = stat.st_mtime
                return []

        if stat.st_size < cursor.size:
            # ローテートまたは切り詰め。先頭から読み直す。
            logger.info("ログが切り詰められました。先頭から読み直します: %s", file_path)
            cursor.offset = 0

        if stat.st_size == cursor.size and stat.st_mtime == cursor.mtime:
            return []

        if file_path.suffix.lower() in _LINE_ORIENTED_SUFFIXES:
            events = self._consume_lines(file_path, cursor)
        else:
            events = self._consume_whole(file_path)

        cursor.size = stat.st_size
        cursor.mtime = stat.st_mtime
        return events

    def _consume_lines(self, file_path: Path, cursor: FileCursor) -> list[Event]:
        """追記型ファイルを行単位で読む。

        末尾が改行で終わっていない場合、その行はまだ書き込み途中と
        みなして次回に持ち越す。
        """
        default_path = path_from_filename(file_path.name)
        events: list[Event] = []
        # バイト位置で再開するため、テキストモードではなくバイナリで開く。
        # TextIOWrapper.seek は tell() が返した cookie しか受け付けない。
        with file_path.open("rb") as handle:
            handle.seek(cursor.offset)
            chunk = handle.read()

        consumed = 0
        for raw_line in chunk.splitlines(keepends=True):
            if not raw_line.endswith(b"\n"):
                break  # 書き込み途中の行。次回に持ち越す。
            consumed += len(raw_line)
            line = raw_line.decode("utf-8", errors="replace").strip()
            if line:
                events.extend(
                    self.parser.parse_record(line, default_path=default_path)
                )
        cursor.offset += consumed
        return events

    def _consume_whole(self, file_path: Path) -> list[Event]:
        """1 ファイル 1 レコードのログを丸ごと読む。"""
        text = file_path.read_text(encoding="utf-8", errors="replace").strip()
        if not text:
            return []
        return self.parser.parse_record(
            text, default_path=path_from_filename(file_path.name)
        )

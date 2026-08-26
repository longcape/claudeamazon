"""ファイルを壊さずに書き出すための共通処理。

設定・予約状態のように「途中まで書けた状態」が致命的になるファイルは、
同一ディレクトリへ一時ファイルを書いてから :func:`os.replace` で
差し替える。別ディレクトリの一時ファイルからでは atomic にならない。
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class PersistenceError(Exception):
    """ファイルの読み書きに失敗したことを表す。"""


def write_text_atomic(path: str | os.PathLike[str], text: str) -> None:
    """テキストを atomic に書き出す。

    Args:
        path: 書き出し先。親ディレクトリが無ければ作成する。
        text: 書き出す内容。

    Raises:
        PersistenceError: 書き出しに失敗した場合。
    """
    target = Path(path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        handle_fd, tmp_name = tempfile.mkstemp(
            prefix=target.name, suffix=".tmp", dir=target.parent
        )
        try:
            with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_name, target)
        except BaseException:
            # 失敗時に一時ファイルを残さない。
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
            raise
    except OSError as exc:
        raise PersistenceError(f"書き出しに失敗しました: {target}: {exc}") from exc


def write_json_atomic(path: str | os.PathLike[str], data: Any) -> None:
    """JSON を atomic に書き出す。

    Raises:
        PersistenceError: シリアライズまたは書き出しに失敗した場合。
    """
    try:
        text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    except (TypeError, ValueError) as exc:
        raise PersistenceError(f"JSON へ変換できません: {exc}") from exc
    write_text_atomic(path, text)


def read_json(path: str | os.PathLike[str]) -> Any | None:
    """JSON を読み込む。

    Returns:
        読み込んだ値。ファイルが無い場合は ``None``。

    Raises:
        PersistenceError: 読み込みまたは解析に失敗した場合。
    """
    source = Path(path)
    if not source.exists():
        return None
    try:
        return json.loads(source.read_text(encoding="utf-8"))
    except OSError as exc:
        raise PersistenceError(f"読み込みに失敗しました: {source}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise PersistenceError(f"JSON が不正です: {source}: {exc}") from exc

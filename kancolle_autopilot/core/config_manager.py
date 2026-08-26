"""config.json の読み込み・検証・保存を担う。

このモジュールは Phase 1 の最初に実装される。設定値をコードへ
ハードコードしないという開発方針を守るため、他モジュールは
すべて :class:`ConfigManager` 経由で設定値を取得する。

設計方針:

* スキーマ駆動。既知のキーのみを受け付け、未知のキーは
  エラーにする。設定ファイルの綴り間違いを黙って無視すると、
  たとえば ``min_fuel`` が効かないまま資源が枯渇する。
* 型チェックを行う。``bool`` は ``int`` のサブクラスなので、
  数値項目に ``true`` を書いた場合も検出する。
* 保存は atomic（同一ディレクトリへ一時ファイルを書いてから
  ``os.replace``）。書き込み途中で落ちても壊れた設定を残さない。
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from core.persistence import PersistenceError, write_json_atomic

logger = logging.getLogger(__name__)

DEFAULT_CONFIG_FILENAME = "config.json"


class ConfigError(Exception):
    """設定の読み込み・検証・保存に失敗したことを表す。"""


@dataclass(frozen=True)
class Field:
    """スキーマ上の 1 項目。

    Attributes:
        type: 期待する Python 型。
        default: 省略時に使用する既定値。
        minimum: 数値項目の下限（``None`` なら検査しない）。
        exclusive_minimum: ``True`` の場合、``minimum`` と等しい値も拒否する。
    """

    type: type
    default: Any
    minimum: float | None = None
    exclusive_minimum: bool = False
    #: ``type`` が ``list`` のときの要素の型。
    item_type: type | None = None


#: 設定スキーマ。ここに無いキーは受け付けない。
SCHEMA: Mapping[str, Mapping[str, Field]] = {
    "safety": {
        "min_fuel": Field(int, 1000, minimum=0),
        "min_ammo": Field(int, 1000, minimum=0),
        "min_steel": Field(int, 1000, minimum=0),
        "min_bauxite": Field(int, 1000, minimum=0),
        "min_buckets": Field(int, 20, minimum=0),
        "log_stale_seconds": Field(int, 300, minimum=0, exclusive_minimum=True),
        # 疲労の警告閾値。これ未満の cond を警告として扱う。
        "min_cond": Field(int, 30, minimum=0),
        # 解体候補として許容する最大レベル。
        "max_dismantle_level": Field(int, 1, minimum=1),
        # 入手が新しい順にこの隻数を保護する。
        "protect_newest_count": Field(int, 1, minimum=0),
        "blacklist_path": Field(str, "data/blacklist.json"),
    },
    "automation": {
        # 安全上、既定は必ず「自動操作無効・シミュレーション」。
        "enabled": Field(bool, False),
        "simulation_mode": Field(bool, True),
        "action_timeout_seconds": Field(
            int, 10, minimum=0, exclusive_minimum=True
        ),
    },
    "monitor": {
        "log_dir": Field(str, ""),
        "poll_interval_seconds": Field(
            float, 1.0, minimum=0.0, exclusive_minimum=True
        ),
        # 起動時に既存ログを読み直すか。既定は false（末尾から監視）。
        # true にすると古いログを再生して状態を作るため、実態とずれうる。
        "read_existing": Field(bool, False),
    },
    "scheduler": {
        "state_path": Field(str, "data/schedule.json"),
    },
    "discord": {
        "enabled": Field(bool, False),
        "webhook_url": Field(str, ""),
        # bot として常駐し、管理コマンドを受ける場合に使う。
        "bot_token": Field(str, ""),
        "channel_id": Field(str, ""),
        # コマンドを受け付けるユーザー ID。**空なら誰からも受け付けない。**
        "allowed_user_ids": Field(list, [], item_type=str),
    },
    "logging": {
        "level": Field(str, "INFO"),
        "jsonl_path": Field(str, ""),
    },
}

_VALID_LOG_LEVELS = frozenset(
    {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
)


def default_config() -> dict[str, dict[str, Any]]:
    """スキーマの既定値だけで構成した設定を返す。"""
    return {
        section: {name: field.default for name, field in fields.items()}
        for section, fields in SCHEMA.items()
    }


def _check_type(path: str, value: Any, expected: type) -> Any:
    """1 項目の型を検査し、必要なら正規化した値を返す。

    Raises:
        ConfigError: 型が一致しない場合。
    """
    # bool は int のサブクラスなので、数値項目より先に弾く。
    if expected is bool:
        if not isinstance(value, bool):
            raise ConfigError(f"{path}: bool が必要ですが {type(value).__name__} でした")
        return value

    if isinstance(value, bool):
        raise ConfigError(f"{path}: {expected.__name__} が必要ですが bool でした")

    if expected is list:
        if not isinstance(value, list):
            raise ConfigError(f"{path}: 配列が必要ですが {type(value).__name__} でした")
        return list(value)

    if expected is float:
        # JSON の 1 は int になるため、float 項目では受け入れて変換する。
        if isinstance(value, (int, float)):
            return float(value)
        raise ConfigError(f"{path}: 数値が必要ですが {type(value).__name__} でした")

    if not isinstance(value, expected):
        raise ConfigError(
            f"{path}: {expected.__name__} が必要ですが {type(value).__name__} でした"
        )
    return value


def validate(raw: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """設定辞書を検証し、既定値で補完した新しい辞書を返す。

    未知のセクション・未知のキー・型不一致・範囲外はすべて
    :class:`ConfigError` にする。欠けているキーは既定値で補う。

    Args:
        raw: 検証対象（通常は ``json.load`` の結果）。

    Returns:
        すべてのキーが揃った設定辞書。

    Raises:
        ConfigError: 検証に失敗した場合。
    """
    if not isinstance(raw, Mapping):
        raise ConfigError("設定のトップレベルはオブジェクトである必要があります")

    unknown_sections = set(raw) - set(SCHEMA)
    if unknown_sections:
        raise ConfigError(
            "未知のセクション: " + ", ".join(sorted(unknown_sections))
        )

    result: dict[str, dict[str, Any]] = {}
    for section, fields in SCHEMA.items():
        raw_section = raw.get(section, {})
        if not isinstance(raw_section, Mapping):
            raise ConfigError(f"{section}: オブジェクトである必要があります")

        unknown_keys = set(raw_section) - set(fields)
        if unknown_keys:
            raise ConfigError(
                f"{section}: 未知のキー: " + ", ".join(sorted(unknown_keys))
            )

        resolved: dict[str, Any] = {}
        for name, field in fields.items():
            path = f"{section}.{name}"
            if name not in raw_section:
                resolved[name] = field.default
                continue

            value = _check_type(path, raw_section[name], field.type)
            if field.type is list and field.item_type is not None:
                for index, item in enumerate(value):
                    if not isinstance(item, field.item_type):
                        raise ConfigError(
                            f"{path}[{index}]: {field.item_type.__name__} が"
                            f"必要ですが {type(item).__name__} でした"
                        )
            if field.minimum is not None:
                too_small = (
                    value <= field.minimum
                    if field.exclusive_minimum
                    else value < field.minimum
                )
                if too_small:
                    bound = ">" if field.exclusive_minimum else ">="
                    raise ConfigError(
                        f"{path}: {bound} {field.minimum} である必要があります"
                        f"（実際: {value}）"
                    )
            resolved[name] = value
        result[section] = resolved

    level = result["logging"]["level"].upper()
    if level not in _VALID_LOG_LEVELS:
        raise ConfigError(
            "logging.level: "
            + ", ".join(sorted(_VALID_LOG_LEVELS))
            + f" のいずれかである必要があります（実際: {result['logging']['level']}）"
        )
    result["logging"]["level"] = level

    if result["discord"]["enabled"] and not result["discord"]["webhook_url"]:
        raise ConfigError("discord.enabled が true のとき webhook_url は必須です")

    return result


class ConfigManager:
    """設定ファイルの読み書きを行う。

    Example:
        >>> cm = ConfigManager("config.json").load()
        >>> cm.get("safety.min_fuel")
        1000
    """

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self._path = Path(path)
        self._data: dict[str, dict[str, Any]] = default_config()
        self._loaded = False

    @property
    def path(self) -> Path:
        """設定ファイルのパス。"""
        return self._path

    @property
    def loaded(self) -> bool:
        """一度でも :meth:`load` が成功していれば ``True``。"""
        return self._loaded

    def load(self) -> "ConfigManager":
        """設定ファイルを読み込んで検証する。

        ファイルが存在しない場合は既定値を採用し、警告を残す。
        壊れた JSON や検証エラーは :class:`ConfigError` にする
        （黙って既定値へフォールバックすると、閾値が意図せず
        緩む恐れがあるため）。

        Returns:
            自分自身（メソッドチェーン用）。

        Raises:
            ConfigError: JSON が壊れている、または検証に失敗した場合。
        """
        if not self._path.exists():
            logger.warning(
                "設定ファイルが見つかりません: %s（既定値を使用します）", self._path
            )
            self._data = default_config()
            self._loaded = True
            return self

        try:
            text = self._path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ConfigError(f"設定ファイルを読めません: {self._path}: {exc}") from exc

        try:
            raw = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ConfigError(f"設定ファイルの JSON が不正です: {self._path}: {exc}") from exc

        self._data = validate(raw)
        self._loaded = True
        logger.info("設定を読み込みました: %s", self._path)

        if self._data["automation"]["enabled"] and not self._data["automation"][
            "simulation_mode"
        ]:
            logger.warning(
                "automation.enabled=true かつ simulation_mode=false です。"
                "実操作モードの実装は未完了のため、この組み合わせは想定外です。"
            )
        return self

    def reload(self) -> "ConfigManager":
        """設定を読み直す。

        検証に失敗した場合は既存の設定を保持したまま例外を送出する。

        Raises:
            ConfigError: 再読み込みに失敗した場合。
        """
        previous = self._data
        try:
            return self.load()
        except ConfigError:
            self._data = previous
            raise

    def as_dict(self) -> dict[str, dict[str, Any]]:
        """現在の設定のコピーを返す。"""
        return {section: dict(values) for section, values in self._data.items()}

    def get(self, dotted_key: str, default: Any = None) -> Any:
        """``"safety.min_fuel"`` 形式のキーで値を取得する。

        Args:
            dotted_key: ``"<section>.<name>"`` 形式のキー。
            default: キーが存在しない場合に返す値。

        Returns:
            設定値。存在しなければ ``default``。
        """
        section, _, name = dotted_key.partition(".")
        if not name:
            raise ConfigError(f"キーは '<section>.<name>' 形式です: {dotted_key}")
        return self._data.get(section, {}).get(name, default)

    def set(self, dotted_key: str, value: Any) -> None:
        """設定値を更新する（メモリ上のみ。保存は :meth:`save`）。

        スキーマに無いキーや型不一致は :class:`ConfigError` にする。

        Raises:
            ConfigError: キーが未知、または値が検証を通らない場合。
        """
        section, _, name = dotted_key.partition(".")
        if not name:
            raise ConfigError(f"キーは '<section>.<name>' 形式です: {dotted_key}")
        if section not in SCHEMA or name not in SCHEMA[section]:
            raise ConfigError(f"未知の設定キーです: {dotted_key}")

        candidate = self.as_dict()
        candidate[section][name] = value
        # 単項目の更新でも全体を検証し直す（項目間の整合性も見るため）。
        self._data = validate(candidate)

    def save(self) -> None:
        """設定を atomic に書き出す。

        Raises:
            ConfigError: 書き出しに失敗した場合。
        """
        try:
            write_json_atomic(self._path, self._data)
        except PersistenceError as exc:
            raise ConfigError(str(exc)) from exc
        logger.info("設定を保存しました: %s", self._path)

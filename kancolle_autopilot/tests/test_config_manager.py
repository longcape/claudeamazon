"""ConfigManager のテスト。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from core.config_manager import (
    ConfigError,
    ConfigManager,
    default_config,
    validate,
)


def write_config(path: Path, data: dict) -> Path:
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


def test_defaults_are_safe() -> None:
    """既定値は自動操作無効・シミュレーションであること。"""
    config = default_config()
    assert config["automation"]["enabled"] is False
    assert config["automation"]["simulation_mode"] is True


def test_load_missing_file_uses_defaults(tmp_path: Path) -> None:
    """設定ファイルが無い場合は既定値を採用する。"""
    manager = ConfigManager(tmp_path / "absent.json").load()
    assert manager.get("safety.min_fuel") == 1000
    assert manager.loaded is True


def test_load_valid_file(tmp_path: Path) -> None:
    """明示された値が読み込まれ、欠けた項目は既定値で補われる。"""
    path = write_config(tmp_path / "config.json", {"safety": {"min_fuel": 5000}})
    manager = ConfigManager(path).load()
    assert manager.get("safety.min_fuel") == 5000
    assert manager.get("safety.min_ammo") == 1000


def test_unknown_key_is_rejected(tmp_path: Path) -> None:
    """綴り間違いを黙って無視しない。"""
    path = write_config(tmp_path / "config.json", {"safety": {"min_feul": 5000}})
    with pytest.raises(ConfigError, match="未知のキー"):
        ConfigManager(path).load()


def test_unknown_section_is_rejected(tmp_path: Path) -> None:
    path = write_config(tmp_path / "config.json", {"safty": {}})
    with pytest.raises(ConfigError, match="未知のセクション"):
        ConfigManager(path).load()


def test_bool_is_not_accepted_as_number() -> None:
    """bool は int のサブクラスだが、数値項目では拒否する。"""
    with pytest.raises(ConfigError, match="bool でした"):
        validate({"safety": {"min_fuel": True}})


def test_number_is_not_accepted_as_bool() -> None:
    with pytest.raises(ConfigError, match="bool が必要"):
        validate({"automation": {"enabled": 1}})


def test_negative_threshold_is_rejected() -> None:
    with pytest.raises(ConfigError, match=">= 0"):
        validate({"safety": {"min_fuel": -1}})


def test_zero_timeout_is_rejected() -> None:
    """タイムアウト 0 は「即諦める」になるため拒否する。"""
    with pytest.raises(ConfigError, match="> 0"):
        validate({"automation": {"action_timeout_seconds": 0}})


def test_int_is_promoted_for_float_field() -> None:
    config = validate({"monitor": {"poll_interval_seconds": 2}})
    assert config["monitor"]["poll_interval_seconds"] == pytest.approx(2.0)
    assert isinstance(config["monitor"]["poll_interval_seconds"], float)


def test_invalid_log_level_is_rejected() -> None:
    with pytest.raises(ConfigError, match="logging.level"):
        validate({"logging": {"level": "VERBOSE"}})


def test_log_level_is_normalized_to_upper_case() -> None:
    assert validate({"logging": {"level": "debug"}})["logging"]["level"] == "DEBUG"


def test_discord_enabled_requires_webhook() -> None:
    with pytest.raises(ConfigError, match="webhook_url"):
        validate({"discord": {"enabled": True}})


def test_broken_json_raises(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    path.write_text("{ not json", encoding="utf-8")
    with pytest.raises(ConfigError, match="JSON が不正"):
        ConfigManager(path).load()


def test_set_validates_value(tmp_path: Path) -> None:
    manager = ConfigManager(tmp_path / "config.json").load()
    manager.set("safety.min_fuel", 3000)
    assert manager.get("safety.min_fuel") == 3000
    with pytest.raises(ConfigError):
        manager.set("safety.min_fuel", "たくさん")
    with pytest.raises(ConfigError, match="未知の設定キー"):
        manager.set("safety.min_feul", 1)


def test_save_and_reload_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    manager = ConfigManager(path).load()
    manager.set("safety.min_buckets", 42)
    manager.save()

    reloaded = ConfigManager(path).load()
    assert reloaded.get("safety.min_buckets") == 42


def test_save_leaves_no_temp_files(tmp_path: Path) -> None:
    """atomic save の一時ファイルが残らないこと。"""
    path = tmp_path / "config.json"
    ConfigManager(path).load().save()
    assert [p.name for p in tmp_path.iterdir()] == ["config.json"]


def test_reload_keeps_previous_config_on_error(tmp_path: Path) -> None:
    """再読み込みに失敗しても既存の設定を壊さない。"""
    path = write_config(tmp_path / "config.json", {"safety": {"min_fuel": 7000}})
    manager = ConfigManager(path).load()
    path.write_text("{ broken", encoding="utf-8")

    with pytest.raises(ConfigError):
        manager.reload()
    assert manager.get("safety.min_fuel") == 7000


def test_as_dict_returns_copy(tmp_path: Path) -> None:
    manager = ConfigManager(tmp_path / "config.json").load()
    snapshot = manager.as_dict()
    snapshot["safety"]["min_fuel"] = 1
    assert manager.get("safety.min_fuel") == 1000

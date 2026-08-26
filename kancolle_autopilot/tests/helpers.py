"""テスト用のフィクスチャ読み込みヘルパ。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FIXTURE_DIR = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> Any:
    """``tests/fixtures`` から JSON を読み込む。"""
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


def load_fixture_text(name: str) -> str:
    """``tests/fixtures`` から生テキストを読み込む。"""
    return (FIXTURE_DIR / name).read_text(encoding="utf-8")

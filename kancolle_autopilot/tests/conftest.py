"""テスト共通のフィクスチャ。"""

from __future__ import annotations

from typing import Any

import pytest

from tests.helpers import load_fixture


@pytest.fixture
def port_record() -> Any:
    """母港応答のログレコード。"""
    return load_fixture("port.json")

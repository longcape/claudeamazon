"""ResourceGuard のテスト。"""

from __future__ import annotations

from core.state import Resources
from safety.resource_guard import (
    ResourceGuard,
    ResourceThresholds,
    SafetyLevel,
)

FULL = Resources(
    fuel=25000, ammo=24000, steel=30000, bauxite=12000, fast_repair=120
)


def test_sufficient_resources_are_ok() -> None:
    verdict = ResourceGuard().check(FULL)
    assert verdict.level is SafetyLevel.OK
    assert verdict.should_stop is False


def test_below_threshold_stops() -> None:
    verdict = ResourceGuard().check(Resources(**{**vars(FULL), "fuel": 999}))
    assert verdict.should_stop is True
    assert any("燃料" in reason for reason in verdict.reasons)


def test_exactly_at_threshold_is_ok() -> None:
    """閾値ちょうどは下回っていないので停止しない。"""
    guard = ResourceGuard(ResourceThresholds(min_fuel=1000))
    assert guard.check(Resources(**{**vars(FULL), "fuel": 1000})).is_ok


def test_unknown_resource_stops() -> None:
    """未取得の資材を「足りている」とみなさない。"""
    verdict = ResourceGuard().check(Resources())
    assert verdict.should_stop is True
    assert len(verdict.reasons) == 5


def test_bucket_threshold_is_checked() -> None:
    verdict = ResourceGuard().check(Resources(**{**vars(FULL), "fast_repair": 19}))
    assert verdict.should_stop is True
    assert any("高速修復材" in reason for reason in verdict.reasons)


def test_all_shortages_are_reported_at_once() -> None:
    verdict = ResourceGuard().check(
        Resources(fuel=1, ammo=1, steel=1, bauxite=1, fast_repair=1)
    )
    assert len(verdict.reasons) == 5


def test_thresholds_from_config_mapping() -> None:
    thresholds = ResourceThresholds.from_mapping(
        {"min_fuel": 5000, "log_stale_seconds": 300}
    )
    assert thresholds.min_fuel == 5000
    assert thresholds.min_ammo == 1000


def test_details_include_current_values() -> None:
    details = ResourceGuard().check(FULL).details
    assert details["FUEL"] == 25000
    assert details["FAST_REPAIR"] == 120

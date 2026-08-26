"""gametime のテスト。"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from core.gametime import (
    JST,
    day_start,
    format_game_day,
    game_date,
    is_same_game_day,
    is_same_game_week,
    month_start,
    next_daily_reset,
    next_monthly_reset,
    next_weekly_reset,
    seconds_until_daily_reset,
    week_start,
)

UTC = timezone.utc


def jst(*args) -> datetime:
    return datetime(*args, tzinfo=JST)


# -- ゲーム日 -------------------------------------------------------------


@pytest.mark.parametrize(
    "moment, expected",
    [
        (jst(2024, 5, 2, 4, 59, 59), date(2024, 5, 1)),  # 更新直前は前日
        (jst(2024, 5, 2, 5, 0, 0), date(2024, 5, 2)),  # 更新ちょうど
        (jst(2024, 5, 2, 23, 59), date(2024, 5, 2)),
        (jst(2024, 5, 3, 0, 30), date(2024, 5, 2)),  # 深夜はまだ前日扱い
    ],
)
def test_game_date_boundary(moment, expected) -> None:
    assert game_date(moment) == expected


def test_game_date_accepts_utc_input() -> None:
    """内部が UTC でも、境界は JST で判定される。"""
    # 2024-05-01 19:59 UTC = 2024-05-02 04:59 JST → まだ 5/1 扱い
    assert game_date(datetime(2024, 5, 1, 19, 59, tzinfo=UTC)) == date(2024, 5, 1)
    assert game_date(datetime(2024, 5, 1, 20, 0, tzinfo=UTC)) == date(2024, 5, 2)


def test_naive_datetime_is_rejected() -> None:
    with pytest.raises(ValueError, match="タイムゾーン"):
        game_date(datetime(2024, 5, 2, 5, 0))


def test_day_start() -> None:
    assert day_start(jst(2024, 5, 2, 3, 0)) == jst(2024, 5, 1, 5, 0)
    assert day_start(jst(2024, 5, 2, 12, 0)) == jst(2024, 5, 2, 5, 0)


def test_next_daily_reset() -> None:
    assert next_daily_reset(jst(2024, 5, 2, 4, 0)) == jst(2024, 5, 2, 5, 0)
    assert next_daily_reset(jst(2024, 5, 2, 6, 0)) == jst(2024, 5, 3, 5, 0)


def test_seconds_until_daily_reset() -> None:
    assert seconds_until_daily_reset(jst(2024, 5, 2, 4, 0)) == 3600.0


def test_is_same_game_day() -> None:
    assert is_same_game_day(jst(2024, 5, 2, 6, 0), jst(2024, 5, 3, 4, 0)) is True
    assert is_same_game_day(jst(2024, 5, 2, 4, 0), jst(2024, 5, 2, 6, 0)) is False


# -- 週 -------------------------------------------------------------------


def test_week_start_is_monday_five_am() -> None:
    # 2024-05-02 は木曜。属する週の開始は 4/29（月）05:00。
    assert week_start(jst(2024, 5, 2, 12, 0)) == jst(2024, 4, 29, 5, 0)


def test_week_start_on_monday_before_reset() -> None:
    """月曜 05:00 より前はまだ前週。"""
    assert week_start(jst(2024, 4, 29, 4, 59)) == jst(2024, 4, 22, 5, 0)
    assert week_start(jst(2024, 4, 29, 5, 0)) == jst(2024, 4, 29, 5, 0)


def test_next_weekly_reset() -> None:
    assert next_weekly_reset(jst(2024, 5, 2, 12, 0)) == jst(2024, 5, 6, 5, 0)


def test_is_same_game_week() -> None:
    assert is_same_game_week(jst(2024, 4, 29, 6, 0), jst(2024, 5, 5, 23, 0)) is True
    assert is_same_game_week(jst(2024, 4, 29, 4, 0), jst(2024, 4, 29, 6, 0)) is False


# -- 月 -------------------------------------------------------------------


def test_month_start() -> None:
    assert month_start(jst(2024, 5, 20, 12, 0)) == jst(2024, 5, 1, 5, 0)
    # 5/1 の 04:00 は 4/30 扱いなので、属する月は 4 月。
    assert month_start(jst(2024, 5, 1, 4, 0)) == jst(2024, 4, 1, 5, 0)


def test_next_monthly_reset() -> None:
    assert next_monthly_reset(jst(2024, 5, 20, 12, 0)) == jst(2024, 6, 1, 5, 0)


def test_next_monthly_reset_crosses_year() -> None:
    assert next_monthly_reset(jst(2024, 12, 20, 12, 0)) == jst(2025, 1, 1, 5, 0)


def test_format_game_day() -> None:
    assert format_game_day(jst(2024, 5, 2, 4, 0)) == "2024-05-01"

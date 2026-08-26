"""ゲーム内の日付境界を扱う。

艦これの日付は **JST 05:00** で変わる。週次任務は月曜 05:00、月次は
1 日 05:00。内部の時刻はすべて UTC で持ち、「今日のデイリーは消化
済みか」のような判断だけをこのモジュールへ閉じ込める。

暦の境界をコードのあちこちに散らすと、必ずどこかで日付が 1 日ずれる。
判断は必ずここを通す。
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta, timezone

logger = logging.getLogger(__name__)

#: 日本標準時。艦これのサーバ時刻。
JST = timezone(timedelta(hours=9), name="JST")

#: デイリー・ウィークリーが切り替わる時刻（JST）。
DAILY_RESET_HOUR = 5

#: 週の区切りとなる曜日（0=月曜）。週次任務は月曜 05:00 に更新される。
WEEKLY_RESET_WEEKDAY = 0


def _require_aware(moment: datetime) -> datetime:
    """タイムゾーン付きであることを確認して JST へ変換する。

    Raises:
        ValueError: 素朴な datetime を渡された場合。
    """
    if moment.tzinfo is None:
        raise ValueError(
            "タイムゾーン付きの datetime を渡してください"
            "（素朴な datetime は境界計算でずれます）"
        )
    return moment.astimezone(JST)


def game_date(moment: datetime) -> date:
    """その時刻が属する「ゲーム上の日付」を返す。

    JST 05:00 より前は前日として扱う。

    Args:
        moment: タイムゾーン付きの時刻。

    Returns:
        ゲーム上の日付。

    Example:
        >>> game_date(datetime(2024, 5, 2, 4, 59, tzinfo=JST))
        datetime.date(2024, 5, 1)
        >>> game_date(datetime(2024, 5, 2, 5, 0, tzinfo=JST))
        datetime.date(2024, 5, 2)
    """
    local = _require_aware(moment)
    return (local - timedelta(hours=DAILY_RESET_HOUR)).date()


def day_start(moment: datetime) -> datetime:
    """その時刻が属するゲーム日の開始時刻（JST 05:00）を返す。"""
    target = game_date(moment)
    return datetime.combine(target, time(hour=DAILY_RESET_HOUR), tzinfo=JST)


def next_daily_reset(moment: datetime) -> datetime:
    """次にデイリーが更新される時刻を返す。"""
    return day_start(moment) + timedelta(days=1)


def week_start(moment: datetime) -> datetime:
    """その時刻が属するゲーム週の開始時刻（月曜 05:00 JST）を返す。"""
    start = day_start(moment)
    offset = (start.weekday() - WEEKLY_RESET_WEEKDAY) % 7
    return start - timedelta(days=offset)


def next_weekly_reset(moment: datetime) -> datetime:
    """次に週次が更新される時刻を返す。"""
    return week_start(moment) + timedelta(days=7)


def month_start(moment: datetime) -> datetime:
    """その時刻が属するゲーム月の開始時刻（1 日 05:00 JST）を返す。"""
    target = game_date(moment)
    return datetime.combine(
        target.replace(day=1), time(hour=DAILY_RESET_HOUR), tzinfo=JST
    )


def next_monthly_reset(moment: datetime) -> datetime:
    """次に月次が更新される時刻を返す。"""
    start = month_start(moment)
    # 月の加算は日数が一定でないため、翌月の 1 日を組み立て直す。
    if start.month == 12:
        return start.replace(year=start.year + 1, month=1)
    return start.replace(month=start.month + 1)


def is_same_game_day(left: datetime, right: datetime) -> bool:
    """2 つの時刻が同じゲーム日に属するなら ``True``。"""
    return game_date(left) == game_date(right)


def is_same_game_week(left: datetime, right: datetime) -> bool:
    """2 つの時刻が同じゲーム週に属するなら ``True``。"""
    return week_start(left) == week_start(right)


def seconds_until_daily_reset(moment: datetime) -> float:
    """次のデイリー更新までの秒数。"""
    return (next_daily_reset(moment) - _require_aware(moment)).total_seconds()


def format_game_day(moment: datetime) -> str:
    """ゲーム日を ``2024-05-01`` 形式で返す（ログ用）。"""
    return game_date(moment).isoformat()

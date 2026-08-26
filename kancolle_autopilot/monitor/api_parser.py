"""kcsapi の応答を、ドメインモデルを載せたイベントへ変換する。

このモジュールは **状態を持たない**。1 件の API 応答だけを見て
判断できることのみをイベント化し、履歴に依存する判断
（「この出撃はもう終わったのか」「この艦は未所持か」）は
:mod:`monitor.game_state` 側で導出する。

用語について（kcsapi 側の名前が紛らわしいので明示する）:

* ``api_get_member/mission`` は **遠征** のリスト。本モジュールでは
  ``EXPEDITION_*`` として扱う。
* ``api_get_member/questlist`` は **任務**。本モジュールでは
  ``MISSION_UPDATED`` として扱う（開発指示書 §6 の名称に合わせる）。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Mapping, Sequence

from core.state import (
    BuildDock,
    Fleet,
    FleetMission,
    FleetMissionState,
    PlayerInfo,
    Quest,
    QuestState,
    RepairDock,
    ResourceKind,
    Ship,
    epoch_ms_to_datetime,
    utcnow,
)

logger = logging.getLogger(__name__)

#: kcsapi の応答本文が入っている JSONP 風の接頭辞。
_SVDATA_PREFIX = "svdata="


class EventType(str, Enum):
    """イベント種別。"""

    RESOURCE_UPDATED = "RESOURCE_UPDATED"
    PLAYER_UPDATED = "PLAYER_UPDATED"
    SHIP_UPDATED = "SHIP_UPDATED"
    SHIP_REMOVED = "SHIP_REMOVED"
    FLEET_UPDATED = "FLEET_UPDATED"
    REPAIR_DOCK_UPDATED = "REPAIR_DOCK_UPDATED"
    CONSTRUCTION_UPDATED = "CONSTRUCTION_UPDATED"
    MISSION_UPDATED = "MISSION_UPDATED"
    EXPEDITION_STARTED = "EXPEDITION_STARTED"
    EXPEDITION_COMPLETED = "EXPEDITION_COMPLETED"
    SORTIE_STARTED = "SORTIE_STARTED"
    MAP_ADVANCED = "MAP_ADVANCED"
    BATTLE_RESULT = "BATTLE_RESULT"
    DROP_DETECTED = "DROP_DETECTED"
    SORTIE_ENDED = "SORTIE_ENDED"
    PORT_REFRESHED = "PORT_REFRESHED"
    #: 未所持艦のドロップ。:mod:`monitor.game_state` が導出する。
    UNKNOWN_SHIP_DROPPED = "UNKNOWN_SHIP_DROPPED"


@dataclass(frozen=True)
class Event:
    """パース結果 1 件。"""

    type: EventType
    payload: Mapping[str, Any] = field(default_factory=dict)
    occurred_at: datetime = field(default_factory=utcnow)
    source_path: str = ""


# --------------------------------------------------------------------------
# 低レベルの取り出しヘルパ
# --------------------------------------------------------------------------


def _as_int(value: Any) -> int | None:
    """``int`` へ変換する。変換できなければ ``None``。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _as_bool(value: Any) -> bool | None:
    """kcsapi の 0/1 を ``bool`` へ変換する。不明なら ``None``。"""
    if isinstance(value, bool):
        return value
    number = _as_int(value)
    if number is None:
        return None
    return number != 0


def _as_str(value: Any) -> str | None:
    """``str`` へ変換する。``None`` はそのまま。"""
    if value is None:
        return None
    return str(value)


def _first_int(value: Any, index: int) -> int | None:
    """リストの ``index`` 番目を ``int`` として取り出す。"""
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        if 0 <= index < len(value):
            return _as_int(value[index])
    return None


def normalize_path(path: str | None) -> str:
    """API パスを ``"api_port/port"`` 形式へ正規化する。

    URL 全体、先頭スラッシュ、``kcsapi/`` 接頭辞、クエリ文字列を除去する。

    Args:
        path: ``"/kcsapi/api_port/port"`` や
            ``"http://host/kcsapi/api_port/port?x=1"`` など。

    Returns:
        正規化済みパス。``path`` が空なら空文字列。
    """
    if not path:
        return ""
    text = str(path).split("?", 1)[0].strip()
    marker = "kcsapi/"
    index = text.find(marker)
    if index >= 0:
        text = text[index + len(marker) :]
    return text.strip("/")


def extract_body(raw: Any) -> dict[str, Any] | None:
    """ログ 1 件から API 応答の ``api_data`` 相当を取り出す。

    次の形をすべて受け付ける。

    * ``"svdata={...}"`` という生文字列
    * ``{"api_result": 1, "api_data": {...}}``
    * すでに ``api_data`` の中身だけになっている辞書

    Args:
        raw: 生文字列または辞書。

    Returns:
        ``api_data`` に相当する辞書。取り出せなければ ``None``。
        ``api_data`` がリストの場合は ``{"api_data": [...]}`` に包んで返す。
    """
    value: Any = raw
    if isinstance(value, (bytes, bytearray)):
        try:
            value = value.decode("utf-8")
        except UnicodeDecodeError:
            return None

    if isinstance(value, str):
        text = value.strip()
        if text.startswith(_SVDATA_PREFIX):
            text = text[len(_SVDATA_PREFIX) :]
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            return None

    if not isinstance(value, Mapping):
        return None

    if "api_data" in value:
        data = value["api_data"]
        if isinstance(data, Mapping):
            return dict(data)
        # api_get_member/material のように api_data が配列の場合がある。
        return {"api_data": data}
    return dict(value)


def _iter_entries(value: Any) -> list[Mapping[str, Any]]:
    """リスト（または辞書の値）から辞書要素だけを取り出す。

    kcsapi は「空きスロットに ``-1`` を入れた配列」を返すことがあるため、
    辞書以外の要素は捨てる。
    """
    if isinstance(value, Mapping):
        value = list(value.values())
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return []
    return [entry for entry in value if isinstance(entry, Mapping)]


# --------------------------------------------------------------------------
# ドメインモデルへの変換
# --------------------------------------------------------------------------


def parse_ship(entry: Mapping[str, Any], now: datetime) -> Ship | None:
    """``api_ship`` の 1 要素を :class:`Ship` へ変換する。

    Returns:
        変換結果。``api_id`` が取れない場合は ``None``。
    """
    instance_id = _as_int(entry.get("api_id"))
    if instance_id is None:
        return None
    return Ship(
        instance_id=instance_id,
        master_id=_as_int(entry.get("api_ship_id")),
        level=_as_int(entry.get("api_lv")),
        exp=_first_int(entry.get("api_exp"), 0),
        hp=_as_int(entry.get("api_nowhp")),
        max_hp=_as_int(entry.get("api_maxhp")),
        fuel=_as_int(entry.get("api_fuel")),
        ammo=_as_int(entry.get("api_bull")),
        cond=_as_int(entry.get("api_cond")),
        locked=_as_bool(entry.get("api_locked")),
        sally_area=_as_int(entry.get("api_sally_area")),
        updated_at=now,
    )


def parse_fleet(entry: Mapping[str, Any], now: datetime) -> Fleet | None:
    """``api_deck_port`` の 1 要素を :class:`Fleet` へ変換する。"""
    fleet_id = _as_int(entry.get("api_id"))
    if fleet_id is None:
        return None

    ship_ids = [
        ship_id
        for ship_id in (
            _as_int(value) for value in entry.get("api_ship", []) or []
        )
        # 空きスロットは -1。
        if ship_id is not None and ship_id > 0
    ]

    mission_raw = entry.get("api_mission")
    state_value = _first_int(mission_raw, 0)
    try:
        state = FleetMissionState(state_value) if state_value is not None else FleetMissionState.IDLE
    except ValueError:
        logger.warning("未知の遠征状態です: %r", state_value)
        state = FleetMissionState.IDLE

    mission = FleetMission(
        state=state,
        mission_id=_first_int(mission_raw, 1),
        complete_at=epoch_ms_to_datetime(_first_int(mission_raw, 2)),
    )

    return Fleet(
        fleet_id=fleet_id,
        name=_as_str(entry.get("api_name")),
        ship_ids=ship_ids,
        mission=mission,
        updated_at=now,
    )


def parse_quest(entry: Mapping[str, Any]) -> Quest | None:
    """``api_list`` の 1 要素を :class:`Quest` へ変換する。"""
    quest_id = _as_int(entry.get("api_no"))
    if quest_id is None:
        return None
    state_value = _as_int(entry.get("api_state"))
    try:
        state = QuestState(state_value) if state_value is not None else QuestState.UNKNOWN
    except ValueError:
        state = QuestState.UNKNOWN
    return Quest(
        quest_id=quest_id,
        name=_as_str(entry.get("api_title")),
        state=state,
        progress_flag=_as_int(entry.get("api_progress_flag")),
        category=_as_int(entry.get("api_category")),
        period_type=_as_int(entry.get("api_type")),
    )


def _parse_material_list(entries: Any) -> dict[ResourceKind, int]:
    """``[{"api_id": 1, "api_value": 1000}, ...]`` を辞書へ変換する。"""
    updates: dict[ResourceKind, int] = {}
    for entry in _iter_entries(entries):
        kind_value = _as_int(entry.get("api_id"))
        amount = _as_int(entry.get("api_value"))
        if kind_value is None or amount is None:
            continue
        try:
            updates[ResourceKind(kind_value)] = amount
        except ValueError:
            # 将来資材が増えても落とさない。
            logger.debug("未知の資材 ID を無視します: %s", kind_value)
    return updates


def _parse_material_array(values: Any) -> dict[ResourceKind, int]:
    """``[燃料, 弾薬, 鋼材, ボーキ, ...]`` 形式の配列を変換する。

    遠征報酬（``api_get_material``）などで使われる、ID を持たない
    位置依存の配列に対応する。
    """
    if not isinstance(values, Sequence) or isinstance(values, (str, bytes)):
        return {}
    order = (
        ResourceKind.FUEL,
        ResourceKind.AMMO,
        ResourceKind.STEEL,
        ResourceKind.BAUXITE,
    )
    updates: dict[ResourceKind, int] = {}
    for kind, raw in zip(order, values):
        amount = _as_int(raw)
        if amount is not None:
            updates[kind] = amount
    return updates


# --------------------------------------------------------------------------
# パーサ本体
# --------------------------------------------------------------------------

Handler = Callable[["APIParser", Mapping[str, Any], datetime, str], list[Event]]


class APIParser:
    """kcsapi の応答をイベント列へ変換する。

    未知のパスは無視し、壊れたデータでも例外を投げない
    （開発指示書 §6「壊れた JSON でプロセス全体を停止させない」）。
    """

    def __init__(self) -> None:
        self._handlers: dict[str, Handler] = {
            "api_port/port": APIParser._handle_port,
            "api_get_member/material": APIParser._handle_material,
            "api_get_member/ship2": APIParser._handle_ship_list,
            "api_get_member/ship3": APIParser._handle_ship_list,
            "api_get_member/ship_deck": APIParser._handle_ship_list,
            "api_get_member/deck": APIParser._handle_deck,
            "api_get_member/deck_port": APIParser._handle_deck,
            "api_get_member/ndock": APIParser._handle_ndock,
            "api_get_member/kdock": APIParser._handle_kdock,
            "api_get_member/questlist": APIParser._handle_questlist,
            "api_get_member/basic": APIParser._handle_basic,
            "api_req_map/start": APIParser._handle_map_start,
            "api_req_map/next": APIParser._handle_map_next,
            "api_req_sortie/battleresult": APIParser._handle_battle_result,
            "api_req_combined_battle/battleresult": APIParser._handle_battle_result,
            "api_req_mission/result": APIParser._handle_mission_result,
            "api_req_kousyou/createship": APIParser._handle_createship,
            "api_req_kousyou/getship": APIParser._handle_getship,
            "api_req_kousyou/destroyship": APIParser._handle_destroyship,
        }

    @property
    def supported_paths(self) -> frozenset[str]:
        """対応している API パスの集合。"""
        return frozenset(self._handlers)

    # -- 入口 --------------------------------------------------------------

    def parse(
        self,
        path: str,
        body: Any,
        occurred_at: datetime | None = None,
        request: Mapping[str, Any] | None = None,
    ) -> list[Event]:
        """1 件の API 応答をイベント列へ変換する。

        Args:
            path: API パス（正規化前でよい）。
            body: 応答本文。``svdata=`` 付き文字列や
                ``api_data`` を含む辞書も受け付ける。
            occurred_at: 発生時刻。省略時は現在時刻。
            request: リクエスト側のパラメータ（``postBody`` 相当）。
                解体対象の艦 ID など、応答だけでは分からない情報に使う。

        Returns:
            イベント列。対応外のパスや解析不能な本文では空リスト。
        """
        normalized = normalize_path(path)
        handler = self._handlers.get(normalized)
        if handler is None:
            logger.debug("対応していない API パスです: %s", normalized)
            return []

        data = extract_body(body)
        if data is None:
            logger.warning("応答本文を解析できません: %s", normalized)
            return []

        now = occurred_at or utcnow()
        if request:
            # ハンドラからリクエスト情報を参照できるようにする。
            data = {**data, "_request": dict(request)}

        try:
            return handler(self, data, now, normalized)
        except Exception:  # noqa: BLE001 - 監視プロセスを落とさないため
            logger.exception("イベント変換に失敗しました: %s", normalized)
            return []

    def parse_record(
        self, record: Any, occurred_at: datetime | None = None
    ) -> list[Event]:
        """専ブラのログ 1 レコードを変換する。

        ``{"path": ..., "body": ...}`` 形式を想定し、キー名の揺れ
        （``api`` / ``url`` / ``response`` / ``postBody``）も吸収する。

        Args:
            record: ログ 1 件。辞書または JSON 文字列。
            occurred_at: 発生時刻。省略時はレコード内の時刻、
                無ければ現在時刻。

        Returns:
            イベント列。形式が判別できなければ空リスト。
        """
        value: Any = record
        if isinstance(value, (str, bytes, bytearray)):
            try:
                value = json.loads(value)
            except (json.JSONDecodeError, UnicodeDecodeError):
                logger.warning("ログレコードの JSON が不正です")
                return []

        if not isinstance(value, Mapping):
            logger.warning("ログレコードがオブジェクトではありません")
            return []

        path = ""
        for key in ("path", "api", "url", "api_path"):
            if value.get(key):
                path = str(value[key])
                break
        if not path:
            logger.warning("ログレコードに API パスがありません")
            return []

        body: Any = None
        for key in ("body", "response", "api_data", "data"):
            if key in value:
                body = value[key]
                break
        if body is None:
            logger.warning("ログレコードに応答本文がありません: %s", path)
            return []

        request = None
        for key in ("postBody", "post_body", "request", "params"):
            candidate = value.get(key)
            if isinstance(candidate, Mapping):
                request = candidate
                break

        timestamp = occurred_at
        if timestamp is None:
            timestamp = epoch_ms_to_datetime(_as_int(value.get("time")))

        return self.parse(path, body, timestamp, request)

    # -- 各ハンドラ --------------------------------------------------------

    def _handle_port(
        self, data: Mapping[str, Any], now: datetime, path: str
    ) -> list[Event]:
        """母港情報。艦・艦隊・資材・入渠が一括で返る。"""
        events: list[Event] = [
            Event(EventType.PORT_REFRESHED, {}, now, path)
        ]

        materials = _parse_material_list(data.get("api_material"))
        if materials:
            events.append(
                Event(EventType.RESOURCE_UPDATED, {"resources": materials}, now, path)
            )

        ships = [
            ship
            for ship in (
                parse_ship(entry, now) for entry in _iter_entries(data.get("api_ship"))
            )
            if ship is not None
        ]
        if ships:
            # 母港応答は全所有艦を含むため、状態を置き換えてよい。
            events.append(
                Event(
                    EventType.SHIP_UPDATED,
                    {"ships": ships, "replace": True},
                    now,
                    path,
                )
            )

        events.extend(self._deck_events(data.get("api_deck_port"), now, path))
        events.extend(self._ndock_events(data.get("api_ndock"), now, path))

        basic = data.get("api_basic")
        if isinstance(basic, Mapping):
            events.append(
                Event(
                    EventType.PLAYER_UPDATED,
                    {"player": _parse_basic(basic)},
                    now,
                    path,
                )
            )
        return events

    def _handle_material(
        self, data: Mapping[str, Any], now: datetime, path: str
    ) -> list[Event]:
        """資材一覧。``api_data`` が配列で返る。"""
        materials = _parse_material_list(data.get("api_data", data))
        if not materials:
            return []
        return [Event(EventType.RESOURCE_UPDATED, {"resources": materials}, now, path)]

    def _handle_ship_list(
        self, data: Mapping[str, Any], now: datetime, path: str
    ) -> list[Event]:
        """艦の部分更新（``ship2`` / ``ship3`` / ``ship_deck``）。"""
        raw_ships = (
            data.get("api_ship_data")
            or data.get("api_data")
            or data.get("api_ship")
        )
        ships = [
            ship
            for ship in (
                parse_ship(entry, now) for entry in _iter_entries(raw_ships)
            )
            if ship is not None
        ]
        events: list[Event] = []
        if ships:
            # 部分更新なので replace はしない。
            events.append(
                Event(
                    EventType.SHIP_UPDATED,
                    {"ships": ships, "replace": False},
                    now,
                    path,
                )
            )
        raw_decks = data.get("api_deck_data") or data.get("api_data_deck")
        events.extend(self._deck_events(raw_decks, now, path))
        return events

    def _handle_deck(
        self, data: Mapping[str, Any], now: datetime, path: str
    ) -> list[Event]:
        """艦隊一覧。"""
        return self._deck_events(data.get("api_data", data), now, path)

    def _handle_ndock(
        self, data: Mapping[str, Any], now: datetime, path: str
    ) -> list[Event]:
        """入渠ドック一覧。"""
        return self._ndock_events(data.get("api_data", data), now, path)

    def _handle_kdock(
        self, data: Mapping[str, Any], now: datetime, path: str
    ) -> list[Event]:
        """建造ドック一覧。"""
        docks = _parse_build_docks(data.get("api_data", data))
        if not docks:
            return []
        return [
            Event(
                EventType.CONSTRUCTION_UPDATED,
                {"build_docks": docks, "reason": "kdock"},
                now,
                path,
            )
        ]

    def _handle_questlist(
        self, data: Mapping[str, Any], now: datetime, path: str
    ) -> list[Event]:
        """任務一覧。"""
        quests = [
            quest
            for quest in (
                parse_quest(entry) for entry in _iter_entries(data.get("api_list"))
            )
            if quest is not None
        ]
        payload = {
            "quests": quests,
            "page": _as_int(data.get("api_disp_page")),
            "page_count": _as_int(data.get("api_page_count")),
        }
        return [Event(EventType.MISSION_UPDATED, payload, now, path)]

    def _handle_basic(
        self, data: Mapping[str, Any], now: datetime, path: str
    ) -> list[Event]:
        """提督の基本情報。"""
        source = data.get("api_data", data)
        if not isinstance(source, Mapping):
            return []
        return [
            Event(EventType.PLAYER_UPDATED, {"player": _parse_basic(source)}, now, path)
        ]

    def _handle_map_start(
        self, data: Mapping[str, Any], now: datetime, path: str
    ) -> list[Event]:
        """出撃開始。"""
        payload = _map_payload(data)
        if payload.get("map_area") is None or payload.get("map_no") is None:
            logger.warning("出撃開始イベントに海域情報がありません")
            return []
        return [Event(EventType.SORTIE_STARTED, payload, now, path)]

    def _handle_map_next(
        self, data: Mapping[str, Any], now: datetime, path: str
    ) -> list[Event]:
        """マス進行。"""
        return [Event(EventType.MAP_ADVANCED, _map_payload(data), now, path)]

    def _handle_battle_result(
        self, data: Mapping[str, Any], now: datetime, path: str
    ) -> list[Event]:
        """戦闘結果。ドロップがあれば併せてイベント化する。"""
        payload: dict[str, Any] = {
            "rank": _as_str(data.get("api_win_rank")),
            "quest_name": _as_str(data.get("api_quest_name")),
            "enemy_name": _as_str(data.get("api_enemy_info", {}).get("api_deck_name"))
            if isinstance(data.get("api_enemy_info"), Mapping)
            else None,
            "get_exp": _as_int(data.get("api_get_exp")),
        }
        events = [Event(EventType.BATTLE_RESULT, payload, now, path)]

        drop = data.get("api_get_ship")
        if isinstance(drop, Mapping):
            events.append(
                Event(
                    EventType.DROP_DETECTED,
                    {
                        "master_id": _as_int(drop.get("api_ship_id")),
                        "name": _as_str(drop.get("api_ship_name")),
                        "ship_type": _as_str(drop.get("api_ship_type")),
                    },
                    now,
                    path,
                )
            )
        return events

    def _handle_mission_result(
        self, data: Mapping[str, Any], now: datetime, path: str
    ) -> list[Event]:
        """遠征帰投。"""
        payload = {
            "name": _as_str(data.get("api_quest_name")),
            "clear_result": _as_int(data.get("api_clear_result")),
            "materials": _parse_material_array(data.get("api_get_material")),
        }
        return [Event(EventType.EXPEDITION_COMPLETED, payload, now, path)]

    def _handle_createship(
        self, data: Mapping[str, Any], now: datetime, path: str
    ) -> list[Event]:
        """建造開始。レシピはリクエスト側にしか無い。"""
        request = data.get("_request") or {}
        payload = {
            "reason": "createship",
            "recipe": {
                "fuel": _as_int(request.get("api_item1")),
                "ammo": _as_int(request.get("api_item2")),
                "steel": _as_int(request.get("api_item3")),
                "bauxite": _as_int(request.get("api_item4")),
                "dev_material": _as_int(request.get("api_item5")),
            },
            "dock_id": _as_int(request.get("api_kdock_id")),
            "large": _as_bool(request.get("api_large_flag")),
        }
        return [Event(EventType.CONSTRUCTION_UPDATED, payload, now, path)]

    def _handle_getship(
        self, data: Mapping[str, Any], now: datetime, path: str
    ) -> list[Event]:
        """建造完了（艦の受け取り）。"""
        events: list[Event] = []
        ship_entry = data.get("api_ship")
        if isinstance(ship_entry, Mapping):
            ship = parse_ship(ship_entry, now)
            if ship is not None:
                events.append(
                    Event(
                        EventType.SHIP_UPDATED,
                        {"ships": [ship], "replace": False},
                        now,
                        path,
                    )
                )
        docks = _parse_build_docks(data.get("api_kdock"))
        events.append(
            Event(
                EventType.CONSTRUCTION_UPDATED,
                {"reason": "getship", "build_docks": docks},
                now,
                path,
            )
        )
        return events

    def _handle_destroyship(
        self, data: Mapping[str, Any], now: datetime, path: str
    ) -> list[Event]:
        """解体。どの艦を解体したかはリクエスト側にある。"""
        request = data.get("_request") or {}
        raw_ids = request.get("api_ship_id")
        if isinstance(raw_ids, str):
            candidates = raw_ids.split(",")
        elif isinstance(raw_ids, Sequence) and not isinstance(raw_ids, bytes):
            candidates = list(raw_ids)
        else:
            candidates = [raw_ids]
        ship_ids = [
            ship_id
            for ship_id in (_as_int(value) for value in candidates)
            if ship_id is not None
        ]

        events: list[Event] = []
        if ship_ids:
            events.append(
                Event(EventType.SHIP_REMOVED, {"ship_ids": ship_ids}, now, path)
            )
        materials = _parse_material_list(data.get("api_material"))
        if not materials:
            materials = _parse_material_array(data.get("api_material"))
        if materials:
            events.append(
                Event(EventType.RESOURCE_UPDATED, {"resources": materials}, now, path)
            )
        return events

    # -- 共通処理 ----------------------------------------------------------

    def _deck_events(
        self, raw: Any, now: datetime, path: str
    ) -> list[Event]:
        """艦隊情報から FLEET_UPDATED と遠征イベントを作る。"""
        fleets = [
            fleet
            for fleet in (parse_fleet(entry, now) for entry in _iter_entries(raw))
            if fleet is not None
        ]
        if not fleets:
            return []

        events = [Event(EventType.FLEET_UPDATED, {"fleets": fleets}, now, path)]
        for fleet in fleets:
            if fleet.mission.is_active:
                events.append(
                    Event(
                        EventType.EXPEDITION_STARTED,
                        {
                            "fleet_id": fleet.fleet_id,
                            "mission_id": fleet.mission.mission_id,
                            "complete_at": fleet.mission.complete_at,
                        },
                        now,
                        path,
                    )
                )
        return events

    def _ndock_events(self, raw: Any, now: datetime, path: str) -> list[Event]:
        """入渠ドック情報をイベント化する。"""
        docks: list[RepairDock] = []
        for entry in _iter_entries(raw):
            dock_id = _as_int(entry.get("api_id"))
            if dock_id is None:
                continue
            docks.append(
                RepairDock(
                    dock_id=dock_id,
                    state=_as_int(entry.get("api_state")),
                    ship_id=_as_int(entry.get("api_ship_id")) or None,
                    complete_at=epoch_ms_to_datetime(
                        _as_int(entry.get("api_complete_time"))
                    ),
                )
            )
        if not docks:
            return []
        return [
            Event(EventType.REPAIR_DOCK_UPDATED, {"repair_docks": docks}, now, path)
        ]


def _parse_basic(entry: Mapping[str, Any]) -> PlayerInfo:
    """``api_basic`` を :class:`PlayerInfo` へ変換する。"""
    return PlayerInfo(
        nickname=_as_str(entry.get("api_nickname")),
        level=_as_int(entry.get("api_level")),
        ship_capacity=_as_int(entry.get("api_max_chara")),
        slot_capacity=_as_int(entry.get("api_max_slotitem")),
    )


def _parse_build_docks(raw: Any) -> list[BuildDock]:
    """``api_kdock`` を :class:`BuildDock` のリストへ変換する。"""
    docks: list[BuildDock] = []
    for entry in _iter_entries(raw):
        dock_id = _as_int(entry.get("api_id"))
        if dock_id is None:
            continue
        docks.append(
            BuildDock(
                dock_id=dock_id,
                state=_as_int(entry.get("api_state")),
                created_ship_id=_as_int(entry.get("api_created_ship_id")) or None,
                complete_at=epoch_ms_to_datetime(
                    _as_int(entry.get("api_complete_time"))
                ),
            )
        )
    return docks


def _map_payload(data: Mapping[str, Any]) -> dict[str, Any]:
    """出撃・進撃イベント共通のペイロードを組み立てる。"""
    return {
        "map_area": _as_int(data.get("api_maparea_id")),
        "map_no": _as_int(data.get("api_mapinfo_no")),
        "cell_no": _as_int(data.get("api_no")),
        "boss_cell_no": _as_int(data.get("api_bosscell_no")),
        "event_id": _as_int(data.get("api_event_id")),
        "next": _as_int(data.get("api_next")),
    }

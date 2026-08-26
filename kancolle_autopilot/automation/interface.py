"""GUI 操作の抽象インターフェース。

タスクはこのインターフェースだけを通してゲームを操作する。実際に
どうやって操作するか（PyAutoGUI か、サンドボックスか）を知ってはいけない。

**操作対象は論理名で指す。** ``"sortie_start"`` のような名前を渡し、
座標へ落とすのは実装側（Phase 5 の screen_detector）の仕事。タスクに
ピクセル座標を持たせると、解像度が変わるたびにタスクを書き直すことに
なるうえ、判断とクリックが混ざる。

開発指示書 §13 のとおり、実 GUI 操作より先にシミュレーション実装
（:mod:`automation.simulation`）を用意する。
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping

logger = logging.getLogger(__name__)

#: 操作結果を待つ既定のタイムアウト（秒）。
DEFAULT_TIMEOUT_SECONDS = 10.0


class Screen(str, Enum):
    """ゲームの画面。

    ``UNKNOWN`` は「判別できなかった」を表す。想定外の画面は
    正常として扱わず、安全側に倒す材料にする。
    """

    UNKNOWN = "UNKNOWN"
    HOME = "HOME"  # 母港
    FLEET = "FLEET"  # 編成
    SUPPLY = "SUPPLY"  # 補給
    REPAIR = "REPAIR"  # 入渠
    ARSENAL = "ARSENAL"  # 工廠
    BUILD = "BUILD"  # 建造
    DEVELOP = "DEVELOP"  # 開発
    DISMANTLE = "DISMANTLE"  # 解体
    EXPEDITION = "EXPEDITION"  # 遠征
    SORTIE_SELECT = "SORTIE_SELECT"  # 出撃海域選択
    SORTIE_MAP = "SORTIE_MAP"  # 海域進行中
    BATTLE = "BATTLE"  # 戦闘中
    BATTLE_RESULT = "BATTLE_RESULT"  # 戦闘結果
    QUEST = "QUEST"  # 任務


class ActionKind(str, Enum):
    """操作の種類。"""

    NAVIGATE = "NAVIGATE"
    CLICK = "CLICK"
    WAIT = "WAIT"


@dataclass(frozen=True)
class Action:
    """1 回の操作。

    Attributes:
        target: 操作対象の論理名。座標ではない。
        screen: この操作を行う画面。``None` なら画面を問わない。
    """

    kind: ActionKind
    target: str
    screen: Screen | None = None
    description: str = ""
    payload: Mapping[str, Any] = field(default_factory=dict)

    def describe(self) -> str:
        """ログ用の 1 行表記。"""
        where = f" ({self.screen.value})" if self.screen else ""
        note = f" — {self.description}" if self.description else ""
        return f"{self.kind.value} {self.target}{where}{note}"


@dataclass(frozen=True)
class ActionResult:
    """操作の結果。

    Attributes:
        simulated: 実際には操作していない（シミュレーション）なら ``True``。
        screen: 操作後に観測した画面。
    """

    action: Action
    ok: bool
    simulated: bool
    message: str = ""
    screen: Screen = Screen.UNKNOWN

    @property
    def failed(self) -> bool:
        """失敗なら ``True``。"""
        return not self.ok

    def describe(self) -> str:
        """ログ用の 1 行表記。"""
        mark = "OK" if self.ok else "NG"
        note = f" — {self.message}" if self.message else ""
        return f"[{mark}] {self.action.describe()}{note}"


class InterfaceError(Exception):
    """GUI 操作の失敗。"""


class UnexpectedScreen(InterfaceError):
    """想定していた画面ではなかった。"""

    def __init__(self, expected: Screen, actual: Screen) -> None:
        super().__init__(
            f"想定した画面ではありません: 期待 {expected.value} / 実際 {actual.value}"
        )
        self.expected = expected
        self.actual = actual


class GameInterface(ABC):
    """ゲームを操作するための抽象。

    実装は :class:`~automation.simulation.SimulationInterface`（Phase 4）
    と、実 GUI を操作するもの（Phase 5）。
    """

    @property
    @abstractmethod
    def simulated(self) -> bool:
        """実際には操作しない実装なら ``True``。"""

    @abstractmethod
    def get_state(self) -> Screen:
        """現在の画面を返す。判別できなければ :attr:`Screen.UNKNOWN`。"""

    @abstractmethod
    def navigate(self, destination: Screen) -> ActionResult:
        """指定の画面へ移動する。"""

    @abstractmethod
    def click(
        self,
        target: str,
        screen: Screen | None = None,
        description: str = "",
    ) -> ActionResult:
        """対象をクリックする。

        Args:
            target: 操作対象の論理名。
            screen: この操作を行うべき画面。指定した場合、現在の画面と
                一致しなければ失敗させる（誤クリック防止）。
            description: ログに残す説明。
        """

    @abstractmethod
    def wait_for_state(
        self, expected: Screen, timeout: float = DEFAULT_TIMEOUT_SECONDS
    ) -> ActionResult:
        """画面が ``expected`` になるまで待つ。"""

    @abstractmethod
    def execute_action(self, action: Action) -> ActionResult:
        """任意の操作を実行する。"""

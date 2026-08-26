"""キー入力と、緊急停止キー。

開発指示書 §15 の「キルスイッチ／手動停止」を担当する。既定は F12。

キルスイッチは **押されたことを検出したら latch する**。押しっぱなしを
要求しないし、次のポーリングで押されていなくても解除しない。止めたい
瞬間に一瞬押せば止まる、というのが手動停止に求められる挙動なので。
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

#: 緊急停止に使うキーの既定値。
DEFAULT_KILL_SWITCH_KEY = "f12"


class KeyboardBackend(ABC):
    """キー入力の実体。"""

    @property
    @abstractmethod
    def simulated(self) -> bool:
        """OS の入力に触れないなら ``True``。"""

    @abstractmethod
    def press(self, key: str) -> None:
        """キーを押す。"""

    @abstractmethod
    def is_pressed(self, key: str) -> bool:
        """キーが押されているなら ``True``。"""


@dataclass
class VirtualKeyboard(KeyboardBackend):
    """サンドボックス用のキーボード。"""

    pressed: set[str] = field(default_factory=set)
    #: 送出されたキーの記録。
    sent: list[str] = field(default_factory=list)

    @property
    def simulated(self) -> bool:
        """常に ``True``。"""
        return True

    def press(self, key: str) -> None:
        """キー送出を記録する。"""
        self.sent.append(key)

    def is_pressed(self, key: str) -> bool:
        """外部から :attr:`pressed` を操作してテストする。"""
        return key in self.pressed

    def hold(self, key: str) -> None:
        """キーが押されている状態にする（テスト用）。"""
        self.pressed.add(key)

    def release(self, key: str) -> None:
        """キーを離す（テスト用）。"""
        self.pressed.discard(key)


@dataclass
class KeyboardController:
    """キー送出と、緊急停止キーの監視。"""

    backend: KeyboardBackend
    kill_switch_key: str = DEFAULT_KILL_SWITCH_KEY
    _triggered: bool = field(default=False, init=False)

    @property
    def simulated(self) -> bool:
        """OS の入力に触れないなら ``True``。"""
        return self.backend.simulated

    @property
    def kill_switch_triggered(self) -> bool:
        """緊急停止キーが押されたことがあるなら ``True``。"""
        return self._triggered

    def press(self, key: str) -> None:
        """キーを送出する。"""
        self.backend.press(key)
        logger.debug("キー送出: %s", key)

    def poll_kill_switch(self) -> bool:
        """緊急停止キーの状態を確認し、押されていれば latch する。

        Returns:
            latch されているなら ``True``。
        """
        if self.backend.is_pressed(self.kill_switch_key):
            if not self._triggered:
                logger.error("緊急停止キーが押されました: %s", self.kill_switch_key)
            self._triggered = True
        return self._triggered

    def reset_kill_switch(self) -> None:
        """latch を解除する（人手での確認後に呼ぶ）。"""
        if self._triggered:
            logger.warning("緊急停止キーの latch を解除します")
        self._triggered = False

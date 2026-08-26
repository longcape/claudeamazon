"""実際には操作しないシミュレーション実装。

開発指示書 §13 の担当。``simulation_mode=true`` のとき、「出撃する」を
実際にクリックせず ``SIMULATION: would click sortie_start`` としてログへ
出す。OS の入力 API には一切触れない。

画面遷移は :attr:`SimulationInterface.transitions` で表現する。
``(現在の画面, 操作対象) -> 次の画面`` を与えると、そのとおりに画面が
変わったことにする。与えなければ画面は変わらない。

異常系の検証（サンドボックス指示書 §19）のために、特定の操作を必ず
失敗させる :attr:`SimulationInterface.failing_targets` を用意している。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Mapping

from automation.interface import (
    DEFAULT_TIMEOUT_SECONDS,
    Action,
    ActionKind,
    ActionResult,
    GameInterface,
    Screen,
)

logger = logging.getLogger(__name__)

#: ログ出力の接頭辞。実操作と見分けられるようにする。
SIMULATION_PREFIX = "SIMULATION: would"

#: 実ゲームで起きる画面遷移のうち、クリックが引き起こすもの。
#: 実装が増えたらここへ足す。ここに無い操作では画面は変わらない。
DEFAULT_TRANSITIONS: Mapping[tuple[Screen, str], Screen] = {
    (Screen.SORTIE_SELECT, "sortie_start"): Screen.SORTIE_MAP,
    (Screen.EXPEDITION, "mission_start"): Screen.HOME,
    (Screen.BUILD, "build_start"): Screen.BUILD,
    (Screen.DISMANTLE, "dismantle_confirm"): Screen.DISMANTLE,
}


@dataclass
class SimulationInterface(GameInterface):
    """操作をログと記録に落とすだけの :class:`GameInterface`。

    Example:
        >>> interface = SimulationInterface(screen=Screen.HOME)
        >>> interface.click("sortie_start", Screen.HOME).ok
        True
    """

    screen: Screen = Screen.HOME
    #: ``(画面, 操作対象) -> 遷移先``。
    transitions: Mapping[tuple[Screen, str], Screen] = field(default_factory=dict)
    #: ここに含まれる操作対象は必ず失敗する（異常系の検証用）。
    failing_targets: frozenset[str] = frozenset()
    #: 実行された操作の記録。
    actions: list[ActionResult] = field(default_factory=list)

    @property
    def simulated(self) -> bool:
        """常に ``True``。"""
        return True

    @property
    def action_targets(self) -> list[str]:
        """実行された操作対象の並び（テストと目視確認用）。"""
        return [result.action.target for result in self.actions]

    def get_state(self) -> Screen:
        """現在の画面を返す。"""
        return self.screen

    def navigate(self, destination: Screen) -> ActionResult:
        """画面を移動したことにする。"""
        action = Action(
            ActionKind.NAVIGATE,
            destination.value,
            self.screen,
            f"{self.screen.value} から {destination.value} へ移動",
        )
        if destination.value in self.failing_targets:
            return self._record(action, ok=False, message="移動に失敗しました")
        self.screen = destination
        return self._record(action, ok=True)

    def click(
        self,
        target: str,
        screen: Screen | None = None,
        description: str = "",
    ) -> ActionResult:
        """クリックしたことにする。

        ``screen`` を指定した場合、現在の画面と一致しなければ失敗させる。
        誤クリック防止（§15「操作対象確認」）をシミュレーションでも
        効かせるため。
        """
        action = Action(ActionKind.CLICK, target, screen, description)
        if screen is not None and self.screen is not screen:
            return self._record(
                action,
                ok=False,
                message=(
                    f"画面が違います: 期待 {screen.value} / 実際 {self.screen.value}"
                ),
            )
        if target in self.failing_targets:
            return self._record(action, ok=False, message="操作に失敗しました")

        next_screen = self.transitions.get((self.screen, target))
        if next_screen is not None:
            self.screen = next_screen
        return self._record(action, ok=True)

    def wait_for_state(
        self, expected: Screen, timeout: float = DEFAULT_TIMEOUT_SECONDS
    ) -> ActionResult:
        """画面が期待どおりかを確認する。

        シミュレーションでは時間が進まないので、待たずにその場で判定する。
        """
        action = Action(
            ActionKind.WAIT,
            expected.value,
            expected,
            f"{expected.value} を待つ（{timeout:g}s）",
        )
        if self.screen is expected:
            return self._record(action, ok=True)
        return self._record(
            action,
            ok=False,
            message=(
                f"画面が変わりませんでした: 期待 {expected.value} / "
                f"実際 {self.screen.value}"
            ),
        )

    def execute_action(self, action: Action) -> ActionResult:
        """任意の操作を実行する。"""
        if action.kind is ActionKind.NAVIGATE:
            return self.navigate(Screen(action.target))
        if action.kind is ActionKind.CLICK:
            return self.click(action.target, action.screen, action.description)
        return self.wait_for_state(Screen(action.target))

    def reset(self, screen: Screen = Screen.HOME) -> None:
        """記録を捨てて初期画面へ戻す。"""
        self.actions.clear()
        self.screen = screen

    def _record(self, action: Action, ok: bool, message: str = "") -> ActionResult:
        """操作を記録し、ログへ出す。"""
        result = ActionResult(
            action=action, ok=ok, simulated=True, message=message, screen=self.screen
        )
        self.actions.append(result)
        if ok:
            logger.info("%s %s", SIMULATION_PREFIX, action.describe())
        else:
            logger.warning("%s %s — %s", SIMULATION_PREFIX, action.describe(), message)
        return result


def build_interface(simulation_mode: bool) -> GameInterface:
    """設定に応じた :class:`GameInterface` を返す。

    Args:
        simulation_mode: ``config["automation"]["simulation_mode"]``。

    Returns:
        シミュレーション実装。

    Raises:
        NotImplementedError: 実操作を要求された場合。実 GUI 操作は
            Phase 5 で実装する。ここで黙ってシミュレーションへ
            落とすと、実行したつもりが何も起きていない状態になる。
    """
    if not simulation_mode:
        raise NotImplementedError(
            "実 GUI 操作は未実装です（Phase 5）。"
            "automation.simulation_mode を true にしてください。"
        )
    return SimulationInterface(transitions=dict(DEFAULT_TRANSITIONS))

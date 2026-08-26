"""実際に操作する :class:`~automation.interface.GameInterface` 実装。

開発指示書 §15 が GUI 自動化に必須としている項目を、ここで一度だけ
実装する。個々のタスクがこれらを書き忘れることが無いようにするため。

* **目的画面確認** … 操作前に現在の画面を読み、要求と違えば操作しない。
* **操作対象確認** … 論理名から位置が確定できなければ操作しない。
* **タイムアウト** … 画面の変化を無限には待たない。
* **操作結果確認** … 押した後に画面を読み直す。
* **操作失敗時 STOP** … 失敗は握り潰さず、失敗として返す。
  緊急停止のラッチは :class:`~tasks.base_task.BaseTask` が行う。
* **連続操作回数制限** … 1 度の予算を使い切ったら操作を止める。
  想定外の画面でループしても、無制限にクリックし続けない。
* **キルスイッチ** … 操作ごとに緊急停止キーを確認する。

なお :mod:`automation.simulation` と違い、こちらは
:class:`~automation.mouse_controller.PointerBackend` を通じて実際に
座標を押す。押した先がサンドボックスか OS かは backend が決める。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Callable

from automation.interface import (
    DEFAULT_TIMEOUT_SECONDS,
    Action,
    ActionKind,
    ActionResult,
    GameInterface,
    Screen,
)
from automation.keyboard_controller import KeyboardController
from automation.mouse_controller import MouseController
from automation.navigator import Navigator, UnreachableScreen
from automation.screen_detector import ScreenDetector, TargetNotFound

logger = logging.getLogger(__name__)

#: 1 度に許す操作回数の既定値。
DEFAULT_ACTION_BUDGET = 200

#: 画面の変化を待つときのポーリング間隔（秒）。
DEFAULT_POLL_INTERVAL = 0.2


@dataclass
class ControlledInterface(GameInterface):
    """検証付きで操作する :class:`GameInterface`。

    Args:
        detector: 画面判別と座標解決。
        mouse: カーソル操作。
        keyboard: キー入力とキルスイッチ。
        navigator: 画面遷移の経路探索。
        action_budget: 残りの操作回数。
        clock: 現在時刻（秒）を返す関数。タイムアウト計測に使う。
        sleep: 待機する関数。テストでは差し替える。
    """

    detector: ScreenDetector
    mouse: MouseController
    keyboard: KeyboardController
    navigator: Navigator = field(default_factory=Navigator)
    action_budget: int = DEFAULT_ACTION_BUDGET
    poll_interval: float = DEFAULT_POLL_INTERVAL
    clock: Callable[[], float] = field(default=None)  # type: ignore[assignment]
    sleep: Callable[[float], None] = field(default=None)  # type: ignore[assignment]
    #: 実行した操作の記録。
    actions: list[ActionResult] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.clock is None:
            import time

            self.clock = time.monotonic
        if self.sleep is None:
            import time

            self.sleep = time.sleep

    # ------------------------------------------------------------------
    # GameInterface
    # ------------------------------------------------------------------

    @property
    def simulated(self) -> bool:
        """OS の入力に触れないなら ``True``。"""
        return self.mouse.simulated

    @property
    def action_targets(self) -> list[str]:
        """実行した操作対象の並び。"""
        return [result.action.target for result in self.actions]

    def get_state(self) -> Screen:
        """現在の画面を返す。"""
        return self.detector.current_screen()

    def navigate(self, destination: Screen) -> ActionResult:
        """経路を求めて、1 手ずつ押しながら移動する。"""
        current = self.get_state()
        action = Action(
            ActionKind.NAVIGATE,
            destination.value,
            current,
            f"{current.value} から {destination.value} へ移動",
        )

        blocked = self._check_guards(action)
        if blocked is not None:
            return blocked

        try:
            steps = self.navigator.route(current, destination)
        except UnreachableScreen as exc:
            return self._record(action, ok=False, message=str(exc))

        for step in steps:
            result = self.click(step.target, step.from_screen, step.describe())
            if result.failed:
                return self._record(
                    action, ok=False, message=f"移動に失敗しました: {result.message}"
                )
            if self.get_state() is not step.to_screen:
                return self._record(
                    action,
                    ok=False,
                    message=(
                        f"画面が変わりませんでした: 期待 {step.to_screen.value} /"
                        f" 実際 {self.get_state().value}"
                    ),
                )
        return self._record(action, ok=True)

    def click(
        self,
        target: str,
        screen: Screen | None = None,
        description: str = "",
    ) -> ActionResult:
        """対象の位置を求めてクリックし、結果を確認する。"""
        action = Action(ActionKind.CLICK, target, screen, description)

        blocked = self._check_guards(action)
        if blocked is not None:
            return blocked

        current = self.get_state()
        if screen is not None and current is not screen:
            return self._record(
                action,
                ok=False,
                message=f"画面が違います: 期待 {screen.value} / 実際 {current.value}",
            )

        try:
            point = self.detector.point_for(target, current)
        except TargetNotFound as exc:
            return self._record(action, ok=False, message=str(exc))

        self.mouse.click(point)
        self.action_budget -= 1
        return self._record(action, ok=True, message=f"クリック {point}")

    def wait_for_state(
        self, expected: Screen, timeout: float = DEFAULT_TIMEOUT_SECONDS
    ) -> ActionResult:
        """画面が ``expected`` になるまで待つ。"""
        action = Action(
            ActionKind.WAIT,
            expected.value,
            expected,
            f"{expected.value} を待つ（{timeout:g}s）",
        )

        blocked = self._check_guards(action)
        if blocked is not None:
            return blocked

        deadline = self.clock() + timeout
        while True:
            current = self.get_state()
            if current is expected:
                return self._record(action, ok=True)
            if self.clock() >= deadline:
                return self._record(
                    action,
                    ok=False,
                    message=(
                        f"タイムアウトしました: 期待 {expected.value} /"
                        f" 実際 {current.value}"
                    ),
                )
            self.sleep(self.poll_interval)

    def execute_action(self, action: Action) -> ActionResult:
        """任意の操作を実行する。"""
        if action.kind is ActionKind.NAVIGATE:
            return self.navigate(Screen(action.target))
        if action.kind is ActionKind.CLICK:
            return self.click(action.target, action.screen, action.description)
        return self.wait_for_state(Screen(action.target))

    # ------------------------------------------------------------------
    # 予算とキルスイッチ
    # ------------------------------------------------------------------

    def reset_budget(self, budget: int = DEFAULT_ACTION_BUDGET) -> None:
        """操作回数の予算を戻す。"""
        self.action_budget = budget

    def _check_guards(self, action: Action) -> ActionResult | None:
        """キルスイッチと操作回数を確認する。

        Returns:
            操作してはいけない場合は失敗の :class:`ActionResult`、
            問題なければ ``None``。
        """
        if self.keyboard.poll_kill_switch():
            return self._record(
                action,
                ok=False,
                message=f"緊急停止キー（{self.keyboard.kill_switch_key}）が押されています",
            )
        if self.action_budget <= 0:
            return self._record(
                action, ok=False, message="連続操作回数の上限に達しました"
            )
        return None

    def _record(self, action: Action, ok: bool, message: str = "") -> ActionResult:
        """操作を記録し、ログへ出す。"""
        result = ActionResult(
            action=action,
            ok=ok,
            simulated=self.simulated,
            message=message,
            screen=self.get_state(),
        )
        self.actions.append(result)
        if ok:
            logger.info("%s", result.describe())
        else:
            logger.warning("%s", result.describe())
        return result

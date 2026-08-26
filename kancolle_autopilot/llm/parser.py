"""自然言語を構造化タスクへ変換する。

開発指示書 §18 の担当。**用途は変換だけに限る。** LLM に Python や
shell を実行させない。ここが返すのは
:class:`~llm.schema.TaskPlan` という値であって、実行の手続きではない。

LLM の出力は必ず :func:`~llm.schema.validate_plan` を通す。API 側の
``output_config.format`` でも JSON Schema を渡すが、それを信頼の根拠に
しない。二重に見えるが、モデルが約束を守ったかどうかを、こちら側で
確かめられる形にしておきたい。
"""

from __future__ import annotations

import json
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from llm.schema import (
    EFFICIENCY_LEVELS,
    OBJECTIVES,
    PLAN_JSON_SCHEMA,
    PROHIBITIONS,
    TASK_NAMES,
    SchemaError,
    TaskPlan,
    validate_plan,
)

logger = logging.getLogger(__name__)

#: 既定のモデル。
DEFAULT_MODEL = "claude-opus-5"

#: 変換は短い抽出なので、深く考えさせる必要はない。
DEFAULT_EFFORT = "low"

#: 出力は小さいが、詰まって切れると解析できなくなるので余裕を持たせる。
DEFAULT_MAX_TOKENS = 16000

SYSTEM_PROMPT = f"""あなたは艦これ運用補助システムの入力変換器です。
提督からの日本語の指示を、決められた JSON へ変換することだけが仕事です。

守ること:
- 出力は指定されたスキーマに従う JSON のみ。説明文を混ぜない。
- 指示に無いタスクを足さない。曖昧なら tasks を空にして goal だけ埋める。
- 使えるタスク名: {', '.join(sorted(TASK_NAMES))}
- 使える目標: {', '.join(sorted(OBJECTIVES))}
- 使える禁止事項: {', '.join(sorted(PROHIBITIONS))}
- 資源効率: {', '.join(sorted(EFFICIENCY_LEVELS))}

対応の目安:
- 「デイリー」→ tasks に daily
- 「遠征」→ tasks に expedition
- 「周回」「戦果稼ぎ」→ tasks に sortie
- 「建造」「工廠」→ tasks に construction
- 「N-M のゲージを割って」→ goal.map=N-M, goal.objective=destroy_gauge
- 「戦果 +N」→ goal.objective=farm_rank_points, goal.rank_points=N
- 「大破進撃は禁止」→ constraints.prohibit に advance_with_heavy_damage
- 「資源節約重視」→ optimization.resource_efficiency=high
- 「捨て艦戦法を許可」→ strategy_options.disposable_ship_strategy=allowed
- 「明日の10:52に」→ schedule.type=once, schedule.time=10:52

時刻は JST の 24 時間表記（HH:MM）で書きます。"""


class ParseError(Exception):
    """自然言語を計画へ変換できなかった。"""


class LLMClient(ABC):
    """自然言語を JSON にするもの。"""

    @abstractmethod
    def complete_json(
        self, system: str, user: str, json_schema: Mapping[str, Any]
    ) -> str:
        """JSON 文字列を返す。

        Raises:
            ParseError: 応答を得られなかった場合。
        """


@dataclass
class StubClient(LLMClient):
    """あらかじめ決めた応答を返す。テスト用。"""

    responses: Sequence[str] = ()
    #: 受け取ったプロンプトの記録。
    prompts: list[tuple[str, str]] = field(default_factory=list)
    error: Exception | None = None
    _index: int = 0

    def complete_json(
        self, system: str, user: str, json_schema: Mapping[str, Any]
    ) -> str:
        """次の応答を返す。"""
        self.prompts.append((system, user))
        if self.error is not None:
            raise self.error
        if self._index >= len(self.responses):
            raise ParseError("応答が尽きました")
        response = self.responses[self._index]
        self._index += 1
        return response


@dataclass
class AnthropicClient(LLMClient):
    """Claude へ問い合わせる。

    Args:
        model: 使用するモデル。
        effort: 思考の深さ。変換は短い抽出なので既定は ``low``。
        max_tokens: 出力の上限。
        client: 差し替える ``anthropic.Anthropic`` インスタンス。

    Note:
        ``anthropic`` パッケージは遅延 import する。通知や LLM を使わない
        構成では入っていなくてよい。
    """

    model: str = DEFAULT_MODEL
    effort: str = DEFAULT_EFFORT
    max_tokens: int = DEFAULT_MAX_TOKENS
    client: Any = None

    def _ensure_client(self) -> Any:
        """SDK のクライアントを用意する。

        Raises:
            ParseError: ``anthropic`` が入っていない場合。
        """
        if self.client is not None:
            return self.client
        try:
            import anthropic
        except ImportError as exc:  # pragma: no cover - 環境依存
            raise ParseError(
                "anthropic パッケージが入っていません（pip install anthropic）"
            ) from exc
        self.client = anthropic.Anthropic()
        return self.client

    def complete_json(
        self, system: str, user: str, json_schema: Mapping[str, Any]
    ) -> str:
        """Claude に JSON を作らせる。

        ``output_config.format`` でスキーマを渡し、応答が拒否だった場合は
        content を読む前に弾く。サーバ側フォールバックを有効にしてある
        ので、安全分類器による誤検知は別モデルで再実行される。

        Raises:
            ParseError: 応答が拒否された、またはテキストが無い場合。
        """
        client = self._ensure_client()
        response = client.beta.messages.create(
            model=self.model,
            max_tokens=self.max_tokens,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=system,
            messages=[{"role": "user", "content": user}],
            thinking={"type": "adaptive"},
            output_config={
                "effort": self.effort,
                "format": {"type": "json_schema", "schema": dict(json_schema)},
            },
        )

        # content を読む前に stop_reason を見る。
        if getattr(response, "stop_reason", None) == "refusal":
            details = getattr(response, "stop_details", None)
            category = getattr(details, "category", None) if details else None
            raise ParseError(f"応答が拒否されました（category={category}）")

        for block in response.content:
            if getattr(block, "type", None) == "text":
                return block.text
        raise ParseError("応答にテキストがありませんでした")


@dataclass
class TaskParser:
    """自然言語 → 構造化タスク。

    Example:
        >>> parser = TaskParser(client)
        >>> plan = parser.parse("明日の10:52からデイリー、その後遠征")
        >>> plan.tasks[0].name
        'daily'
    """

    client: LLMClient
    system_prompt: str = SYSTEM_PROMPT

    def parse(self, text: str) -> TaskPlan:
        """指示を計画へ変換する。

        Args:
            text: 提督からの指示。

        Returns:
            検証済みの計画。

        Raises:
            ParseError: 空の指示、JSON として読めない応答、または
                スキーマ検証に失敗した場合。
        """
        instruction = text.strip()
        if not instruction:
            raise ParseError("指示が空です")

        raw = self.client.complete_json(
            self.system_prompt, instruction, PLAN_JSON_SCHEMA
        )
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            logger.warning("LLM の応答が JSON ではありません: %r", raw[:200])
            raise ParseError(f"応答を JSON として読めません: {exc}") from exc

        try:
            # API 側でもスキーマを渡しているが、それを信頼の根拠にしない。
            return validate_plan(data)
        except SchemaError as exc:
            logger.warning("LLM の応答がスキーマに合いません: %s", exc)
            raise ParseError(f"応答がスキーマに合いません: {exc}") from exc

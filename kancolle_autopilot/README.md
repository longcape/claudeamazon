# kancolle_autopilot

「艦これ Auto-Pilot 開発指示書」に基づく運用補助システム。

現在の到達点は **Phase 1**。保存済みの kcsapi ログを読み込み、ゲームの
現在状態を再構築し、資材の安全条件を判定できるところまで。

## 現時点でできること / できないこと

できること

- kcsapi の応答（母港・資材・艦・艦隊・入渠・建造・任務・出撃・戦闘結果・
  遠征帰投・解体）をイベントへ変換する
- イベントを適用して `GameState` を再構築する
- 未所持艦のドロップを検出して保護要求イベントを出す
- 資材の下限割れを判定する
- 保存ログを再生して上記を目視確認する（`main.py`）

できないこと（未実装）

- 実ゲームへの接続、GUI 操作、自動出撃・自動解体・自動建造
- TaskQueue / StateMachine / Scheduler
- Discord 連携、LLM によるタスク解釈

なお開発指示書 §2 のとおり、**自動化検知の回避を目的とした機能は実装しない**。
UI の応答待ち・操作対象の検証・誤クリック防止・異常時停止といった、
安全性と UI 安定性のための待機や検証のみを扱う。

## 動かし方

```bash
cd kancolle_autopilot
pip install -r requirements.txt

# 保存ログを再生して状態と安全判定を表示（読み取り専用）
python main.py --log data/fixtures/scenario_unknown_drop.jsonl

# テスト
python -m pytest
```

`--log` にはファイルまたはディレクトリを渡せる。単一 JSON・JSON 配列・
JSON Lines のいずれにも対応する。終了コードは、安全判定が STOP なら `2`、
入力エラーなら `1`、正常なら `0`。

## ディレクトリ構造

実装済みのものだけを挙げる。括弧内は担当 Phase。

```
kancolle_autopilot/
├─ main.py                    再生用 CLI（Phase 1）
├─ config.json                設定
├─ pytest.ini
├─ core/
│  ├─ config_manager.py       設定の読み込み・検証・atomic save
│  └─ state.py                ドメインモデル（艦・艦隊・資材・任務…）
├─ monitor/
│  ├─ api_parser.py           kcsapi 応答 → イベント（状態を持たない）
│  └─ game_state.py           イベント → 現在状態（派生イベントを返す）
├─ safety/
│  └─ resource_guard.py       資材下限の判定
├─ data/fixtures/             再生用シナリオ
└─ tests/                     unit test と kcsapi フィクスチャ
```

未作成（今後の Phase）: `core/task_queue.py`, `core/state_machine.py`,
`core/scheduler.py`, `monitor/log_monitor.py`, `safety/safety_manager.py`,
`safety/damage_guard.py`, `safety/lock_guard.py`, `automation/`, `tasks/`,
Discord 層, `llm/`。

## 設計上の決定

### 不明を正常とみなさない

ドメインモデルでは未取得の値を `None` で表し、`0` や `False` で埋めない。
`Ship.locked` が `None`（不明）の艦は `is_protected` が `True` になり、
破棄対象から外れる。資材が未取得の場合、`ResourceGuard` は「足りている」
ではなく `STOP` を返す。

### パーサは状態を持たない

`APIParser` は 1 件の応答だけを見て判断できることのみをイベント化する。
履歴が要る判断は `GameState` が行い、**派生イベント**として返す。

- 母港応答が来た → `SORTIE_ENDED`
- 未所持艦がドロップした → `UNKNOWN_SHIP_DROPPED`

`GameState.apply()` の戻り値がそのまま再配信できる形になっているので、
Phase 2 のイベントバスはこれを流すだけでよい。

### 設定は厳格に検証する

未知のキーは警告ではなくエラーにする。`min_feul` のような綴り間違いを
黙って無視すると、閾値が効かないまま資材が枯渇する。`bool` は `int` の
サブクラスなので、数値項目に `true` が来た場合も別途弾く。

## 既知の問題・注意点

1. **図鑑情報が所有艦由来**。`encyclopedia_master_ids` は現在の所有艦から
   育つため、過去に解体した艦種は「未所持」と誤判定される。誤りの向きは
   常に保護しすぎる側なので保護漏れは起きないが、余計な停止が増える。
   永続化した図鑑を `GameState.seed_encyclopedia()` へ流し込めば解消する。
2. **`api_get_member/mission` は遠征、`api_get_member/questlist` は任務**。
   kcsapi 側の名前が紛らわしい。本実装では前者を `EXPEDITION_*`、後者を
   指示書 §6 に合わせて `MISSION_UPDATED` としている。
3. **`discord/` というパッケージ名**は `discord.py` を隠す。Phase 6 に入る
   前に `notify/` などへ改名するか、名前空間を分ける判断が要る。
4. **建造レシピと解体対象はリクエスト側にしかない**。専ブラのログが
   `postBody` を記録していない場合、レシピと解体艦 ID は取得できない。
5. **遠征報酬は資材へ加算していない**。`api_get_material` は増加量であり
   絶対値ではないため、資材は次の母港応答で確定させている。
6. **連合艦隊は未モデル化**。`api_req_combined_battle/battleresult` は
   ドロップ検出のみ対応している。
7. **時刻はすべて UTC**。艦これの日付変更は JST 05:00 なので、デイリー
   判定を実装する Phase 4 で境界の扱いを決める必要がある。
8. **`SORTIE_ENDED` は母港応答から導出している**。ログが母港応答を取り
   こぼすと出撃が開いたままになる。Phase 2 の `log_monitor` でログの
   鮮度監視（`GameState.is_stale`）と併用する前提。

## 次の Phase

Phase 2: `log_monitor`, `resource_guard` の統合, `damage_guard`,
`lock_guard`, `safety_manager`。

Phase 2 に入る前に、上記 3（`discord/` の命名）と 7（JST 境界）は
方針を決めておきたい。

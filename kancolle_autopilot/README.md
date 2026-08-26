# kancolle_autopilot

「艦これ Auto-Pilot 開発指示書」に基づく運用補助システム。

現在の到達点は **Phase 2**。保存済み／稼働中の kcsapi ログを読み込んで
ゲームの現在状態を再構築し、資材・損傷・艦の保護について安全判定を
返せるところまで。

## 現時点でできること / できないこと

できること

- kcsapi の応答（母港・資材・艦・艦隊・入渠・建造・任務・出撃・戦闘結果・
  遠征帰投・解体）をイベントへ変換する
- ログディレクトリを監視して、新規ファイルと追記を検出する
- イベントを適用して `GameState` を再構築する
- 未所持艦のドロップを検出し、ロックが確認できるまで停止し続ける
- 資材の下限割れ、大破・状態不明の艦隊、破棄してはならない艦を判定する
- 緊急停止をラッチする（自動復帰しない）
- 保存ログの再生とライブ監視を CLI で確認する

できないこと（未実装）

- 実ゲームへの接続、GUI 操作、自動出撃・自動解体・自動建造
- TaskQueue / StateMachine / Scheduler
- 通知連携、LLM によるタスク解釈

開発指示書 §2 のとおり、**自動化検知の回避を目的とした機能は実装しない**。
UI の応答待ち・操作対象の検証・誤クリック防止・異常時停止といった、
安全性と UI 安定性のための待機と検証のみを扱う。

## 動かし方

```bash
cd kancolle_autopilot
pip install -r requirements.txt

# 保存ログを再生して状態と安全判定を表示（読み取り専用）
python main.py replay --log data/fixtures/scenario_unknown_drop.jsonl

# ログディレクトリを監視して、更新のたびに状態を表示（読み取り専用）
python main.py watch --log "C:/poi/kcsapi" --fleet 1

# テスト
python -m pytest
```

`--log` にはファイルまたはディレクトリを渡せる。単一 JSON・JSON 配列・
JSON Lines のいずれにも対応する。`--fleet` を付けると、その艦隊の
損傷判定を安全判定に含める。

終了コードは、安全判定が STOP なら `2`、入力エラーなら `1`、
それ以外は `0`。

## ディレクトリ構造

実装済みのものだけを挙げる。

```
kancolle_autopilot/
├─ main.py                    replay / watch の CLI
├─ config.json                設定
├─ core/
│  ├─ config_manager.py       設定の読み込み・検証・atomic save
│  └─ state.py                ドメインモデル（艦・艦隊・資材・任務…）
├─ monitor/
│  ├─ api_parser.py           kcsapi 応答 → イベント（状態を持たない）
│  ├─ game_state.py           イベント → 現在状態（派生イベントを返す）
│  └─ log_monitor.py          ログディレクトリのポーリング監視
├─ safety/
│  ├─ verdict.py              SafetyLevel / SafetyVerdict
│  ├─ resource_guard.py       資材下限
│  ├─ damage_guard.py         大破・状態不明・疲労
│  ├─ lock_guard.py           破棄の可否とブラックリスト
│  └─ safety_manager.py       集約・ラッチ・保護待ちの管理
├─ data/
│  ├─ blacklist.json          破棄禁止の艦種（**要設定**）
│  └─ fixtures/               再生用シナリオ
└─ tests/                     unit test と kcsapi フィクスチャ
```

未作成（今後の Phase）: `core/task_queue.py`, `core/state_machine.py`,
`core/scheduler.py`, `core/gametime.py`, `automation/`, `tasks/`,
`notify/`, `llm/`。

## 使う前に設定が要るもの

`data/blacklist.json` は **空の状態で同梱している**。空のままだと
`LockGuard` はすべての破棄候補を拒否する（保護が丸ごと無効になるより、
何も解体できないほうが安全なため）。使う場合は `api_start2` の
`api_mst_ship` から実際の `api_id` を引いて記入する。

```json
{
  "allow_empty": false,
  "entries": [{"master_id": 000, "name": "まるゆ"}]
}
```

ID を推測で書かないこと。間違った ID は「保護されていない艦」を作る。
意図的に空で運用する場合のみ `allow_empty` を `true` にする。

## 設計上の決定

### 不明を正常とみなさない

ドメインモデルでは未取得の値を `None` で表し、`0` や `False` で埋めない。

- `Ship.locked` が `None`（不明）の艦は破棄候補から外れる
- 資材が未取得なら `ResourceGuard` は「足りている」ではなく `STOP`
- 艦種が特定できないドロップは「所持済み」ではなく保護対象
- 編成中の艦の HP が取れていなければ、その艦隊は出撃不可

### パーサは状態を持たない

`APIParser` は 1 件の応答だけを見て判断できることのみをイベント化する。
履歴が要る判断は `GameState` が行い、**派生イベント**として返す。

- 母港応答が来た → `SORTIE_ENDED`
- 未所持艦がドロップした → `UNKNOWN_SHIP_DROPPED`

`GameState.apply()` の戻り値がそのまま再配信できる形になっている。

### 鮮度はログの時刻ではなく受信時刻で測る

`GameState` は「イベントが発生したと主張している時刻」
（`last_event_at`）と「実際に受け取った時刻」（`last_observed_at`）を
分けて持ち、`is_stale` は後者を使う。専ブラの時計がずれていたり、
過去ログを再生したりしたときに誤って緊急停止しないため。

### 緊急停止はラッチする

`SafetyManager.trigger_emergency_stop()` を呼ぶと、`clear_emergency_stop()`
まで停止したままになる。次の走査でたまたま資材が回復して見えても
自動復帰しない。未確認ドロップの保護待ちも同様で、該当艦種の
**ロック済み個体を所有していることを確認するまで**解消しない
（艦種が特定できなかった場合は自動では解消せず、人手での確認が要る）。

### 起動時に過去ログを読まない

`LogMonitor` は既定で既存ファイルを末尾まで読み飛ばす。古いログを
再生すると実際とは違う状態を「現在の状態」として組み立ててしまう。
読み飛ばした結果、最初の母港応答までは状態不明のままだが、それは
`is_stale` と安全装置が扱う。`monitor.read_existing` で変更できる。

## 保留していた判断（決定済み）

- **`discord/` は `notify/` にする。** `discord.py` を隠すのを避け、
  通知先が増えても名前が破綻しないため。Phase 6 で作成する。
- **内部時刻はすべて UTC のまま扱い、ゲーム日付への変換は専用モジュール
  に閉じる。** 艦これの日付変更は JST 05:00、週次は月曜 05:00。
  `core/gametime.py` として Phase 4（デイリー判定）で実装する。

## 既知の問題・注意点

1. **図鑑情報が所有艦由来**。`encyclopedia_master_ids` は現在の所有艦から
   育つため、過去に解体した艦種は「未所持」と誤判定される。誤りの向きは
   常に保護しすぎる側なので保護漏れは起きないが、余計な停止が増える。
   永続化した図鑑を `GameState.seed_encyclopedia()` へ流し込めば解消する。
2. **`api_get_member/mission` は遠征、`api_get_member/questlist` は任務**。
   kcsapi 側の名前が紛らわしい。本実装では前者を `EXPEDITION_*`、後者を
   指示書 §6 に合わせて `MISSION_UPDATED` としている。
3. **建造レシピと解体対象はリクエスト側にしかない**。専ブラのログが
   `postBody` を記録していない場合、レシピと解体艦 ID は取得できない。
4. **遠征報酬は資材へ加算していない**。`api_get_material` は増加量であり
   絶対値ではないため、資材は次の母港応答で確定させている。
5. **連合艦隊は未モデル化**。`api_req_combined_battle/battleresult` は
   ドロップ検出のみ対応している。
6. **`SORTIE_ENDED` は母港応答から導出している**。ログが母港応答を
   取りこぼすと出撃が開いたままになる。
7. **`LogMonitor` はポーリング**。走査間隔より短い周期でファイルが
   作られて消える環境では取りこぼす。専ブラの通常の出力では起きない。

## 次の Phase

Phase 3: `core/task_queue.py`, `core/state_machine.py`, `core/scheduler.py`。

優先度付きキュー（EMERGENCY_STOP 1000 〜 BACKGROUND 100、同一優先度は
FIFO）と、明示的な状態遷移。`SafetyManager` がすべての Task より上位に
立つ構造は既にできているので、Phase 3 はその上に載せる形になる。

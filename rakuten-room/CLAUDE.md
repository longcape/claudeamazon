# rakuten-room — 楽天ROOM運用エンジン

## 現行方針（2026-09-01確定）

**ソーシャルギフト特化「贈りもの迷子｜住所なしギフト」。**

- 棚は1つ、テーマはソーシャルギフト。**価格帯や用途の違いは別ジャンルではなく、同じ棚の中のコレクション**として扱う
- 導線は TikTok / YouTube Shorts / Instagram Reels → 楽天ROOM → 楽天市場。
  商品選定では「ROOM内で売れるか」だけでなく**短尺動画のネタとして成立するか**も見る
- NG検査の1項目めは「ジャンル散乱」ではなく**「ギフト用途として成立しない商品の混入」**
- ジャンルは横断する（`rootGenreId: "0"`）。棚の同一性はジャンルではなくギフト適性で担保する

**旧方針「キッチンと収納」は2026-09-01に廃止した。** 経緯は上位の
`03_楽天ROOM自動化/PROJECT_CONTEXT.md` の旧方針節を正とする。
`README.md` / `START-HERE.md` / `HANDOFF.md` には旧方針時点の記述が残っており、
各文書の冒頭に注意書きを付けてある。**現行の評価軸と重みは `config/strategy.json` と
`src/pipeline/gift.js` を正とする。**

楽天市場のデータから、楽天ROOMの商品選定・紹介文・投稿順・投稿時刻を自動生成する。
**依存パッケージなし**（Node.js 18+ と標準ライブラリのみ）。CommonJS。

- 操作マニュアル（非エンジニア向け） → `START-HERE.md`
- 使い方 → `README.md`
- 経緯と未検証点 → `HANDOFF.md`

## 運用者について

**このプロジェクトの運用者はターミナル操作に不慣れである。**
コマンドは運用者に打たせず、こちらで実行すること。
運用者に依頼するのは、ブラウザでの操作（楽天のID取得など）と、
楽天ROOMへの貼り付け、実績数値の報告だけに限る。
専門用語を使うときは、その場で短く言い換えを添える。

運用者はZIPでファイルを取得しており、GitHubとは繋がっていない。
更新の取り込みやバックアップを頼まれたら、git の設定から代行すること。

## コマンド

```bash
npm test                     # 43件。変更したら必ず通す
node bin/room.js doctor      # 設定と接続
node bin/room.js probe       # 実データの充足率を点検
node bin/room.js collect     # 候補収集。定点観測を1日分残す（毎日）
node bin/room.js portfolio   # 100商品の台帳（主力20/準主力30/ロングテール50）
node bin/room.js launch      # 初動30件の投稿計画
node bin/room.js plan        # 通常運用の投稿計画
node bin/room.js backup      # 作り直せないデータの退避
```

## 壊してはいけない不変条件

1. **売上投稿(cv)は必ず評価取り投稿(bait)の直後に来る。**
   `src/plan/sequence.js` の `arrange()` がペア確定方式でこれを保証している。
   パターン列を頭から消費する方式に戻すと、末尾で bait が尽きて cv が連続する。
   `test/pipeline.test.js` の該当テストがこれを固定している。
2. **棚ならし(`src/plan/shelf.js`)は同じ役割どうししか入れ替えない。** 役割をまたぐと1が壊れる。
3. **紹介文には「誰の/どんな悩みが/どう変わるか」が必ず入る。** 欠けたら NG検査が計画ごと止める。
4. **初動30件は全件ゴールデンタイム(20-23時 JST)。** 時刻はJST固定オフセットで計算する（`src/util/time.js`）。

## 変更するとき

- **まず `config/strategy.json` で足りないか考える。** 全パラメータが外出しされており、
  ジャンル・価格帯・時間帯・比率・重みはコードを触らず変えられる。
- 紹介文の質は `config/copy-lexicon.json` の `featureRules` を厚くするのが最も効く。
- コードを変えたら `npm test`。テストは仕様書として機能している。

## 環境

- `.env` に `RAKUTEN_APP_ID` / `RAKUTEN_ACCESS_KEY` / `RAKUTEN_APP_URL` の3つが必要
  （`RAKUTEN_AFFILIATE_ID` は任意だが実運用では必須）
- `ANTHROPIC_API_KEY` があれば紹介文をLLMで自然化する（任意・未設定でも完結する）
- `data/` は `.gitignore` 対象。**消すと売上速度と投稿履歴が失われる**。定期バックアップを促すこと
- `ROOM_DATA_DIR` / `ROOM_OUT_DIR` で保存先を差し替えられる（テストはこれを使う）

## 既知の落とし穴

- **楽天APIは2026年に移行済み。仕様は必ず公式ドキュメントで確認すること**（記憶で書くと壊れる）
  - 旧 `app.rakuten.co.jp/services/api/...` は2026-02-09に停止。現行は `openapi.rakuten.co.jp` 配下で
    APIごとに接頭辞が違う（`ichibams` / `ichibaranking` / `ichibagt`）
  - アプリIDはUUID形式。数字20桁だったのは旧仕様
  - `applicationId` 単体では通らない。`accessKey` との併用が必須（本エンジンはヘッダで送る）
  - **`Origin` ヘッダが必須。** ゲートウェイはこれを「アクセス元」として読み、アプリ設定の
    **「許可されたウェブサイト」**（Application URL ではない）と照合する。`RAKUTEN_APP_URL` がその値。
    送らないと `REQUEST_CONTEXT_BODY_HTTP_REFERRER_MISSING`、合わないと `HTTP_REFERRER_NOT_ALLOWED` で403。
    **`Referer` ヘッダは見ていない**（実測で確認済み）
  - `field` は意味が変わった。旧「0=全情報取得」ではなく **新「0=広めに検索 / 1=絞って検索」**。
    返すフィールドの制御は `elements` に移り、未指定なら全項目返る。**`field` は渡さないこと**
  - ランキングの `period` は `realtime` のみ。`daily` は廃止
  - ジャンル応答は `current`/`genreName`/`parents` → `genre`/`nameJa`/`ancestors`。商品の `tagIds` は `attributeIds`
- **`config/strategy.json` の genre は実在確認をすること。** 初期値の `rootGenreId: 100938` は
  「インテリア・寝具・収納」ではなく **ダイエット・健康** だった（インテリア・寝具・収納は `100804`）。
  `node bin/room.js genre 0` で必ず実物を引くこと
- **商品のジャンルIDは3〜4階層目に付く。** 直下の子だけで所属を判定すると候補の7割が「圏外」になり、
  aiFitのカテゴリ相関とNG1が同時に壊れる。`src/index.js` の `genreDescendants` は祖先まで辿る実装
- **定点観測・投稿履歴・実績は消えると復元できない。** 2026-09-01にフォルダ消失で
  定点観測2日分を失い、売上速度の計測がゼロに戻った。対策として
  `data/snapshot-*.json` / `history.json` / `results.json` だけ **Git追跡対象に変更した**
  （商品コードと公開値のみで秘密情報を含まない）。`candidates-*` と `plan-*` は
  作り直せるので追跡しない。`node bin/room.js backup` でローカル退避も取れる。
  **collect のあとはコミットすること。**
- レートは1リクエスト1.1秒（`src/rakuten/client.js`）。429が続くなら間隔を上げる
- 初日は売上速度が未計測なのでスコアが低く出る。選定基準の自動緩和はこのための仕組みで、
  初回に緩むのは正常
- 30件出すには1ショップ3商品上限の関係で最低10ショップぶんの候補が要る

## 書き方

コメントも出力も日本語。既存コードのスタイル（`'use strict'`、function宣言、2スペース）に合わせる。

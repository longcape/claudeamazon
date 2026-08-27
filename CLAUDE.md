# VALORANT TACTICAL SETUP CARD

VALORANT 競技シーン向けの、ラウンド単位の戦術コール管理ツール。
試合前に戦術を登録し、直前ラウンドの勝敗をもとに次の戦術を選び直していく。

このファイルは Claude Code 向けの作業メモ。
**過去に一度やって失敗した判断をもう一度させないため**に書いてある。

---

## 動かす / ビルドする

```bash
# 開発中はこれだけ。ビルド不要でそのまま動く
open index.html            # Windows なら index.html をダブルクリック

# 配布用の単一 HTML を作り直す（index.html や assets を触ったら必ず実行）
node build.js

# 公式画像を取り込む（後述の「取得できない環境」に注意）
node tools/fetch-assets.mjs

# 動作確認（playwright が入っていれば動く。入っていなければ skip する）
node tools/smoke-test.mjs
```

`node build.js` の生成物:

| ファイル | 用途 |
| --- | --- |
| `dist/valorant-tactical-setup-card.html` | 配布・オフライン用のスタンドアロン |
| `dist/artifact-body.html` | 公開ページ用（外側の `html`/`head`/`body` を持たない） |

`build.js` は `index.html` の `<script src>` を**読んで**バンドルする。
モジュールを増やしたら `index.html` に `<script>` を足すだけでよく、
`build.js` 側にファイル名を書き足す必要はない。
（以前ここにファイル一覧をベタ書きしていて、新しいモジュールが
だまってバンドルから漏れる事故を起こした。）

---

## 作りの前提

**依存パッケージなし・ビルド不要の静的アプリ。** これは意図的な制約で、
崩すと配布方法（HTML 1 枚を渡す／URL を開く）が成立しなくなる。

- **クラシックスクリプトのみ。ES モジュールは使わない。**
  `file://` で開いたときに ES モジュールは CORS で落ちるため。
  各ファイルは IIFE で `window.VCT_*` に生やす。
- npm パッケージをランタイムに足さない。`sharp` と `playwright` は
  開発ツール専用で、アプリ本体からは参照しない。
- コメントは日本語。**「何をしているか」ではなく「なぜそうしたか」**を書く。
  コードを読めば分かることは書かない。

### 読み込み順（`index.html` の末尾）

順番に意味がある。依存の向きは常に下向き。

```
config → i18n → locales(ja/en/ko) → data → agent-traits → abilities
  → portraits → maps-layout → official-assets → store
  → advisor → analyst → board → share → community → ui → app
```

`official-assets.js` は**自動生成**（`tools/fetch-assets.mjs` が書く）。
手で編集しない。`portraits` / `maps-layout` / `abilities` の
空テーブルに後から `Object.assign` で流し込む形なので、
これらより**後**に読む必要がある。

例外: スパイク画像だけは `board.js` がこれより後に読まれるので
`Object.assign` できない。素のグローバル `window.VCT_OFFICIAL_SPIKE` に置いている。

### グローバル

| 名前 | ファイル | 役割 |
| --- | --- | --- |
| `VCT_CONFIG` | config.js | Supabase / AI 寸評の接続設定。空でもアプリは完全に動く |
| `VCT_I18N` | i18n.js | 辞書と `t()`。現在の言語 → en → 組み込み既定 の順に落ちる |
| `VCT_DATA` | data.js | エージェント 29 体 / マップ 13 種 / 戦術タイプ |
| `VCT_TRAITS` | agent-traits.js | 相性判定用のタグ |
| `VCT_ABILITIES` | abilities.js | スキル名とアイコン |
| `VCT_PORTRAITS` | portraits.js | 顔アイコンと各エージェントの識別色 |
| `VCT_MAPS` | maps-layout.js | マップ簡易図・公式ミニマップ・**向きの補正角** |
| `VCT_STORE` | store.js | 状態と localStorage への保存。正規化もここ |
| `VCT_ADVISOR` | advisor.js | 次ラウンドの戦術推奨スコア |
| `VCT_ANALYST` | analyst.js | 構成の相性判定（ルールベース） |
| `VCT_BOARD` | board.js | 配置盤のデータ構造と SVG 描画 |
| `VCT_SHARE` | share.js | X ポスト / クリップボード |
| `VCT_COMMUNITY` | community.js | Supabase（PostgREST / GoTrue を直接 fetch） |
| `VCT_UI` | ui.js | 描画。DOM を作るのは基本ここだけ |
| （なし） | app.js | 状態遷移とイベント結線。UI 状態 `ui` を持つ |

---

## データ構造

`localStorage` に `VCT_STORE.state` を丸ごと入れている。
読み込み時に `normalizeTactic` / `normalizePhases` / `normalizeBoard` が
**壊れた入力でも落ちない形に作り直す**。
バージョン番号は持たず、この正規化で旧形式を吸収する方針。

```js
tactic = {
  id, name, side: 'ATK'|'DEF'|'BOTH', site, kind, note,
  phases: [                      // 局面。最大 4 枚（board.js の MAX_PHASES）
    {
      id, name,                  // 名前は空でよい。空なら「局面 N」と表示
      marks: [{ id, kind, ref, team, x, y, order }],
      routes: [{ id, team, points: [{x, y}] }]
    }
  ]
}
```

- `kind` は `'agent' | 'ability' | 'plant'`。
  **`normalizeBoard` で kind を潰さないこと。** 以前 `agent`/`ability` しか
  通しておらず、プラント位置が再読み込みでエージェントに化けていた。
- `ref` は agent なら `'jett'`、ability なら `'jett:C'`、plant なら `'spike'`。
- 座標は **0-100 の正規化空間**。マップ画像のサイズに依存しない。
- `order`（スキルの使用順）は**エージェントごとに 1 から**振る。
  「ジェットの 1 個目 / 2 個目」と読むため。チーム全体の通し番号ではない。
- `plant` は 1 つの盤面に 1 つだけ。置き直すと前のものと入れ替わる。

`VCT_BOARD` の操作関数は**戦術ではなく盤面（phase）を受け取る**。
`B.phases(tactic)` / `B.phaseAt(tactic, i)` で取り出してから渡す。
旧形式（`tactic.board` が 1 枚だけ）は `phases()` が 1 枚目として引き継ぐ。

---

## 触る前に知っておくこと

### 公式画像は valorant-api.com から取る

`tools/fetch-assets.mjs` が `assets/img/` に落として
`assets/js/official-assets.js` を書き出す。取得するもの:

- エージェントの顔（192px）
- スキルのアイコン（96px）— 全 116 個
- マップのミニマップ（512px）
- スパイク（96px）— ゲームモード「スタンダード」の表示アイコンがそれ

**スロットの対応を間違えないこと。**
`Ability1` が **Q**、`Ability2` が **E**。ここを逆にすると全エージェントで
Q と E が入れ替わる。`verifySlots()` がそれを検出して警告する。

**画像は必ず縮小してから入れる。** 元データは 1024px あり、
data URI にすると単一 HTML が 16MB を超えて公開できなくなる。
`sharp` が入っていれば自動で縮む。

**Claude Code の web/cloud セッションからは取得できない。**
egress proxy が `valorant-api.com` を 403 で塞いでいる（ポリシー拒否であって
回避できるものではない）。取得は次のどちらかでやること。

1. **GitHub Actions**（推奨・PC 作業なし）
   Actions タブ → 「公式画像の取得」→ Run workflow。
   GitHub の実行環境からは valorant-api.com に繋がる。
   取得 → `node build.js` → 変化があればコミット、まで通る。
   毎月 1 日にも自動で走る（`.github/workflows/fetch-assets.yml`）。
2. **ローカル** — Windows は `画像を取得.bat` をダブルクリック、
   Mac は `画像を取得.command`。

### 公式ミニマップは向きがばらばら

マップごとに縦長だったり横長だったりする。
**ディフェンダースポーンが上・アタッカースポーンが下**に揃えるため、
`maps-layout.js` の `ROTATION` に時計回りの補正角を持たせている。

角度は目分量ではなく画像から機械的に求めた。
ボムサイトは必ずディフェンダースポーン寄りにあるので、
サイト（画像上で黄土色 `rgb(152,152,118)` に塗られた領域）の重心から
画像全体の重心へ向かう向きがアタッカー側を指す。
それが真下になる角度を 90 度単位に丸めている。

回転が掛かるのは**下地の画像だけ**。置いたマークやルートは
回転後の見た目の上に載っているので影響を受けない。

フラクチャーだけは例外で 0 度のまま。アタッカーが南北の両側から
攻めるため「アタッカー側が下」に揃えようがない。

新マップを足したら `ROTATION` にも足すこと（未登録なら 0 が使われる）。

### スキルの同時展開数（チャージ）は持たない

パッチごとに変わるうえ公式 API では配信されていない。
手書きで持つと必ず古くなる（実際にネオンのリレーボルトで誤表示した）。
配置盤では**置いた数と使用順**で意図が伝わるので、表示自体をやめている。
「チャージ数を出そう」という提案が来ても、この理由で断ること。

### 配置盤の操作

- **左ドラッグ = 置く・動かす、右クリック = 消す。**
  ポインタイベントで統一（マウスとタッチを分けない）。
  左ボタン以外ではドラッグを始めない（`if (e.button) return;`）。
- ドラッグ中に盤面全体を描き直すと掴んでいる要素が差し替わって
  操作が切れる。**動かしている間は `transform` だけを書き換える**。
- 「動かさずに離した = タップ」の判定に移動量のしきい値を使っている。
  これが無いと、パレットで選択したまま既存のマークを掴めず重ねて置いてしまう。
- 当たり判定は**見た目と同じ大きさ**にする。以前 `r=4` の透明円を
  見た目より大きく取っていて、隣のマークが後ろのマークを覆って
  クリックできなくなっていた。
- ルートの線は細いので、見えない太い線（`.board-route-hit`）を
  裏に重ねて右クリックで狙えるようにしてある。

### 盤面の大きさ

`fitBoardSize()` がモーダルの残り高さに合わせて上限を掛ける。
表示サイズの指定は**上限**として働き、画面に入らない大きさにはならない。

予算は「今のカードの高さ」ではなく **`max-height`** から引くこと。
今の高さを基準にすると、盤面を縮める → カードが縮む → さらに縮める、と
描き直すたびに小さくなっていく。

`.board-hint` の高さを固定しているのは、文言で行数が変わると
この計算がそのぶん狂うため。

### CSS

- `[hidden] { display: none !important; }` が必要。
  `.modal` に `display: grid` が当たっていて `hidden` を上書きしてしまい、
  見えない背面がクリックを食う事故を起こした。
- 上部ナビの `.phase-tab` と配置盤の局面タブ `.stage-tab` は別物。
  名前を混ぜないこと。

### Artifact として公開する場合

- CSP が厳しく、外部ホストは Google Fonts 以外すべて塞がれる。
  画像は data URI として埋め込む（`build.js` がやる）。
- ページサイズの上限は 16MB。
- ファイル保存には `downloads` capability の宣言が要る。
  宣言してもサンドボックス側で落ちることがあるので、
  Blob + `<a download>` のフォールバックを残してある。

### Windows のバッチファイル

`画像を取得.bat` は **CP932 / CRLF** で保存する。UTF-8 で書くと
日本語 `cmd` が Shift-JIS として読んで文字化けする。
`.gitattributes` で `*.bat -text` にして変換を止めている。
`echo` 行の中に ASCII の括弧を書かない（`if` ブロック内で構文が壊れる）。

---

## 多言語

`assets/js/locales/` に 1 言語 1 ファイル。ja / en / ko。
キーを増やしたら**3 ファイルすべてに足す**こと。
`t()` は 現在の言語 → en → 組み込み既定 の順に落ちるので、
足し忘れても落ちはしないが英語のまま出る。

ブランド名（TACTICAL SETUP CARD）だけラテン文字のままにしている。

---

## Supabase（任意機能）

`config.js` が空ならコミュニティタブと AI 寸評は**丸ごと隠れる**。
アプリ本体はオフラインで完全に動く。

- SDK を使わず PostgREST / GoTrue を直接 `fetch` する。
  SDK を入れると単一 HTML へのバンドルが崩れるため。
- スキーマは `supabase/schema.sql`。アクセス制御は RLS。
- AI 寸評は Edge Function `supabase/functions/tactic-review/`。
  API キーをブラウザに置かないため、サーバ側から Claude API を叩く。
  日次クォータ（匿名 3 / ログイン 20）で費用を構造的に止めている。

詳細は `docs/SETUP.md`。

---

## 残っている作業

| 項目 | 状態 |
| --- | --- |
| BUY マネー計算 | 未着手（ユーザーが一旦保留と判断） |
| 戦術のクラウド保存 | UI まで結線済み。**実際の Supabase では未検証**（この環境からプロジェクトを立てられないため、通信を差し替えた状態でしか確かめていない） |

### クラウド保存について

`saved_setups` に `exportJSON()` と同じ形（state 丸ごと）を入れている。
読み込むと手元の内容が**丸ごと入れ替わる**ので、必ず confirm を挟むこと。

`config.js` が空のときはボタンごと隠れる。未ログインで押した場合は
一覧を引かずにログインへ誘導する（RLS で自分の行しか引けないため、
未ログインでは必ず空になる）。

### 免責表記

`index.html` の `.app-foot` にある。Riot の二次利用条件で明記が
求められているものなので**消さないこと**。文言は `legal.*` のキー。

---

## リポジトリ

```
index.html              画面の骨格。<script> の並び順が読み込み順
build.js                単一 HTML へのバンドル
assets/js/              アプリ本体
assets/css/style.css    全スタイル
assets/img/             公式画像（fetch-assets.mjs が落とす）
tools/fetch-assets.mjs  公式画像の取得
tools/smoke-test.mjs    動作確認
docs/SETUP.md           Supabase / AI 寸評のセットアップ
docs/FETCH-ASSETS.md    画像取得の手順（非エンジニア向けに詳しく）
docs/HANDOFF.md         ローカル環境への引き継ぎ手順
supabase/               スキーマと Edge Function
画像を取得.bat          Windows 用の取得ランチャ（CP932/CRLF）
画像を取得.command      Mac 用
```

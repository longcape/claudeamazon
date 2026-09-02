# VALORANT TACTICAL SETUP CARD

VALORANT 競技シーン向けの、ラウンド単位の戦術コール管理ツール。
試合前に戦術を登録し、直前ラウンドの勝敗をもとに次の戦術を選び直していく。

このファイルは Claude Code 向けの作業メモ。
**過去に一度やって失敗した判断をもう一度させないため**に書いてある。

> **今どこまで進んでいるか**は `docs/STATUS.md` を見ること。
> 完了済み / 作業中 / 未着手 / 保留 / 次にやること / Git の状態をまとめてある
> （ChatGPT・Claude Code・Codex 共通の引継ぎ資料）。
> こちらは「なぜそうしたか」の記録で、進捗は持たない。

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
  → advisor → analyst → tree → board → share → community → ui → app
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
| `VCT_TREE` | tree.js | 勝敗で分岐する戦術のつながりと、その配置計算 |
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
  next: { win: <tacticId>|null, loss: <tacticId>|null },   // 分岐ツリー
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

### 分岐ツリー

`tactic.next` に「勝ったら次はこれ / 負けたらこれ」を持たせている。

**ツリーと言いつつ実体は有向グラフ。** 「勝ったら同じ形をもう一度」
（自己ループ）や、2 つの戦術が互いを指す形は実戦で普通に出るので、
循環を禁止していない。`layout()` は一度置いたノードを辿り直さないことで
無限ループを避けている。

**消された戦術を指したままの枝は、読むときに存在を確かめて無視する。**
戦術を消すたびに全件を舐めて掃除する方式にしていない。

**分岐は縛りではなく道しるべ。** ライブ画面ではツリーの次を先頭に出すが、
その下に必ず全戦術を並べる（`tree.others`）。実戦では相手の対応次第で
外れるので、閉じ込めると使い物にならない。

### 構成のプリセット

`state.comps` に 5 人構成を保存できる（上限 12）。
エージェントピッカーは 1 体選ぶと**空いている次のスロットへ自動で送る**。
エージェントセレクトは 30 秒しかなく、1 体ごとに閉じて開き直すと
間に合わないため。全部埋まったら閉じる。

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

### confirm() / prompt() を使わない

公開ページは sandbox 属性付きの iframe で動くため、ブラウザが
`confirm()` と `prompt()` を**黙って無視する**。例外も出ない。
スコアのリセットを含む 10 か所の操作が「押しても何も起きない」まま
気づかれずに残っていた。

確認や入力は `U.ask()`（`ui.js`）と `#modal-ask` を使う。
Promise を返し、入力ありなら文字列、OK なら `true`、キャンセルで `null`。
Esc / Enter は capture で拾って、後ろのモーダルまで閉じないようにしている。

smoke-test は `dialog` イベントを検出したら失敗する。
native ダイアログが混ざったら機械的に落ちるので、この形を崩さないこと。

### コミュニティ検索が当たる先

`tactic_posts` の列は **`name` / `note`** で、`title` / `body` という列は無い。
`renderPosts` の絞り込みを `p.title` / `p.body` に当てていたせいで、戦術名でも
コール詳細でも絶対にヒットしない検索になっていた（投稿者とマップだけ引っかかっていた）。
列名を変えるときは `renderPosts` とプレースホルダの文言も一緒に直すこと。

### 通報は「誰が」を必ず持たせる

`report_post` は通報者（ログイン中なら user id、そうでなければ匿名 ID）を取り、
`tactic_reports` の `primary key (post_id, reporter)` で 2 回目以降を弾く。
これが無いと **1 人が 5 回叩くだけでどの投稿でも隠せる**。
戻り値の `counted` が「今回数えたか」なので、画面はこれで
「通報しました」と「すでに通報済みです」を出し分ける。5 件で hidden になる仕様は変えない。

通報者を取らない旧 `report_post(uuid)` が残っていると呼び出しが曖昧になるので、
`schema.sql` は `drop function if exists` を先に書いてある。

### 運営者の判定は DB に置く

`public.admins` にポリシーを 1 つも作っていないので、anon / authenticated からは
読むことも書くこともできない。追加は Supabase の SQL Editor（service role）から。
**service role のキーはブラウザに置かない。**

画面の出し分けは `is_admin()` の結果を使うが、**それは見た目だけ**。
運営 RPC（`admin_set_hidden` / `admin_set_report_threshold`）は毎回中で
`is_admin()` を見て `NOT_ADMIN` で落とす。ここを画面側の判定に頼らないこと。

**Supabase は public スキーマの関数を既定で anon にも grant する。**
`revoke all ... from public` だけでは anon が残るので、運営まわりは
`revoke all ... from anon` も書く。実際これを入れるまで、未ログインからでも
関数本体まで届いていた（中の is_admin() で止まってはいた）。

### 通報の復旧と moderation

`tactic_posts.moderation` は `auto` / `restored` / `forced`。
`report_post` が自動で隠すのは `auto` のときだけ。

**復旧しても通報の履歴（tactic_reports）は消さない。** 消すと同じ人がもう一度
通報できるようになり、復旧した端からまた隠される。かといって `hidden` だけ戻すと
`reports` がしきい値を超えたままなので次の 1 件で隠れる。だから状態を別に持つ。

### 通報の理由と、その見せ方

理由は `spam` / `abuse` / `misleading` / `offtopic` / `other` の 5 つ。
**画面の選択肢を増やすときは `tactic_reports_reason_check` も一緒に直すこと。**
`report_post` は知らない理由を `other` に寄せるので落ちはしないが、
そのままだと全部 other にまとまってしまう。

**通報者そのものは運営者にも見せない。** `tactic_reports` に読み取りポリシーを作らず、
`admin_report_breakdown()` が理由ごとの件数と補足だけを返す形にしてある。
「誰が通報したか」を運営画面に出したくなったときは、報復のリスクを考えてから。

### 監査ログは RPC からしか書かない

`moderation_log` に書き込みポリシーを作っていないので、入るのは
SECURITY DEFINER の運営 RPC からだけ。**運営操作を足すときは、その中で
moderation_log に 1 行入れること。** smoke-test が「復旧・強制非表示・しきい値変更が
必ず記録される」ことを見張っている。

投稿や運営者が消えても記録は残したいので、外部キーは `on delete set null`。

### 通報のしきい値はコードに書かない

`community_config` の `report_threshold`（初期値 5）を `report_threshold()` が読む。
書き込みポリシーは作っていないので一般ユーザーは変えられない。変更は
`admin_set_report_threshold(n)` から。smoke-test が「コードに埋めていないこと」を見張っている。

### 生の DB メッセージを画面に出さない

`friendlyError()`（app.js）が、文字数超過 / 権限なし / 重複 / レート制限 / 通信失敗 に
振り分けて i18n の文言を返す。**生の内容は `console.warn` にだけ残す。**
以前は `violates check constraint "tactic_posts_note_check"` がそのままトーストに出ていた。
新しい失敗の種類を足すときは、`err.*` のキーを ja / en / ko の 3 つに足すこと。
smoke-test が「生の DB メッセージが出ないこと」を見張っている。

### Supabase の関数まわりで踏んだもの

**pgcrypto は `extensions` スキーマにいる。** `enforce_post_rate_limit` が `digest()` を
呼ぶのに `set search_path = public` としていたため、`function digest(text, unknown) does not exist`
で `tactic_posts` への insert が必ず失敗していた。**匿名投稿は一度も成功していなかった。**
`set search_path = public, extensions` にすること。

**トリガ関数の EXECUTE を落とすときは PUBLIC も落とす。**
`revoke ... from anon, authenticated` だけでは効かない。関数には既定で PUBLIC に EXECUTE が
付いており、anon と authenticated はその PUBLIC のメンバーなので、実質そのまま呼べてしまう。
`revoke all on function ... from public` を先に書く。
トリガの発火時に EXECUTE 権限は再チェックされないので、これで動作は変わらない。

**ログイン手段は `config.js` の `AUTH_PROVIDERS` / `AUTH_EMAIL` だけで決める。**
以前はどちらもどこからも参照されない死んだ設定で、Discord ボタンが HTML 直書きで常に出ていた。
Supabase 側で有効にしていないプロバイダのボタンは、押した先で必ず失敗する。
プロバイダを増やすときは `index.html` に `data-provider` 付きのボタンを足して、
`AUTH_PROVIDERS` に ID を入れるだけでよい（クリックは委譲で拾っている）。

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

### Windows で開発する場合の改行コード

Git の `core.autocrlf=true`（Windows の既定）で clone すると、`dist/*.html` が
CRLF で展開される。`build.js` は LF で書くので、ビルドするたびに
`git status` が「変更あり」になる（`git diff` は空で、中身は同一）。
気づかずコミットすると `dist/` に CRLF が混入して不要な差分が出る。

作業コピーごとに次を設定する。

```bash
git config core.autocrlf false
git rm --cached -r -q . && git reset --hard
```

`画像を取得.bat` は `.gitattributes` の `*.bat -text` で保護されているので、
この設定を変えても CRLF のまま保たれる。

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

一覧と優先順位は `docs/STATUS.md`。ここには判断の理由だけ残す。

| 項目 | 状態 |
| --- | --- |
| BUY マネー計算 | 未着手（ユーザーが一旦保留と判断） |
| Riot Games API | **見送り**。ライブの試合データは API に存在せず、試合前の相手情報を見ること（scouting）と、その場で行動を変えるリアルタイム提示が開発者ポリシーで禁止されている。構成は手入力のままにして、入力を速くする方向で解決した。詳細は `docs/LEGAL.md` |
| 戦術のクラウド保存 | **2026-09-01 に実地検証済み。**保存 / 一覧 / 上書き / 削除 / 読み込み、未ログイン時の誘導、他人の行が読めないことまで実際の Supabase で確認した。詳細は `docs/STATUS.md` |

### クラウド保存について

`saved_setups` に `exportJSON()` と同じ形（state 丸ごと）を入れている。
読み込むと手元の内容が**丸ごと入れ替わる**ので、必ず confirm を挟むこと。

**`config.js` は空のままコミットする。** 接続情報を書いた状態でコミットすると、
smoke-test の「未設定ならクラウド保存は隠れる」が必ず落ちる。この項目は
「設定していない人の画面にボタンが出ない」ことを守っているので、通すために
テストを緩めない。接続情報は使う人が自分の値を入れる（`docs/SETUP.md`）。

**マジックリンクのリダイレクト先はクエリの `redirect_to` で渡す。**
GoTrue は本文の `options.email_redirect_to` を読まない。本文に入れると黙って
無視され、プロジェクトの Site URL へ飛ばされてアプリに戻ってこられない。

`config.js` が空のときはボタンごと隠れる。未ログインで押した場合は
一覧を引かずにログインへ誘導する（RLS で自分の行しか引けないため、
未ログインでは必ず空になる）。

### 免責表記

`index.html` の `.app-foot` にある。Riot の Legal Jibber Jabber が
**文言を指定している**ので、言い換えたり訳文だけにしたりしないこと。

```
[プロジェクト名] was created under Riot Games' "Legal Jibber Jabber" policy
using assets owned by Riot Games. Riot Games does not endorse or sponsor
this project.
```

この 1 行目は指定どおりの英文をそのまま出す（言語を切り替えても英語のまま）。
下に各言語の訳を添えているが、訳文は補助であって指定文言の代わりにはならない。
smoke-test がこの文言を見張っている。

収益化する場合は、これに加えて Developer Portal への登録（Approved）と
無料枠の提供が要る。詳細は `docs/LEGAL.md`。

---

## リポジトリ

```
index.html              画面の骨格。<script> の並び順が読み込み順
build.js                単一 HTML へのバンドル
assets/js/              アプリ本体
assets/css/style.css    全スタイル
assets/img/             公式画像（fetch-assets.mjs が落とす）
tools/fetch-assets.mjs  公式画像の取得
tools/smoke-test.mjs    動作確認 50 項目
docs/STATUS.md          進捗と引き継ぎ（最初に読む）
docs/SETUP.md           Supabase / クラウド保存 / AI 寸評のセットアップ
docs/LEGAL.md           公開・収益化と Riot の規約
docs/FETCH-ASSETS.md    画像取得の手順（非エンジニア向けに詳しく）
docs/HANDOFF.md         ローカル環境への引き継ぎ手順
supabase/               スキーマと Edge Function
画像を取得.bat          Windows 用の取得ランチャ（CP932/CRLF）
画像を取得.command      Mac 用
```

# 進捗と引き継ぎ（ChatGPT / Claude Code / Codex 共通）

**最終更新日: 2026-09-01**

このファイルは「次に入った担当が、続きから作業できる」ことだけを目的にしている。
設計の理由と過去の失敗は `CLAUDE.md`、環境構築は `docs/HANDOFF.md`。
**ここと矛盾があれば、現行のコードと Git の状態を正とする。**

---

## ■ 現在の状態

VALORANT 競技シーン向けの、ラウンド単位の戦術コール管理ツール。
**動く状態で公開済み。** 中断中の作業や、壊れたまま放置している箇所は無い。

| 項目 | 値 |
| --- | --- |
| リポジトリ | `longcape/claudeamazon` |
| **ブランチ** | `claude/valorant-tactical-setup-card-iiiog3`（**これが既定ブランチ**。`main` というブランチは存在しない） |
| **公開ページ** | https://longcape.github.io/claudeamazon/ （push すると自動で更新される） |
| 最新コミット | `3003b8b` 進捗と引き継ぎの資料を docs/STATUS.md にまとめる |
| **未コミット変更** | **なし**（リモートと一致） |
| テスト | `node tools/smoke-test.mjs` → **50 件 ok / 0 件 NG** |
| 公開 URL | https://claude.ai/code/artifact/c9ecf3b7-a7c1-4ce8-b3ca-1fe31de768ef |

**2026-09-02 から GitHub Pages で常設公開している: https://longcape.github.io/claudeamazon/**
作業ブランチへ push すると `.github/workflows/pages.yml` が自動で更新する。

`https://claude.ai/code/artifact/c9ecf3b7-...` の方は、Claude のクラウドセッションが
発行した古い公開ページ。ローカルからは更新できないので、**今後は GitHub Pages の方を見ること。**

### 起動方法

```bash
open index.html          # Windows は index.html をダブルクリック。ビルド不要
node build.js            # dist/ を作り直す（assets/ や index.html を触ったら必須）
node tools/smoke-test.mjs   # 動作確認（playwright が無ければ黙って飛ばす）
```

---

## ■ 完了済み

### 基本ループ
- 試合設定（マップ 13 / チーム名 / 前後半サイド / スカウトメモ）
- エージェント構成（味方 5・敵 5、全 29 体、ロール別フィルタ・IGN 入力）
- 戦術デッキの登録（名前 / サイド / ターゲットサイト / 戦術タイプ / コール詳細）
- ライブ画面のラウンドループ（戦術選択 → カード表示 → WIN/LOSS → 次へ）
- サイド自動反転（13R / OT は毎ラウンド）、直前ラウンドの取り消し
- キーボードショートカット（`W`/`L`、候補選択 `1`-`9`）

### 判断支援
- 推奨スコア 0-100（`advisor.js`。連投減点・未使用加点などをルール化）
- 構成の相性判定（`analyst.js`。完全オフライン、通信もコストも無し）
- AI 寸評（Supabase Edge Function 経由。`config.js` が空なら非表示）

### 配置盤（`board.js`）
- マップ上にエージェント / スキル / **プラント位置**を配置、進行ルートを描画
- **左ドラッグ = 置く・動かす、右クリック = 消す**
- 局面（phase）を **最大 4 枚**。A フェイク → B のような多段の戦術を分けて書ける
- スキルの使用順は**エージェントごとに 1 から**採番
- 公式ミニマップの**向きを統一**（ディフェンダー上 / アタッカー下。フラクチャーのみ 0 度）

### 戦術のつながり
- **分岐ツリー**（`tree.js`）。勝敗で次の戦術へ分岐。実体は有向グラフで自己ループ可
- ライブ画面ではツリーの次を先頭に出したうえで、**必ず全戦術も並べる**（縛りにしない）

### クラウド保存（`saved_setups`）— **2026-09-01 実地検証済み**

実際の Supabase プロジェクトに対して通した。**もう「未検証」ではない。**

| 確認したこと | 結果 |
| --- | --- |
| 保存（`POST /rest/v1/saved_setups`） | 201 |
| 一覧（`GET ...?select=*&order=updated_at.desc`） | 200 |
| 上書き（`PATCH ...?id=eq.<id>`） | 200。`updated_at` がトリガで更新される |
| 削除（`DELETE ...?id=eq.<id>`） | 本人なら 1 行削除される |
| 読み込み | `importObject()` に保存済み payload を通して復元を確認 |
| 置換前の確認 | `U.ask()` のアプリ内モーダルが出る（native ダイアログではない） |
| `payload` の中身 | `exportJSON()` と同じ 10 キー（version / phase / match / allies / enemies / comps / tactics / rounds / pending / sideOverrides） |
| 未ログインでボタンを押す | 一覧を引かずログインへ誘導。Supabase へのリクエストは 0 件 |
| 未ログインで `saved_setups` を読む | `200 []`（RLS で行が見えない） |
| 未ログインで `saved_setups` へ書く | `401` row-level security policy 違反 |
| 他人の行を読む / 更新する / 削除する | 一覧 0 件・ID 直指定 0 件・UPDATE 0 行・DELETE 0 行 |

RLS は `saved_setups_all`（`for all to authenticated using (user_id = auth.uid())`）が
意図どおり効いている。`tactic_likes` と `ai_usage` も直接読めないことを確認済み。

### コミュニティ投稿 — **2026-09-01 実地検証済み**

| 経路 | 結果 |
| --- | --- |
| COMMUNITY タブから匿名投稿 | 成功。`user_id` は null、成功トーストが出てモーダルが閉じる |
| 投稿一覧への反映 | 投稿直後に再取得されてカードが並ぶ |
| 検索（名前 / コール / マップ / 投稿者 / AND） | **修正後に**通るようになった（下記「問題点」） |
| いいね | `likes` が増える |
| 重複いいね | 同じブラウザから 4 回押しても `tactic_likes` は 1 行のまま |
| 通報（RPC 直叩き） | 5 件で `hidden` になり、匿名の一覧から消える |
| ログインユーザーの投稿 | `user_id` が自動で入る。他人の `user_id` を入れた投稿は RLS 違反で弾かれる |
| 自分の投稿の編集・削除 | 本人なら 1 行更新・削除できる |
| 他人の投稿の編集・削除 | **UPDATE 0 行 / DELETE 0 行**。匿名投稿は誰も編集・削除できない |
| 並び替え・マップ絞り込み | `order=likes.desc,created_at.desc` と `map=eq.` が正しく飛ぶ |
| 失敗メッセージ | 制約違反でモーダルは開いたまま、`toast err` が出る |

> 通報・編集・削除は**画面からの導線が無い**ため、RPC と RLS のレベルで確認した。

### 通報・投稿の編集削除 — **2026-09-02 実装・検証済み**

- **通報の重複防止**は `tactic_reports`（`primary key (post_id, reporter)`）で行う。
  通報者はログイン中なら user id、していなければ匿名 ID。
  `report_post(uuid, text)` が `on conflict do nothing` で弾き、実際に入ったときだけ数える。
  戻り値は `{ counted, reports, hidden }` で、画面は counted で文言を出し分ける。
  **5 件で hidden になる仕様はそのまま。**
- 実測: 同じ通報者が 5 回連打 → `reports` は 1 のまま、投稿は見えたまま。
  別々の 5 人 → 1→5 と増え、5 人目で `hidden`、匿名の一覧から消える。
- **通報 UI** は投稿カードのボタン。押すと確認を挟み、済んだらボタンが「通報済み」で無効になる。
- **編集・削除 UI** は自分の投稿にだけ出る（`user_id` が自分と一致するとき）。
  匿名投稿は `user_id` が null なので誰にも出ない。削除は確認を挟む。
  編集欄の `maxlength` は `tactic_posts` の check 制約と同じ数字にしてある。
- **生の DB メッセージは画面に出さない。** `friendlyError()` が
  文字数超過 / 権限なし / 重複 / レート制限 / 通信失敗 に振り分ける。
  生の内容は `console.warn` にだけ残す。

### 運営機能 — **2026-09-02 実装・検証済み**

**運営者の判定は `public.admins` テーブル。** ポリシーを 1 つも作っていないので、
anon / authenticated からは読むことも書くこともできない。追加と削除は Supabase の
SQL Editor（service role）からのみ。**service role のキーはブラウザに置かない。**

```sql
insert into public.admins (user_id, note)
select id, 'なぜ運営者なのか' from auth.users where email = 'you@example.com'
on conflict (user_id) do nothing;
```

画面の出し分けは `is_admin()` の結果で行うが、**それは見た目だけの話**。
運営 RPC は毎回中で `is_admin()` を見て、違えば `NOT_ADMIN` で落とす。
`admin_set_hidden` と `admin_set_report_threshold` は anon から呼べないよう
EXECUTE も落としてある（Supabase は public スキーマの関数を既定で anon にも渡すので、
明示的に revoke しないと残る）。

**復旧の流れ**: 通報が積み上がって `hidden` になる → 運営者が「非表示も表示」を入れて
一覧に出す → 「復旧」で `admin_set_hidden(id, false)` → `hidden = false`、
`moderation = 'restored'`。逆に「非表示にする」で `moderation = 'forced'`。

**復旧後の通報の扱いは「履歴を残したまま、モデレーション状態を別に持つ」を選んだ。**

| 案 | 問題 |
| --- | --- |
| 通報履歴をクリアする | 同じ 5 人がもう一度通報できてしまい、復旧した端から隠される。経緯も追えなくなる |
| 履歴を残して `hidden` だけ戻す | `reports` がしきい値を超えたままなので、次の 1 件でまた隠れる |
| **履歴を残し `moderation` を別に持つ**（採用） | 誰が通報したかは残るので重複も防げるし経緯も追える。`restored` の投稿は自動では隠れないので、復旧が 1 件の通報で覆らない |

**通報のしきい値は `community_config` テーブルの `report_threshold`。**
初期値は 5。`report_post` は `report_threshold()` 経由でこの値を読む。
読み取りは誰でもできるが、書き込みポリシーを作っていないので一般ユーザーは変えられない。
変更は運営者だけが `admin_set_report_threshold(n)` で行う（1〜1000）。

実測: 同一主体 5 連打 → `reports` は 1 のまま。別々の 5 人 → 5 人目で `hidden`。
一般ユーザーが運営 RPC を呼ぶと `NOT_ADMIN`、未ログインだと
`permission denied for function`。運営者が復旧すると `restored` になり、
そのあと 2 件通報が増えても（合計 7 件）隠れないままだった。
しきい値を 3 に変えると新しい投稿は 3 人目で隠れ、5 に戻すと 5 人目で隠れた。

### 通報理由と監査ログ — **2026-09-02 実装・検証済み**

**通報の理由**は 5 択（スパム / 攻撃的・不適切 / 虚偽・誤解を招く / VALORANT の戦術と無関係 / その他）。
「その他」を選んだときだけ 200 文字までの補足を書ける。`tactic_reports.reason` と `detail` に入る。
**知らない理由が来ても落とさず `other` に寄せる**ので、画面の選択肢を増減しても DB 側で弾かれない。
重複防止は `primary key (post_id, reporter)` のままなので、**理由を変えて出し直しても 2 回目は数えない。**

**通報の内訳は運営者だけ**が `admin_report_breakdown(post_id)` で見られる。
理由ごとの件数と「その他」の補足だけを返し、**通報者そのものは運営者にも返さない**。
`tactic_reports` に読み取りポリシーを作っていないので、テーブルを直接引いても誰にも見えない。

**監査ログ**は `moderation_log`。`action`（restore / force_hide / set_threshold）、
`post_id`、`admin_user_id`、`created_at`、`old_value`、`new_value`、`moderator_note` を持つ。
読めるのは運営者だけ（`using (public.is_admin())`）。**書き込みポリシーは作っていない**ので、
入るのは SECURITY DEFINER の運営 RPC からだけ。投稿や運営者が消えても記録が残るよう、
外部キーは `on delete set null`。

実測: 4 人が別々の理由で通報 → 理由ごとに保存。同じ人が理由を変えて出し直しても数えない。
知らない理由は `other` になった。運営者の復旧・強制非表示・しきい値変更で
それぞれ記録が 1 行増え、変更前後の値と運営メモが入った。一般ユーザーからは
`moderation_log` も `tactic_reports` も 0 件、未ログインの直接書き込みは RLS 違反。

### その他
- 戦術の検索・グループ分け（サイト / 種別 / サイド）
- 構成プリセット（`state.comps`、上限 12）と入力の高速化
- 多言語 ja / en / ko
- 書き出し / 読み込み（JSON）
- 公式画像の取得（`tools/fetch-assets.mjs` + GitHub Actions）
- Riot 指定の免責表記（`index.html` の `.app-foot`）
- **docs を現行実装と突き合わせ**（2026-09-01、ローカル環境）。`SETUP.md`（i18n キー数 270→372、クラウド保存が未検証である旨、`main` が空である旨）、`HANDOFF.md`（書き出し・読み込みの場所、git identity と `core.autocrlf` のつまずき）、`FETCH-ASSETS.md`（公式画像は同梱済み、取得完了時の表示、アップロード対象の枚数、Riot の条件）。`LEGAL.md` はずれが無く変更なし
- **README を現行実装と全文突き合わせ**（2026-09-01、ローカル環境）。表示サイズの段階、`⋯` メニュー、公式画像の同梱、検索・構成プリセット・クラウド保存の追記、免責表記の指定文言化など。READMEだけで「いま何ができて、何が未完成か」が分かる状態にした

---

## ■ 作業中

**なし。** 直近の作業は完了し、コミット・プッシュ・公開 URL の更新まで済んでいる。

2026-09-01、ローカル環境へ clone して受領済み。`node build.js` の生成物がコミットとバイト一致（再現ビルド成立）、`node tools/smoke-test.mjs` が 50 件 ok / 0 件 NG であることを実測で確認した。

直近で終えた内容（このセッション）:

1. **サンドボックスで無効化されていた確認ダイアログの修復**（本命の不具合。下記「問題点」参照）
2. X ポストをラウンド中のシェアバーから**決着バナーへ移動**
3. 戦術検索とコミュニティ検索を**文言で役割分離**、コミュニティ側にも本文検索を追加
4. 書き出し・読み込み・初期化を **`⋯` メニューへ集約**

---

## ■ 未着手

| 項目 | メモ |
| --- | --- |
| **BUY マネー計算** | ユーザーが「一旦よい」と判断して保留。着手していない |

---

## ■ 保留

### Riot Games API — 見送り（結論済み）

「試合データから自動で戦術カードをセットする」は**実装しない**と決めた。理由:

- ライブの試合データは API に存在しない（公開されているのは試合終了後の履歴まで）
- 取れたとしても、**スカウティング**と**リアルタイムの優位**が開発者ポリシーで禁止

構成は手入力のままとし、**入力を速くする方向**（構成プリセット・自動スロット送り）で解決した。
利用者が自分の画面を見て打ち込む内容は Riot のデータではないので、この形なら規約の外。
詳細は `docs/LEGAL.md`。

> API が正当に効くのは**試合後**に戦術と勝敗を突き合わせる用途（試合をまたいだ学習）。
> やる場合は RSO の実装と Production Key の審査が要る（VALORANT では Personal Key が出ない）。

---

## ■ 問題点

### 解決済み（再発させないための記録）

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| **スコアリセットが効かない** | 公開ページは sandbox 付き iframe で動くため、ブラウザが `confirm()` / `prompt()` を**黙って無視する**。リセットを含む **10 か所**の操作が「押しても何も起きない」状態だった | `U.ask()` + `#modal-ask` に全置換。native ダイアログは**残り 0 件**。smoke-test が `dialog` イベントを検出したら失敗する |
| プラント位置が再読込でエージェントに化ける | `normalizeBoard` が `agent`/`ability` 以外の `kind` を潰していた | `MARK_KINDS = ['agent','ability','plant']` で判定 |
| 配置盤が再描画のたびに縮む | `fitBoardSize` が「今の高さ」を基準にしていて縮小のループが起きた | **`max-height`** から予算を引く |
| 免責表記が条件を満たしていない | Riot は**文言を指定している**。自分の言葉で書き直すと不可 | 指定どおりの英文を言語設定に関係なく常に表示。smoke-test で見張っている |
| Actions の自動コミットが毎回空 | 生成物に生成日時を書いていた | 日時の行をやめた |
| **匿名の戦術投稿が丸ごと通らない** | レート制限トリガが `digest()`（pgcrypto）を呼ぶが、pgcrypto は `extensions` スキーマにいる。関数の `search_path` を `public` だけに絞っていたため `function digest(text, unknown) does not exist` で insert が必ず失敗していた。コミュニティ投稿は一度も成功したことがなかった | `set search_path = public, extensions` に直した。匿名投稿 201 / いいね RPC / 重複いいねの無視まで実測で確認済み |
| トリガ関数が REST の RPC として外から叩けた | `revoke ... from anon, authenticated` だけでは足りない。**PUBLIC に EXECUTE が付いたまま**で、anon と authenticated は PUBLIC のメンバーなので実質そのまま呼べる | `revoke all ... from public` も入れた。`/rest/v1/rpc/` から 404 になることを確認済み |
| **コミュニティ検索が戦術名でもコール詳細でも当たらない** | `renderPosts` が `p.title` / `p.body` で絞っていたが、`tactic_posts` にその列は無い（`name` / `note`）。投稿者とマップだけ引っかかる状態だった | `name` / `note` / `site` / `kind` / `map` / 投稿者 に当てるよう修正。プレースホルダの文言も ja / en / ko の 3 つとも直した |
| Discord ボタンが押しても必ず失敗する | Supabase 側で Discord を有効にしていないのに、ボタンが HTML 直書きで常に出ていた。`config.js` の `AUTH_PROVIDERS` はどこからも参照されない死んだ設定だった | `AUTH_PROVIDERS` と `AUTH_EMAIL` で表示を出し分けるようにし、既定を `[]` にした |

### 既知の制約（不具合ではない）

- **このクラウド環境からは `valorant-api.com` に繋がらない**（egress proxy が 403 で拒否。
  ポリシー拒否であって回避できるものではない）。画像取得は **GitHub Actions**
  （Actions タブ → 「公式画像の取得」→ Run workflow）か**ローカル**で行う。
- **このクラウド環境からは playwright のブラウザも落とせない**（`cdn.playwright.dev` が 403）。
  smoke-test を回すには、同梱の `/opt/pw-browsers` に合わせて
  `npm i -D playwright@1.56.0 && PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tools/smoke-test.mjs`。
  **ローカルではこの回避は不要**（`package.json` の `^1.62.1` のままでよい）。
- 登録した戦術は**ブラウザごとの `localStorage`**。公開 URL 版とローカル版でデータは共有されない。
  移すには書き出し → 読み込み。

---

## ■ 最新決定事項

チャット内で決めたことのうち、コードだけ見ても分からないもの。

| 決定 | 理由 |
| --- | --- |
| **native ダイアログは今後も使わない** | 公開ページのサンドボックスで無効化されるため。smoke-test で機械的に禁止している |
| **X ポストはラウンド中には出さない** | ラウンド途中は共有する中身が無く、押す場面が無かった。決着バナーに移し、マッチ全体の要約を載せる |
| **書き出し・読み込みは残す** | クラウド保存があっても、**アカウント不要でブラウザをまたげる唯一の手段**。ただし試合中の誤操作が痛いので `⋯` メニューへ一段隠した |
| **戦術検索とコミュニティ検索は文言で分ける** | 「自分の戦術を検索」/「みんなの戦術を検索」。見た目が同じで役割が読めなかった |
| **分岐ツリーは縛りではなく道しるべ** | 実戦では相手の対応次第で外れる。ツリーの次を先頭に出しつつ、その下に必ず全戦術を並べる |
| **スキルの同時展開数（チャージ）は持たない** | パッチごとに変わり公式 API でも配信されていない。手書きは必ず古くなる（ネオンで実際に誤表示した）。**提案が来てもこの理由で断ること** |
| **Riot Games API は使わない** | 上記「保留」参照。構成は手入力のまま、入力速度で解決する |
| **免責表記の文言は変えない** | Riot が文言を指定している。訳文は補助であって代わりにならない |
| 構成は自動でなく手入力を高速化する | 野良試合に模倣すべきマクロが存在するかが未検証で、労力に見合うか不明という判断 |

---

## ■ 次にやること

上から順に。

1. BUY マネー計算 — ユーザーが再開を決めたら着手
2. 公開先の常設化を検討する（GitHub Pages 等。現在の URL はクラウドセッション発行で、ローカルから更新できない）
3. Discord ログインを使うなら、Supabase の Authentication → Providers で有効にしてから
   `config.js` の `AUTH_PROVIDERS` を `['discord']` に戻す。**コードの変更は要らない。**

> Supabase の advisor は 2026-09-01 に対応済み。残っているのは意図どおりのものだけ
> （`like_post` / `report_post` を anon に公開、`ai_usage` にポリシーを作らない）。
> 別途 `auth_leaked_password_protection` が WARN で出るが、このアプリはパスワードを使わず
> マジックリンクだけなので実害はない。気になるならダッシュボードのトグルで有効にできる。

> `supabase/schema.sql` は 2026-09-01 に `valorant-setup-card` プロジェクトへ適用済み。
> Project URL と publishable key は取得済み（値は管理資料に書かない）。
> **`assets/js/config.js` は空のままリポジトリに置く。**接続情報を入れてコミットすると、
> smoke-test の「未設定ならクラウド保存は隠れる」が必ず落ちる。使う人が自分の値を入れる。

### 作業するときの必須ルール

- **開発・コミット・プッシュは `claude/valorant-tactical-setup-card-iiiog3` のみ。**
- `assets/` か `index.html` を触ったら **`node build.js` を必ず実行**してからコミットする
  （`dist/` の作り直し忘れが一番ありがちな取りこぼし）。
- i18n のキーを足したら **ja / en / ko の 3 ファイルすべてに足す**。
- モジュールを足したら `index.html` に `<script>` を追加するだけでよい
  （`build.js` が `index.html` を読んでバンドルする。ファイル一覧のベタ書きはしない）。
- **ES モジュールを使わない。** `file://` で開いたとき CORS で落ちる。IIFE で `window.VCT_*` に生やす。
- npm パッケージをランタイムに足さない（`sharp` / `playwright` は開発ツール専用）。

---

## ■ 主要ファイル

読む順に。

| ファイル | 役割 |
| --- | --- |
| **`CLAUDE.md`** | **最初に読む。**設計の前提と、過去に実際に踏んだ地雷 |
| `index.html` | 画面の骨格。**`<script>` の並び順が読み込み順**（依存は常に下向き） |
| `assets/js/store.js` | 状態と `localStorage`。正規化（壊れた入力の吸収）もここ |
| `assets/js/app.js` | 状態遷移とイベント結線（1565 行。最大） |
| `assets/js/ui.js` | 描画。**DOM を作るのは基本ここだけ**（1438 行） |
| `assets/js/board.js` | 配置盤。操作関数は**戦術ではなく盤面（phase）を受け取る** |
| `assets/js/tree.js` | 分岐ツリーの配置計算と枝の描画 |
| `assets/js/advisor.js` | 推奨スコア |
| `assets/js/analyst.js` | 構成の相性判定（ルールベース） |
| `assets/js/maps-layout.js` | マップ簡易図と**向きの補正角 `ROTATION`**（新マップを足したらここにも足す） |
| `assets/js/official-assets.js` | **自動生成。手で編集しない**（`tools/fetch-assets.mjs` が書く） |
| `assets/js/community.js` | Supabase（SDK を使わず PostgREST / GoTrue を直接 fetch） |
| `assets/js/config.js` | 接続設定。**空でもアプリは完全に動く** |
| `build.js` | 単一 HTML へのバンドル |
| `tools/smoke-test.mjs` | 動作確認 50 項目。過去に壊れた箇所を見張っている |
| `docs/SETUP.md` | Supabase / AI 寸評のセットアップ |
| `docs/LEGAL.md` | 公開・収益化と Riot の規約 |
| `docs/HANDOFF.md` | ローカル環境への引き継ぎ手順 |
| `docs/FETCH-ASSETS.md` | 画像取得の手順（非エンジニア向け） |

### グローバル（読み込み順）

```
config → i18n → locales(ja/en/ko) → data → agent-traits → abilities
  → portraits → maps-layout → official-assets → store
  → advisor → analyst → tree → board → share → community → ui → app
```

`VCT_CONFIG` `VCT_I18N` `VCT_DATA` `VCT_TRAITS` `VCT_ABILITIES` `VCT_PORTRAITS`
`VCT_MAPS` `VCT_STORE` `VCT_ADVISOR` `VCT_ANALYST` `VCT_TREE` `VCT_BOARD`
`VCT_SHARE` `VCT_COMMUNITY` `VCT_UI`（`app.js` はグローバルを持たない）

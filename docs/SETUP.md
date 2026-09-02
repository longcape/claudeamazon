# コミュニティ機能・クラウド保存・AI 寸評のセットアップ

このアプリは**設定なしでも完全に動作します**。以下の設定を行うと、追加で
「戦術の投稿・閲覧」「戦術のクラウド保存」「AI 寸評」が有効になります。

> **クラウド保存はまだ検証できていません。**
> UI と通信コードは結線済みですが、実際の Supabase プロジェクトに対して
> 一度も通していません（実装したクラウド環境からプロジェクトを立てられなかったため）。
> この手順で Supabase を用意したら、**保存 → 一覧 → 読み込み → 上書き → 削除**を
> 実際に通して確認してください。詳細は [STATUS.md](STATUS.md) の「保留」節。

> **重要な前提**
> 公開ページ（Artifact）版はセキュリティポリシーにより外部への通信が全面的に遮断されています。
> Supabase を使うコミュニティ版は、**GitHub Pages / Vercel / Netlify などの通常のホスティングに置く必要があります。**
> Artifact 版は「ソロ用・完全オフライン版」として並行して残すのが妥当です。

---

## 1. Supabase プロジェクトを作る

1. [supabase.com](https://supabase.com) でプロジェクトを新規作成します（無料枠で十分です）
2. **SQL Editor** を開き、`supabase/schema.sql` の中身をそのまま貼り付けて実行します
   - テーブル、インデックス、RLS ポリシー、レート制限、いいね用の RPC がまとめて作られます
   - 何度実行しても同じ状態になるよう書いてあるので、やり直しても問題ありません
3. **Settings → API** から次の 2 つを控えます
   - `Project URL`
   - `anon` / `publishable` キー

## 2. アプリに接続情報を書く

`assets/js/config.js` を開いて 2 行を埋めます。

```js
window.VCT_CONFIG = {
  SUPABASE_URL: 'https://xxxxxxxxxxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...',
  ...
};
```

保存して `node build.js` を実行すれば配布ファイルにも反映されます。
COMMUNITY タブは、この 2 つが埋まっているときだけ表示されます。

> **anon キーを公開して大丈夫なのか？**
> 大丈夫です。anon キーはブラウザに露出することが前提の公開キーで、
> 実際のアクセス制御は Supabase 側の **RLS（行レベルセキュリティ）** が行います。
> `schema.sql` では「投稿は誰でも作成・閲覧できるが、編集と削除は本人のみ」
> 「保存したセットアップは本人しか読み書きできない」という形で制御しています。
> 一方 **service role キーは絶対にクライアントに置かないでください。** RLS を無視できるキーです。

## 3. Discord ログインを有効にする

競技シーンとの相性を優先して Discord を既定のログイン方法にしています。
匿名でも投稿はできますが、**セットアップの保存と投稿の編集・削除にはログインが必要**です。

> **既定では Discord ボタンは出ません。** `config.js` の `AUTH_PROVIDERS` が `[]` だからです。
> Supabase 側で有効にしていないプロバイダのボタンを出すと押した先で必ず失敗するので、
> 下の設定を済ませてから `AUTH_PROVIDERS: ['discord']` に戻してください。コードの変更は要りません。

1. [Discord Developer Portal](https://discord.com/developers/applications) で New Application を作成
2. **OAuth2** タブの Redirects に、Supabase の
   `https://<プロジェクトID>.supabase.co/auth/v1/callback` を追加
3. Client ID と Client Secret を控える
4. Supabase の **Authentication → Providers → Discord** を有効にし、両方を貼り付ける

メールのマジックリンクは Supabase の標準機能なので、追加設定なしで併用できます。

## 3.5. 運営者を登録する（任意）

通報が集まって自動的に隠れた投稿を戻したり、しきい値を変えたりするには運営者の登録が要ります。
**Supabase の SQL Editor で 1 回実行するだけ**です。画面からは登録できません（そこが安全側の作りです）。

```sql
insert into public.admins (user_id, note)
select id, 'プロジェクト所有者' from auth.users where email = 'あなたのアドレス'
on conflict (user_id) do nothing;
```

外すときは `delete from public.admins where user_id = '...';`。

登録するとコミュニティ画面に「非表示も表示」が出て、投稿ごとに通報数と
「復旧」「非表示にする」が見えるようになります。**運営者以外には出ませんし、
仮に画面を書き換えても DB 側で弾かれます。**

通報のしきい値（既定 5）を変えるときも運営者としてログインした状態で:

```sql
select public.admin_set_report_threshold(10, '利用者が増えたので引き上げ');
```

第 2 引数は運営メモです（省略できます）。しきい値の変更も投稿の復旧も、
すべて `moderation_log` に記録が残ります。記録はコミュニティ画面の
「監査ログ」から見られます（運営者のみ）。

> `admins` テーブルは RLS を有効にしたうえでポリシーを 1 つも作っていないので、
> 一般の利用者からは名簿の存在すら見えません。

## 5.5. 本番 URL を Supabase に登録する

公開ページからメールでログインするには、Supabase 側にその URL を教えておく必要があります。
ここが未設定だと、メールのリンクが既定の `localhost:3000` へ飛んでログインが成立しません。

**Authentication → URL Configuration**

| 項目 | 値 |
| --- | --- |
| Site URL | `https://longcape.github.io/claudeamazon/` |
| Redirect URLs | `https://longcape.github.io/claudeamazon/**` |
| Redirect URLs（開発用に残す） | `http://localhost:8080/**` |

開発用の `localhost` は消さないでください。手元で確認するときに要ります。
両方を登録しておけば、本番でも手元でも同じようにログインできます。

## 4. AI 寸評（Claude API）を有効にする

AI 寸評は Edge Function 経由で呼び出します。**API キーをブラウザに置かないため**です。

```bash
# Supabase CLI が必要
supabase login
supabase link --project-ref <プロジェクトID>

# Anthropic の API キーを登録
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

# デプロイ
supabase functions deploy tactic-review
```

これで LIVE BOARD の相性判定パネルに「AI 寸評を生成」ボタンが出ます。

### 使っているモデルと API の設定

| 項目 | 値 | 理由 |
| --- | --- | --- |
| モデル | `claude-opus-5` | 構成の相性という推論が必要な題材で、最も精度が高い |
| thinking | `adaptive` | 必要なときだけ深く考えるので、簡単な判定では余計に課金されない |
| effort | `medium` | 寸評は数百トークンの出力なので、深さより速さを優先 |
| fallbacks | `"default"` | 安全性分類器が拒否した場合、同じ呼び出しの中で自動的に別モデルへ回す |
| max_tokens | `2000` | 出力が JSON の寸評だけなので十分 |

コストを下げたい場合は `supabase/functions/tactic-review/index.ts` の
`model` を `claude-haiku-4-5` に変えられます（後述の比較を参照）。

---

## 5. 課金の考え方

### Claude API は従量課金です

定額プランではなく、**送受信したトークン量に応じた従量課金**です。
1 回の寸評はおおよそ 入力 900 トークン / 出力 450 トークン 程度になります。

| モデル | 入力 $/1M | 出力 $/1M | 寸評 1 回あたり | 1,000 回あたり |
| --- | --- | --- | --- | --- |
| Claude Opus 5 | $5.00 | $25.00 | 約 $0.016（約 2.4 円） | 約 $16（約 2,400 円） |
| Claude Haiku 4.5 | $1.00 | $5.00 | 約 $0.003（約 0.5 円） | 約 $3（約 470 円） |

※ 1 ドル 150 円で換算。実際のトークン数は戦術メモの長さで前後します。

### 実装済みのコスト上限

`supabase/functions/tactic-review/index.ts` の冒頭で、**1 人 1 日あたりの生成回数**を制限しています。

```ts
const DAILY_QUOTA_ANON = 3;   // 未ログイン
const DAILY_QUOTA_USER = 20;  // ログイン済み
```

利用は `ai_usage` テーブルに記録され、上限を超えると HTTP 429 を返して
Claude API を呼ばずに終了します。**青天井の請求は構造的に発生しません。**

### 広告収入で賄えるか

結論から言うと、**広告だけで AI 寸評を賄うにはかなりの規模が必要です。**

一般的な Web ディスプレイ広告の収益は 1,000 表示あたり 100〜300 円程度です。
Opus 5 で 1 日 1,000 回の寸評を出すと月あたり約 72,000 円かかるので、
広告だけで賄うには**月間 24 万〜72 万 PV** が必要になります。

現実的な組み方は次の順序です。

1. **まず無料枠だけで公開する** — 上記のクォータがあるので、
   利用者が増えても支出は「利用者数 × 3 回 × 2.4 円」で頭打ちになります
2. **ルールベース判定は無料・無制限のまま置く** — 実戦中に使うのはこちらで、
   オフラインでも即座に動き、コストがゼロです。AI 寸評は「投稿前に一度出す」用途に絞ります
3. **利用者が付いてから収益化を足す** — 広告を入れるか、
   ログインユーザー向けに月額（AI 寸評の回数上限を引き上げる）を用意します

AI 寸評をコストの中心に据えるより、**ルールベース判定を主役にして
AI は付加価値**という今の構成のほうが、収益化前でも運用が破綻しません。

---

## 6. ホスティング

コミュニティ版を公開するには通常のホスティングが必要です。

### GitHub Pages（このプロジェクトで採用しているやり方）

**すでに公開してあります: https://longcape.github.io/claudeamazon/**

`.github/workflows/pages.yml` が、作業ブランチへ push されるたびに公開ページを更新します。
Pages の公開元は「GitHub Actions」で、`index.html` と `assets/` と `dist/` だけを載せます。

接続情報はリポジトリの **Variables** から流し込みます。
`assets/js/config.js` は空のままコミットしてあるので、公開のときだけ
`tools/write-config.mjs` が書き込みます。

> Settings → Secrets and variables → Actions → **Variables**
>
> | 名前 | 値 |
> | --- | --- |
> | `SUPABASE_URL` | `https://xxxxxxxx.supabase.co` |
> | `SUPABASE_ANON_KEY` | `sb_publishable_...` |

anon key はブラウザに露出する前提の公開キーなので、Secrets ではなく Variables に置いています。
`write-config.mjs` は service role キーらしき値を渡されたら中断します。
Variables が空でもページは出ます。その場合はコミュニティとクラウド保存が隠れた、
オフライン用のソロ版として公開されます。

**Supabase 側も本番 URL に合わせてください**（下の「5.5. 本番 URL を Supabase に登録する」）。

独自ドメインを足すときは Settings → Pages → Custom domain。
`CNAME` が作業ブランチへ入るので、そのあと Supabase の URL 設定も直します。

### Vercel / Netlify

ビルド不要の静的サイトなので、リポジトリを接続するだけで公開できます。
出力ディレクトリの指定は不要です（ルートの `index.html` がそのまま入口になります）。

> Discord OAuth のリダイレクト先は本番 URL に合わせて Supabase 側の
> **Authentication → URL Configuration → Site URL** も更新してください。

---

## 7. 言語を追加する

`assets/js/locales/` に 1 ファイル追加するだけです。コードの変更は不要です。

```js
/* assets/js/locales/pt-BR.js */
window.VCT_I18N.register('pt-BR', { name: 'Português', flag: '🇧🇷' }, {
  'app.title': 'TACTICAL SETUP CARD',
  ...
});
```

`index.html` の `<script>` 一覧に追加すれば、言語セレクタに自動的に並びます。
翻訳が欠けているキーは英語にフォールバックするので、**部分的な翻訳でも壊れません。**

キーの一覧と対訳は `assets/js/locales/ja.js` と `en.js` を並べて見るのが早いです。
現在のキー数は **372**（ja / en / ko すべて同数）です。
キーを増やしたときは 3 ファイルすべてに足してください。

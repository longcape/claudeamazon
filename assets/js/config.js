/* =========================================================
   CONFIG
   コミュニティ機能（Supabase）と AI 寸評の接続設定。
   ---------------------------------------------------------
   空のままでもアプリは完全に動作する。値を入れた場合のみ
   COMMUNITY タブと AI 寸評が有効になる。
   anon key はブラウザに露出する前提の公開キーで、実際の
   アクセス制御は Supabase 側の RLS ポリシーが行う。
   （supabase/schema.sql を参照）
   ========================================================= */
window.VCT_CONFIG = {
  /* Supabase プロジェクトの URL 例: https://xxxxxxxx.supabase.co */
  SUPABASE_URL: '',

  /* Supabase の anon / publishable key */
  SUPABASE_ANON_KEY: '',

  /* ログイン方法。competitive シーンでの導線を優先し Discord を既定にしている */
  AUTH_PROVIDERS: ['discord'],

  /* メールのマジックリンクも併用するか */
  AUTH_EMAIL: true,

  /* AI 寸評を返す Edge Function 名（supabase/functions/ 以下） */
  AI_REVIEW_FUNCTION: 'tactic-review',

  /* AI 寸評を UI に出すか。false ならボタン自体を隠す */
  AI_REVIEW_ENABLED: true,

  /* 登録できる戦術の上限。0 で無制限。
     将来的に課金要素にする場合、無料枠をここで絞る。 */
  TACTIC_LIMIT_FREE: 0,

  /* ログイン済みユーザーの上限。0 で無制限 */
  TACTIC_LIMIT_SIGNED_IN: 0
};

window.VCT_CONFIG.isCommunityEnabled = function () {
  return !!(window.VCT_CONFIG.SUPABASE_URL && window.VCT_CONFIG.SUPABASE_ANON_KEY);
};

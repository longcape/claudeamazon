/* =========================================================
   COMMUNITY (Supabase)
   supabase-js を使わず REST / GoTrue を直接叩く。
   外部スクリプトを読まないので、単一 HTML へのバンドルを維持できる。
   ---------------------------------------------------------
   認証方針:
     - 戦術の投稿・閲覧・いいね … ログイン不要（匿名可）
     - セットアップの保存・投稿の編集削除 … ログイン必須
   ログインは競技シーンでの導線を優先して Discord を既定にし、
   メールのマジックリンクを代替として用意している。
   ========================================================= */
(function (global) {
  'use strict';

  const CFG = global.VCT_CONFIG;
  const SESSION_KEY = 'vct.session';
  const ANON_KEY = 'vct.anonId';
  const REPORTED_KEY = 'vct.reported';

  let session = null;      // { access_token, refresh_token, expires_at, user }
  let admin = false;       // 運営者かどうか。DB に聞いた結果を覚えておく

  function enabled() { return CFG.isCommunityEnabled(); }

  function base() { return String(CFG.SUPABASE_URL).replace(/\/+$/, ''); }

  /** 匿名ユーザーを識別するローカル ID（いいねの重複防止に使う） */
  function anonId() {
    let id = null;
    try { id = localStorage.getItem(ANON_KEY); } catch (e) { /* noop */ }
    if (!id) {
      id = 'anon_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { localStorage.setItem(ANON_KEY, id); } catch (e) { /* noop */ }
    }
    return id;
  }

  /* 通報済みの投稿。サーバ側は tactic_reports の主キーで弾いているので、
     こちらは「押す前からボタンを通報済みにしておく」ためだけの控え。 */
  function reportedIds() {
    try { return JSON.parse(localStorage.getItem(REPORTED_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }

  function rememberReported(postId) {
    try {
      const map = reportedIds();
      map[postId] = 1;
      localStorage.setItem(REPORTED_KEY, JSON.stringify(map));
    } catch (e) { /* 保存できなくてもサーバ側で弾かれる */ }
  }

  /* ---------------- HTTP ---------------- */
  function headers(extra) {
    const h = Object.assign({
      'apikey': CFG.SUPABASE_ANON_KEY,
      'Content-Type': 'application/json'
    }, extra || {});
    h.Authorization = 'Bearer ' + (session ? session.access_token : CFG.SUPABASE_ANON_KEY);
    return h;
  }

  function request(path, options) {
    options = options || {};
    return fetch(base() + path, {
      method: options.method || 'GET',
      headers: headers(options.headers),
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        let data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
        if (!res.ok) {
          const msg = (data && (data.message || data.error_description || data.error || data.msg)) || ('HTTP ' + res.status);
          const err = new Error(msg);
          err.status = res.status;
          /* 画面に出すのは呼び出し側で作った文言だけにする。
             ここで拾った生の中身は、切り分けと console 用にだけ持たせる。 */
          err.code = (data && data.code) || null;
          err.raw = typeof data === 'string' ? data : JSON.stringify(data);
          throw err;
        }
        return data;
      });
    });
  }

  /* ---------------- セッション ---------------- */
  function loadSession() {
    /* 保存が消えていたら、覚えている分も捨てる。
       ここで session を残していると、別タブでログアウトしたあとも
       この画面だけログイン済みのまま見えてしまう。 */
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) { session = null; return null; }
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.access_token) { session = null; return null; }
      session = parsed;
      return session;
    } catch (e) { session = null; return null; }
  }

  function storeSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* noop */ }
  }

  function currentUser() {
    return session && session.user ? session.user : null;
  }

  function displayName() {
    const u = currentUser();
    if (!u) return null;
    const m = u.user_metadata || {};
    return m.full_name || m.name || m.user_name || m.preferred_username || u.email || 'PLAYER';
  }

  /** アクセストークンの期限が近ければ更新する */
  function ensureFresh() {
    if (!session) return Promise.resolve(null);
    const now = Math.floor(Date.now() / 1000);
    if (session.expires_at && session.expires_at - now > 60) return Promise.resolve(session);
    if (!session.refresh_token) { storeSession(null); return Promise.resolve(null); }

    const saved = session;
    session = null;   // 更新リクエストは anon key で送る
    return request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: saved.refresh_token }
    }).then(function (data) {
      storeSession(normalizeSession(data));
      return session;
    }, function () {
      storeSession(null);
      return null;
    });
  }

  function normalizeSession(data) {
    if (!data || !data.access_token) return null;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at || (Math.floor(Date.now() / 1000) + (data.expires_in || 3600)),
      user: data.user || null
    };
  }

  /* ---------------- ログイン ---------------- */
  function signInWithProvider(provider) {
    const redirect = location.origin + location.pathname;
    location.href = base() + '/auth/v1/authorize'
      + '?provider=' + encodeURIComponent(provider)
      + '&redirect_to=' + encodeURIComponent(redirect);
  }

  function signInWithEmail(email) {
    /* GoTrue はリダイレクト先を本文ではなくクエリの redirect_to から読む。
       本文の options に入れても無視され、プロジェクトの Site URL へ飛ばされる。 */
    const redirect = encodeURIComponent(location.origin + location.pathname);
    return request('/auth/v1/otp?redirect_to=' + redirect, {
      method: 'POST',
      body: { email: email, create_user: true }
    });
  }

  function signOut() {
    admin = false;
    const had = !!session;
    const p = had ? request('/auth/v1/logout', { method: 'POST' }).catch(function () { /* 失敗しても破棄する */ })
                  : Promise.resolve();
    return p.then(function () { storeSession(null); });
  }

  /** OAuth / マジックリンクのリダイレクト後、URL ハッシュからトークンを取り出す */
  function consumeRedirect() {
    if (!location.hash || location.hash.indexOf('access_token') < 0) return Promise.resolve(null);
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const token = params.get('access_token');
    if (!token) return Promise.resolve(null);

    const s = {
      access_token: token,
      refresh_token: params.get('refresh_token') || '',
      expires_at: Math.floor(Date.now() / 1000) + Number(params.get('expires_in') || 3600),
      user: null
    };
    storeSession(s);
    history.replaceState(null, '', location.pathname + location.search);

    return request('/auth/v1/user').then(function (user) {
      s.user = user;
      storeSession(s);
      return s;
    }, function () { return s; });
  }

  /* ---------------- 投稿 ---------------- */
  /**
   * 投稿一覧。
   * @param {Object} opts { sort: 'new'|'top', map: string|'', limit: number }
   */
  function listPosts(opts) {
    opts = opts || {};
    const params = [
      'select=*',
      'limit=' + (opts.limit || 40),
      'order=' + (opts.sort === 'top' ? 'likes.desc,created_at.desc' : 'created_at.desc')
    ];
    /* 運営者は RLS で隠れている投稿も引けてしまうので、
       既定では明示的に外す。見たいときだけ includeHidden を立てる。 */
    if (!opts.includeHidden) params.push('hidden=eq.false');
    if (opts.map) params.push('map=eq.' + encodeURIComponent(opts.map));
    if (opts.side) params.push('side=eq.' + encodeURIComponent(opts.side));
    return request('/rest/v1/tactic_posts?' + params.join('&'));
  }

  /** 投稿する。ログインしていればユーザーに紐づき、していなければ匿名投稿になる */
  function createPost(payload) {
    const body = {
      name: payload.name,
      map: payload.map,
      side: payload.side,
      site: payload.site,
      kind: payload.kind,
      note: payload.note || '',
      author_name: payload.authorName || 'ANONYMOUS',
      lang: payload.lang || 'ja',
      ally_comp: payload.allyComp || [],
      enemy_comp: payload.enemyComp || [],
      analysis_score: payload.analysisScore === undefined ? null : payload.analysisScore
    };
    return ensureFresh().then(function () {
      return request('/rest/v1/tactic_posts', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: body
      });
    }).then(function (rows) { return Array.isArray(rows) ? rows[0] : rows; });
  }

  /** いいね。同一ブラウザからの重複は DB 側の一意制約で弾かれる */
  function likePost(postId) {
    return ensureFresh().then(function () {
      return request('/rest/v1/rpc/like_post', {
        method: 'POST',
        body: { p_post_id: postId, p_voter: currentUser() ? currentUser().id : anonId() }
      });
    });
  }

  /**
   * 通報。通報者は「ログインしていれば user id、していなければ匿名 ID」。
   * 同じ通報者の 2 回目以降はサーバ側で数えられない（counted が false で返る）。
   */
  function reportPost(postId, reason, detail) {
    return ensureFresh().then(function () {
      return request('/rest/v1/rpc/report_post', {
        method: 'POST',
        body: {
          p_post_id: postId,
          p_reporter: currentUser() ? currentUser().id : anonId(),
          p_reason: reason || 'other',
          p_detail: detail || ''
        }
      });
    }).then(function (res) {
      rememberReported(postId);
      return res || {};
    });
  }

  /* 自分の投稿だけ編集できる。他人の行は RLS で 0 件になるだけで例外にはならない */
  function updatePost(postId, patch) {
    return ensureFresh().then(function (s) {
      if (!s) throw new Error('AUTH_REQUIRED');
      return request('/rest/v1/tactic_posts?id=eq.' + encodeURIComponent(postId), {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: patch
      });
    }).then(function (rows) { return Array.isArray(rows) ? rows[0] : rows; });
  }

  function deletePost(postId) {
    return ensureFresh().then(function (s) {
      if (!s) throw new Error('AUTH_REQUIRED');
      return request('/rest/v1/tactic_posts?id=eq.' + encodeURIComponent(postId), {
        method: 'DELETE',
        headers: { 'Prefer': 'return=representation' }
      });
    });
  }

  /* ---------------- 保存したセットアップ（要ログイン） ---------------- */
  function listSetups() {
    return ensureFresh().then(function (s) {
      if (!s) return [];
      return request('/rest/v1/saved_setups?select=*&order=updated_at.desc');
    });
  }

  function saveSetup(name, payload) {
    return ensureFresh().then(function (s) {
      if (!s) throw new Error('AUTH_REQUIRED');
      return request('/rest/v1/saved_setups', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: { name: name, payload: payload }
      });
    }).then(function (rows) { return Array.isArray(rows) ? rows[0] : rows; });
  }

  /* 同じ名前で保存し直すとき用。行を増やさず中身だけ差し替える */
  function updateSetup(id, name, payload) {
    return ensureFresh().then(function (s) {
      if (!s) throw new Error('AUTH_REQUIRED');
      return request('/rest/v1/saved_setups?id=eq.' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: { name: name, payload: payload }
      });
    }).then(function (rows) { return Array.isArray(rows) ? rows[0] : rows; });
  }

  function deleteSetup(id) {
    return ensureFresh().then(function (s) {
      if (!s) throw new Error('AUTH_REQUIRED');
      return request('/rest/v1/saved_setups?id=eq.' + encodeURIComponent(id), { method: 'DELETE' });
    });
  }

  /* ---------------- 運営操作 ---------------- */
  /**
   * 自分が運営者かを DB に聞く。画面の出し分けにしか使わない。
   * 実際の可否は RPC 側の is_admin() が毎回見ているので、
   * ここを書き換えられても運営操作は通らない。
   */
  function refreshAdmin() {
    if (!session) { admin = false; return Promise.resolve(false); }
    return request('/rest/v1/rpc/is_admin', { method: 'POST', body: {} })
      .then(function (v) { admin = v === true; return admin; },
            function () { admin = false; return false; });
  }

  function isAdmin() { return admin; }

  /** 投稿を隠す / 戻す。復旧すると以後は通報が集まっても自動では隠れない */
  function adminSetHidden(postId, hidden, note) {
    return ensureFresh().then(function (s) {
      if (!s) throw new Error('AUTH_REQUIRED');
      return request('/rest/v1/rpc/admin_set_hidden', {
        method: 'POST',
        body: { p_post_id: postId, p_hidden: !!hidden, p_note: note || '' }
      });
    });
  }

  /** 投稿ごとの通報の内訳。通報者そのものは返ってこない */
  function adminReportBreakdown(postId) {
    return ensureFresh().then(function (s) {
      if (!s) throw new Error('AUTH_REQUIRED');
      return request('/rest/v1/rpc/admin_report_breakdown', {
        method: 'POST',
        body: { p_post_id: postId }
      });
    });
  }

  /** 運営操作の記録。RLS で運営者にしか返らない */
  function adminLog(limit) {
    return ensureFresh().then(function (s) {
      if (!s) throw new Error('AUTH_REQUIRED');
      return request('/rest/v1/moderation_log?select=*&order=created_at.desc&limit=' + (limit || 50));
    });
  }

  /* ---------------- AI 寸評（Edge Function） ---------------- */
  function aiReview(payload) {
    if (!enabled() || !CFG.AI_REVIEW_ENABLED) return Promise.reject(new Error('DISABLED'));
    return ensureFresh().then(function () {
      return request('/functions/v1/' + CFG.AI_REVIEW_FUNCTION, {
        method: 'POST',
        body: payload
      });
    });
  }

  /* ---------------- 起動 ---------------- */
  function init() {
    if (!enabled()) return Promise.resolve(null);
    loadSession();
    return consumeRedirect().then(function () {
      return ensureFresh();
    }).then(function () {
      /* user 情報が欠けている場合は取り直す */
      if (session && !session.user) {
        return request('/auth/v1/user').then(function (user) {
          session.user = user;
          storeSession(session);
          return session;
        }, function () { return session; });
      }
      return session;
    }).then(function (s) {
      return refreshAdmin().then(function () { return s; });
    });
  }

  global.VCT_COMMUNITY = {
    enabled: enabled,
    init: init,
    currentUser: currentUser,
    displayName: displayName,
    signInWithProvider: signInWithProvider,
    signInWithEmail: signInWithEmail,
    signOut: signOut,
    listPosts: listPosts,
    createPost: createPost,
    likePost: likePost,
    reportPost: reportPost,
    isAdmin: isAdmin,
    refreshAdmin: refreshAdmin,
    adminSetHidden: adminSetHidden,
    adminReportBreakdown: adminReportBreakdown,
    adminLog: adminLog,
    updatePost: updatePost,
    deletePost: deletePost,
    reportedIds: reportedIds,
    listSetups: listSetups,
    saveSetup: saveSetup,
    updateSetup: updateSetup,
    deleteSetup: deleteSetup,
    aiReview: aiReview,
    anonId: anonId
  };
})(window);

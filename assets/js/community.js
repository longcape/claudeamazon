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

  let session = null;      // { access_token, refresh_token, expires_at, user }

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
          throw err;
        }
        return data;
      });
    });
  }

  /* ---------------- セッション ---------------- */
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.access_token) return null;
      session = parsed;
      return session;
    } catch (e) { return null; }
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
    listSetups: listSetups,
    saveSetup: saveSetup,
    updateSetup: updateSetup,
    deleteSetup: deleteSetup,
    aiReview: aiReview,
    anonId: anonId
  };
})(window);

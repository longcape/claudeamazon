/* =========================================================
   STATE STORE
   状態管理・localStorage 永続化・派生値の計算
   ========================================================= */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'vct.setup-card.v1';
  const D = global.VCT_DATA;

  function uid() {
    return 'tc_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  function emptySlot() {
    return { agent: '', player: '' };
  }

  function defaultState() {
    return {
      version: 1,
      phase: 'setup',                 // 'setup' | 'live'
      match: {
        map: 'ascent',
        startSide: 'ATK',             // 前半のサイド
        allyTeam: 'OUR TEAM',
        enemyTeam: 'OPPONENT',
        note: ''
      },
      allies:  [emptySlot(), emptySlot(), emptySlot(), emptySlot(), emptySlot()],
      enemies: [emptySlot(), emptySlot(), emptySlot(), emptySlot(), emptySlot()],
      tactics: [],
      rounds: [],                     // 確定したラウンドの記録
      pending: null,                  // 現在ラウンドにセット済みの戦術 { tacticId, economy }
      sideOverrides: {}               // { roundNumber: 'ATK'|'DEF' } 手動でサイドを上書きした場合
    };
  }

  const state = defaultState();

  /* ---------------- 永続化 ---------------- */
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* プライベートモード等では黙って諦める */ }
  }

  function load() {
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1) return false;
      hydrate(parsed);
      return true;
    } catch (e) { return false; }
  }

  function hydrate(obj) {
    const base = defaultState();
    state.phase   = obj.phase === 'live' ? 'live' : 'setup';
    state.match   = Object.assign(base.match, obj.match || {});
    state.allies  = normalizeRoster(obj.allies);
    state.enemies = normalizeRoster(obj.enemies);
    state.tactics = Array.isArray(obj.tactics) ? obj.tactics.map(normalizeTactic) : [];
    state.rounds  = Array.isArray(obj.rounds) ? obj.rounds.filter(function (r) {
      return r && (r.result === 'WIN' || r.result === 'LOSS');
    }) : [];
    state.pending = obj.pending && obj.pending.tacticId ? obj.pending : null;
    state.sideOverrides = obj.sideOverrides && typeof obj.sideOverrides === 'object' ? obj.sideOverrides : {};
  }

  function normalizeRoster(arr) {
    const out = [];
    for (let i = 0; i < 5; i++) {
      const src = Array.isArray(arr) ? arr[i] : null;
      out.push({
        agent: src && typeof src.agent === 'string' ? src.agent : '',
        player: src && typeof src.player === 'string' ? src.player : ''
      });
    }
    return out;
  }

  function normalizeTactic(t) {
    return {
      id: t.id || uid(),
      name: String(t.name || 'NO NAME').slice(0, 60),
      side: t.side === 'ATK' || t.side === 'DEF' ? t.side : 'BOTH',
      site: String(t.site || '-').slice(0, 8),
      kind: t.kind || 'execute',
      note: String(t.note || '').slice(0, 400)
    };
  }

  /* ---------------- 戦術デッキ ---------------- */
  function addTactic(payload) {
    const t = normalizeTactic(Object.assign({ id: uid() }, payload));
    state.tactics.push(t);
    save();
    return t;
  }

  function updateTactic(id, payload) {
    const idx = state.tactics.findIndex(function (t) { return t.id === id; });
    if (idx < 0) return null;
    state.tactics[idx] = normalizeTactic(Object.assign({}, state.tactics[idx], payload, { id: id }));
    save();
    return state.tactics[idx];
  }

  function removeTactic(id) {
    state.tactics = state.tactics.filter(function (t) { return t.id !== id; });
    if (state.pending && state.pending.tacticId === id) state.pending = null;
    save();
  }

  function tacticById(id) {
    return state.tactics.find(function (t) { return t.id === id; }) || null;
  }

  /* ---------------- ラウンド進行 ---------------- */
  function currentRoundNumber() {
    return state.rounds.length + 1;
  }

  /** ラウンド n のサイド（1-12 前半 / 13-24 後半 / 25- OTは毎ラウンド交代） */
  function sideForRound(n) {
    const override = state.sideOverrides[String(n)];
    if (override === 'ATK' || override === 'DEF') return override;
    const start = state.match.startSide === 'DEF' ? 'DEF' : 'ATK';
    const flip = start === 'ATK' ? 'DEF' : 'ATK';
    if (n <= 12) return start;
    if (n <= 24) return flip;
    return (n - 25) % 2 === 0 ? start : flip;
  }

  function flipSideForRound(n) {
    state.sideOverrides[String(n)] = sideForRound(n) === 'ATK' ? 'DEF' : 'ATK';
    save();
  }

  function score() {
    let win = 0;
    for (let i = 0; i < state.rounds.length; i++) if (state.rounds[i].result === 'WIN') win++;
    return { ally: win, enemy: state.rounds.length - win };
  }

  /** 13 先取・2 差、それ以外は OT。決着していれば勝者を返す */
  function matchResult() {
    const s = score();
    const hi = Math.max(s.ally, s.enemy);
    const diff = Math.abs(s.ally - s.enemy);
    if (hi >= 13 && diff >= 2) return s.ally > s.enemy ? 'WIN' : 'LOSS';
    return null;
  }

  function setPending(tacticId, economy) {
    if (!tacticById(tacticId)) return;
    state.pending = { tacticId: tacticId, economy: economy || 'full' };
    save();
  }

  function clearPending() {
    state.pending = null;
    save();
  }

  function commitRound(result, note) {
    if (!state.pending) return null;
    const n = currentRoundNumber();
    const rec = {
      n: n,
      side: sideForRound(n),
      tacticId: state.pending.tacticId,
      economy: state.pending.economy || 'full',
      result: result === 'WIN' ? 'WIN' : 'LOSS',
      note: String(note || '').slice(0, 200),
      at: Date.now()
    };
    state.rounds.push(rec);
    state.pending = null;
    save();
    return rec;
  }

  function undoLastRound() {
    const last = state.rounds.pop();
    if (last) {
      state.pending = { tacticId: last.tacticId, economy: last.economy };
      save();
    }
    return last || null;
  }

  function lastRound() {
    return state.rounds.length ? state.rounds[state.rounds.length - 1] : null;
  }

  /* ---------------- 戦術ごとの成績 ---------------- */
  function statsFor(tacticId) {
    let win = 0, loss = 0, streak = 0, lastUsedRound = 0;
    for (let i = 0; i < state.rounds.length; i++) {
      const r = state.rounds[i];
      if (r.tacticId !== tacticId) continue;
      if (r.result === 'WIN') win++; else loss++;
      lastUsedRound = r.n;
    }
    // 直近の連続使用回数
    for (let i = state.rounds.length - 1; i >= 0; i--) {
      if (state.rounds[i].tacticId === tacticId) streak++; else break;
    }
    const used = win + loss;
    return {
      win: win,
      loss: loss,
      used: used,
      winRate: used ? Math.round((win / used) * 100) : null,
      streak: streak,
      lastUsedRound: lastUsedRound,
      roundsSinceUse: lastUsedRound ? state.rounds.length - lastUsedRound + 1 : null
    };
  }

  /* ---------------- リセット / 入出力 ---------------- */
  function resetMatch() {
    state.rounds = [];
    state.pending = null;
    state.sideOverrides = {};
    save();
  }

  function resetAll() {
    hydrate(defaultState());
    save();
  }

  function exportJSON() {
    return JSON.stringify(state, null, 2);
  }

  function importJSON(text) {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.version !== 1) throw new Error('対応していないフォーマットです');
    hydrate(parsed);
    save();
  }

  global.VCT_STORE = {
    state: state,
    uid: uid,
    save: save,
    load: load,
    addTactic: addTactic,
    updateTactic: updateTactic,
    removeTactic: removeTactic,
    tacticById: tacticById,
    currentRoundNumber: currentRoundNumber,
    sideForRound: sideForRound,
    flipSideForRound: flipSideForRound,
    score: score,
    matchResult: matchResult,
    setPending: setPending,
    clearPending: clearPending,
    commitRound: commitRound,
    undoLastRound: undoLastRound,
    lastRound: lastRound,
    statsFor: statsFor,
    resetMatch: resetMatch,
    resetAll: resetAll,
    exportJSON: exportJSON,
    importJSON: importJSON,
    seedSamples: function () {
      D.SAMPLE_TACTICS.forEach(function (t) { addTactic(t); });
    }
  };
})(window);

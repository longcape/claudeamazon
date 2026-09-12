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
      /* よく使う 5 人構成。エージェントセレクトの時間を稼ぐためのもの */
      comps: [],
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
    }).map(normalizeRound) : [];
    state.comps   = normalizeComps(obj.comps);
    state.pending = obj.pending && obj.pending.tacticId ? obj.pending : null;
    state.sideOverrides = obj.sideOverrides && typeof obj.sideOverrides === 'object' ? obj.sideOverrides : {};
  }

  /* 保存した 5 人構成。上限を切っておかないと
     押し間違いで際限なく増える */
  const MAX_COMPS = 12;

  function normalizeComps(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, MAX_COMPS).map(function (c) {
      return {
        id: String((c && c.id) || uid()),
        name: String((c && c.name) || '').slice(0, 30),
        agents: (Array.isArray(c && c.agents) ? c.agents : [])
          .slice(0, 5)
          .map(function (a) { return typeof a === 'string' ? a : ''; })
      };
    }).filter(function (c) { return c.agents.some(Boolean); });
  }

  function saveComp(name, agents) {
    if (state.comps.length >= MAX_COMPS) return null;
    const comp = normalizeComps([{ name: name, agents: agents }])[0];
    if (!comp) return null;
    state.comps.push(comp);
    save();
    return comp;
  }

  function removeComp(id) {
    state.comps = state.comps.filter(function (c) { return c.id !== id; });
    save();
  }

  /** 保存した構成をスロットへ流し込む。プレイヤー名は触らない */
  function applyComp(team, id) {
    const comp = state.comps.filter(function (c) { return c.id === id; })[0];
    if (!comp) return false;
    const roster = team === 'enemy' ? state.enemies : state.allies;
    for (let i = 0; i < 5; i++) roster[i].agent = comp.agents[i] || '';
    save();
    return true;
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
      note: String(t.note || '').slice(0, 400),
      next: normalizeNext(t.next),
      phases: normalizePhases(t)
    };
  }

  /* 勝敗ごとの次の戦術。指す先が消されていても壊れないよう、
     ここでは形だけ整えて中身の存在確認は読むときに行う（tree.js） */
  function normalizeNext(next) {
    const src = next && typeof next === 'object' ? next : {};
    const pick = function (v) { return typeof v === 'string' && v ? v.slice(0, 40) : null; };
    return { win: pick(src.win), loss: pick(src.loss) };
  }

  /* 局面（フェーズ）。A フェイク → B 本命 のように時間で分かれる動きを
     1 枚に混ぜず別々の盤面に描くための単位。
     旧形式（board が 1 枚だけ）で保存されたデータもここで引き継ぐ。 */
  const MAX_PHASES = 4;

  function normalizePhases(t) {
    let list = Array.isArray(t.phases) && t.phases.length ? t.phases : null;
    if (!list) list = [t.board && typeof t.board === 'object' ? t.board : {}];
    return list.slice(0, MAX_PHASES).map(function (p) {
      const board = normalizeBoard(p);
      board.id = String((p && p.id) || uid());
      board.name = String((p && p.name) || '').slice(0, 24);
      return board;
    });
  }

  const MARK_KINDS = ['agent', 'ability', 'plant'];

  /* 局面の表示範囲（ズームとパン）。
     古い保存データは持っていないので、その場合は付けない（= 全体表示）。
     倍率の上限や中心の丸めは board.js が正本で、読み込めるならそれを使う。 */
  function normalizeView(v) {
    if (!v || typeof v !== 'object') return undefined;
    const zoom = Number(v.zoom);
    if (!Number.isFinite(zoom) || zoom <= 1) return undefined;
    const B = global.VCT_BOARD;
    if (B && B.clampView) {
      const clamped = B.clampView(v);
      return clamped.zoom > 1 ? clamped : undefined;
    }
    /* board.js より先に呼ばれた場合の保険。値を捨てずに最低限の範囲へ収める */
    const z = Math.min(4, zoom);
    const half = 50 / z;
    const fit = function (n) {
      const x = Number(n);
      return Math.max(half, Math.min(100 - half, Number.isFinite(x) ? x : 50));
    };
    return { zoom: z, cx: fit(v.cx), cy: fit(v.cy) };
  }

  /** 配置盤。壊れた入力を読み込んでも落ちないよう作り直す */
  function normalizeBoard(board) {
    const src = board && typeof board === 'object' ? board : {};
    const marks = Array.isArray(src.marks) ? src.marks : [];
    const routes = Array.isArray(src.routes) ? src.routes : [];
    const view = normalizeView(src.view);

    return Object.assign(view ? { view: view } : {}, {
      marks: marks.slice(0, 60).map(function (m) {
        return {
          id: String(m.id || uid()),
          kind: MARK_KINDS.indexOf(m.kind) >= 0 ? m.kind : 'agent',
          ref: String(m.ref || ''),
          team: m.team === 'enemy' ? 'enemy' : 'ally',
          x: numberIn(m.x),
          y: numberIn(m.y),
          order: Number.isFinite(m.order) ? m.order : null
        };
      }).filter(function (m) { return m.ref; }),

      routes: routes.slice(0, 20).map(function (r) {
        return {
          id: String(r.id || uid()),
          team: r.team === 'enemy' ? 'enemy' : 'ally',
          points: (Array.isArray(r.points) ? r.points : []).slice(0, 40).map(function (p) {
            return { x: numberIn(p && p.x), y: numberIn(p && p.y) };
          })
        };
      }).filter(function (r) { return r.points.length >= 2; })
    });
  }

  function numberIn(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 50;
    return Math.max(2, Math.min(98, n));
  }

  /* ---------------- 戦術デッキ ---------------- */
  /** 登録できる戦術の上限。0 以下なら無制限 */
  function tacticLimit() {
    const cfg = global.VCT_CONFIG || {};
    const signedIn = global.VCT_COMMUNITY && global.VCT_COMMUNITY.currentUser();
    const limit = signedIn ? cfg.TACTIC_LIMIT_SIGNED_IN : cfg.TACTIC_LIMIT_FREE;
    return Number.isFinite(limit) ? limit : 0;
  }

  function tacticLimitReached() {
    const limit = tacticLimit();
    return limit > 0 && state.tactics.length >= limit;
  }

  function addTactic(payload) {
    if (tacticLimitReached()) return null;
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

  /* ---------------- ラウンドの評価 ----------------
     勝敗だけでは「作戦そのものが悪かった」のか「作戦は良かったが実行が崩れた」のかが
     分からない。作戦品質と遂行品質を分けて見られるよう、遂行度（exec）と理由を別に持つ。
     古い保存データはどちらも持っていないので、その場合は未評価として扱う。
     今回は貯めるだけで、推奨スコアには反映しない（サンプル数が無いため）。 */
  const EXEC_LEVELS = ['clean', 'partial', 'failed', 'unrated'];
  const REASON_KEYS = [
    'read', 'utility', 'entry', 'trade', 'numbers', 'preplant', 'postplant',
    'counter', 'rotation', 'timing', 'comms', 'duel', 'outplay', 'planWorked', 'other'
  ];
  const REASON_NOTE_MAX = 120;

  function normalizeExec(v) {
    return EXEC_LEVELS.indexOf(v) >= 0 ? v : 'unrated';
  }

  /* 知らない理由が来ても落とさず捨てる。重複も 1 つにまとめる */
  function normalizeReasons(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    list.forEach(function (r) {
      if (REASON_KEYS.indexOf(r) >= 0 && out.indexOf(r) < 0) out.push(r);
    });
    return out;
  }

  function normalizeRound(r) {
    return Object.assign({}, r, {
      exec: normalizeExec(r && r.exec),
      reasons: normalizeReasons(r && r.reasons),
      reasonNote: String((r && r.reasonNote) || '').slice(0, REASON_NOTE_MAX)
    });
  }

  /** ラウンド n の評価を書き換える。渡されたものだけ触る（後から足せるように） */
  function setRoundEval(n, patch) {
    const rec = state.rounds.filter(function (r) { return r.n === n; })[0];
    if (!rec || !patch) return null;
    if (patch.exec !== undefined) rec.exec = normalizeExec(patch.exec);
    if (patch.reasons !== undefined) rec.reasons = normalizeReasons(patch.reasons);
    if (patch.reasonNote !== undefined) {
      rec.reasonNote = String(patch.reasonNote || '').slice(0, REASON_NOTE_MAX);
    }
    save();
    return rec;
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
      /* 評価は後から付ける。押した瞬間に入力を求めると試合が止まる */
      exec: 'unrated',
      reasons: [],
      reasonNote: '',
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
    /* 遂行度ごとの内訳。「作戦通りに動けたラウンドだけの勝率」と
       「崩れたラウンドの勝率」を分けて見るための土台 */
    const byExec = { clean: { win: 0, loss: 0 }, partial: { win: 0, loss: 0 },
                     failed: { win: 0, loss: 0 }, unrated: { win: 0, loss: 0 } };
    for (let i = 0; i < state.rounds.length; i++) {
      const r = state.rounds[i];
      if (r.tacticId !== tacticId) continue;
      if (r.result === 'WIN') win++; else loss++;
      const bucket = byExec[normalizeExec(r.exec)];
      if (r.result === 'WIN') bucket.win++; else bucket.loss++;
      lastUsedRound = r.n;
    }
    // 直近の連続使用回数
    for (let i = state.rounds.length - 1; i >= 0; i--) {
      if (state.rounds[i].tacticId === tacticId) streak++; else break;
    }
    const used = win + loss;
    const rate = function (b) {
      const n = b.win + b.loss;
      return n ? Math.round((b.win / n) * 100) : null;
    };
    /* 一部崩れた・実行できなかったをまとめて「崩れた」として見る */
    const broken = { win: byExec.partial.win + byExec.failed.win,
                     loss: byExec.partial.loss + byExec.failed.loss };
    return {
      win: win,
      loss: loss,
      used: used,
      winRate: used ? Math.round((win / used) * 100) : null,
      streak: streak,
      lastUsedRound: lastUsedRound,
      roundsSinceUse: lastUsedRound ? state.rounds.length - lastUsedRound + 1 : null,
      byExec: byExec,
      cleanUsed: byExec.clean.win + byExec.clean.loss,
      cleanWinRate: rate(byExec.clean),
      brokenUsed: broken.win + broken.loss,
      brokenWinRate: rate(broken),
      ratedUsed: used - (byExec.unrated.win + byExec.unrated.loss)
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
    importObject(JSON.parse(text));
  }

  /* クラウドから受け取るのはパース済みのオブジェクトなので、
     文字列を経由せずに取り込めるようにしておく */
  function importObject(parsed) {
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
    tacticLimit: tacticLimit,
    tacticLimitReached: tacticLimitReached,
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
    setRoundEval: setRoundEval,
    EXEC_LEVELS: EXEC_LEVELS,
    REASON_KEYS: REASON_KEYS,
    REASON_NOTE_MAX: REASON_NOTE_MAX,
    undoLastRound: undoLastRound,
    lastRound: lastRound,
    statsFor: statsFor,
    resetMatch: resetMatch,
    resetAll: resetAll,
    exportJSON: exportJSON,
    importJSON: importJSON,
    importObject: importObject,
    saveComp: saveComp,
    removeComp: removeComp,
    applyComp: applyComp,
    MAX_COMPS: MAX_COMPS,
    seedSamples: function () {
      const I = global.VCT_I18N;
      D.SAMPLE_TACTICS.forEach(function (t) {
        if (tacticLimitReached()) return;
        addTactic({
          name: I.t('sample.' + t.key + '.name'),
          note: I.t('sample.' + t.key + '.note'),
          side: t.side,
          site: t.site,
          kind: t.kind
        });
      });
    }
  };
})(window);

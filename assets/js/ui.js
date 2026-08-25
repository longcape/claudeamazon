/* =========================================================
   UI RENDERING
   状態 → DOM の描画のみを担当（イベント登録は app.js 側）
   ========================================================= */
(function (global) {
  'use strict';

  const D = global.VCT_DATA;
  const S = global.VCT_STORE;
  const A = global.VCT_ADVISOR;

  const $ = function (id) { return document.getElementById(id); };

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* エージェントの六角アバター */
  function avatarHTML(agentId, extraClass) {
    const agent = D.agentById(agentId);
    if (!agent) {
      return '<span class="avatar is-empty ' + (extraClass || '') + '">?</span>';
    }
    const role = D.ROLES[agent.role];
    const style = 'background:linear-gradient(150deg,' + role.color + ',' + shade(role.color, -34) + ');' +
                  'box-shadow:0 0 16px ' + hexA(role.color, .35) + ';';
    return '<span class="avatar ' + (extraClass || '') + '" style="' + style + '">' + esc(agent.abbr) + '</span>';
  }

  function hexA(hex, alpha) {
    const c = hex.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function shade(hex, amount) {
    const c = hex.replace('#', '');
    let r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
    r = Math.max(0, Math.min(255, r + amount));
    g = Math.max(0, Math.min(255, g + amount));
    b = Math.max(0, Math.min(255, b + amount));
    return '#' + [r, g, b].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
  }

  function sideBadge(side) {
    if (side === 'ATK') return '<span class="badge badge-atk">ATK</span>';
    if (side === 'DEF') return '<span class="badge badge-def">DEF</span>';
    return '<span class="badge badge-both">BOTH</span>';
  }

  /* ================= SETUP: マップ / サイド ================= */
  function renderMapSelect() {
    const wrap = $('map-select');
    wrap.innerHTML = D.MAPS.map(function (m) {
      return '<button type="button" class="map-opt' + (m.id === S.state.match.map ? ' is-active' : '') +
             '" data-map="' + m.id + '">' + esc(m.name) + '</button>';
    }).join('');
  }

  function renderSideToggle() {
    const btns = $('side-toggle').querySelectorAll('.side-btn');
    btns.forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.side === S.state.match.startSide);
    });
  }

  function renderMatchFields() {
    $('inp-ally-team').value = S.state.match.allyTeam;
    $('inp-enemy-team').value = S.state.match.enemyTeam;
    $('inp-match-note').value = S.state.match.note || '';
    $('roster-ally-name').textContent = S.state.match.allyTeam || 'OUR TEAM';
    $('roster-enemy-name').textContent = S.state.match.enemyTeam || 'OPPONENT';
  }

  /* ================= SETUP: ロスター ================= */
  function renderRoster() {
    [['ally', 'slots-ally'], ['enemy', 'slots-enemy']].forEach(function (pair) {
      const team = pair[0];
      const list = S.state[team === 'ally' ? 'allies' : 'enemies'];
      $(pair[1]).innerHTML = list.map(function (slot, i) {
        const agent = D.agentById(slot.agent);
        const role = agent ? D.ROLES[agent.role] : null;
        return '' +
          '<li>' +
            '<button type="button" class="slot' + (agent ? '' : ' is-empty') + '" data-team="' + team + '" data-index="' + i + '">' +
              avatarHTML(slot.agent) +
              '<span class="slot-meta">' +
                '<span class="slot-agent">' + (agent ? esc(agent.name) : 'EMPTY SLOT') + '</span>' +
                '<span class="slot-role">' + (role ? esc(role.label) : 'クリックして選択') + '</span>' +
              '</span>' +
              (slot.player ? '<span class="slot-player">' + esc(slot.player) + '</span>' : '') +
            '</button>' +
          '</li>';
      }).join('');
    });
  }

  /* ================= SETUP: 戦術デッキ ================= */
  function renderDeck(filter) {
    const grid = $('deck-grid');
    const all = S.state.tactics;
    const list = all.filter(function (t) {
      if (filter === 'ATK') return t.side === 'ATK' || t.side === 'BOTH';
      if (filter === 'DEF') return t.side === 'DEF' || t.side === 'BOTH';
      return true;
    });

    $('deck-empty').hidden = all.length > 0;
    grid.innerHTML = list.map(function (t) {
      const st = S.statsFor(t.id);
      const kind = D.kindById(t.kind);
      return '' +
        '<article class="tcard" data-side="' + t.side + '" data-id="' + t.id + '" tabindex="0">' +
          '<div class="tcard-top">' +
            '<span class="tcard-site">' + esc(t.site || '-') + '</span>' +
            '<span class="tcard-kind">' + esc(kind.label) + '</span>' +
            '<span class="tcard-sidetag">' + esc(t.side) + '</span>' +
          '</div>' +
          '<h3 class="tcard-name">' + esc(t.name) + '</h3>' +
          (t.note ? '<p class="tcard-note">' + esc(t.note) + '</p>' : '') +
          '<div class="tcard-stat">' +
            (st.used
              ? '<span>' + st.win + 'W ' + st.loss + 'L</span><span>/</span><span>' + st.winRate + '%</span>'
              : '<span>未使用</span>') +
            '<span style="margin-left:auto">編集 →</span>' +
          '</div>' +
        '</article>';
    }).join('');
  }

  /* ================= SETUP: 開始条件 ================= */
  function renderReady() {
    const allyCount = S.state.allies.filter(function (s) { return s.agent; }).length;
    const enemyCount = S.state.enemies.filter(function (s) { return s.agent; }).length;
    const tacticCount = S.state.tactics.length;

    const items = [
      { label: 'ALLY AGENTS ' + allyCount + '/5', ok: allyCount === 5 },
      { label: 'ENEMY AGENTS ' + enemyCount + '/5', ok: enemyCount === 5 },
      { label: 'TACTICS ' + tacticCount, ok: tacticCount > 0 }
    ];

    $('ready-list').innerHTML = items.map(function (it) {
      return '<span class="ready-item ' + (it.ok ? 'is-ok' : 'is-ng') + '">' +
               '<span class="mark">' + (it.ok ? '✓' : '!') + '</span>' + esc(it.label) +
             '</span>';
    }).join('');

    const ready = items.every(function (it) { return it.ok; });
    $('btn-start').disabled = !ready;
    $('btn-start').querySelector('em').textContent = ready
      ? 'ラウンド ' + S.currentRoundNumber() + ' へ'
      : '5体ずつのエージェントと戦術が必要です';
    return ready;
  }

  /* ================= LIVE: スコアボード ================= */
  function renderScorebar() {
    const n = S.currentRoundNumber();
    const side = S.sideForRound(n);
    const sc = S.score();
    const map = D.mapById(S.state.match.map);

    $('score-ally-name').textContent = S.state.match.allyTeam || 'OUR TEAM';
    $('score-enemy-name').textContent = S.state.match.enemyTeam || 'OPPONENT';
    $('score-ally').textContent = sc.ally;
    $('score-enemy').textContent = sc.enemy;
    $('score-round').textContent = 'ROUND ' + n + (n > 24 ? ' (OT)' : '');
    $('score-map').textContent = map ? map.name : '-';

    const allySideEl = $('score-ally-side');
    const enemySideEl = $('score-enemy-side');
    allySideEl.textContent = D.SIDES[side].label;
    allySideEl.dataset.side = side;
    const opp = side === 'ATK' ? 'DEF' : 'ATK';
    enemySideEl.textContent = D.SIDES[opp].label;
    enemySideEl.dataset.side = opp;

    /* マッチ決着 / マッチポイントのバナー */
    const banner = $('match-banner');
    const result = S.matchResult();
    if (result) {
      banner.hidden = false;
      banner.className = 'match-banner ' + (result === 'WIN' ? 'win' : 'loss');
      banner.textContent = result === 'WIN'
        ? '★ MATCH WON — ' + sc.ally + ' - ' + sc.enemy
        : 'MATCH LOST — ' + sc.ally + ' - ' + sc.enemy;
    } else if (sc.ally >= 12 || sc.enemy >= 12) {
      banner.hidden = false;
      banner.className = 'match-banner point';
      banner.textContent = sc.ally >= 12 && sc.enemy >= 12
        ? 'OVERTIME / 2ラウンド差で決着'
        : (sc.ally >= 12 ? 'MATCH POINT — 自チーム' : 'MATCH POINT — 相手チーム');
    } else {
      banner.hidden = true;
    }
  }

  /* ================= LIVE: 両チームロスター ================= */
  function renderBoardRosters() {
    [['board-ally', S.state.allies], ['board-enemy', S.state.enemies]].forEach(function (pair) {
      $(pair[0]).innerHTML = pair[1].map(function (slot) {
        const agent = D.agentById(slot.agent);
        const role = agent ? D.ROLES[agent.role] : null;
        return '' +
          '<li class="broster-item">' +
            avatarHTML(slot.agent) +
            '<span class="slot-meta">' +
              '<span class="slot-agent">' + (agent ? esc(agent.name) : '—') + '</span>' +
              '<span class="slot-role">' + (slot.player ? esc(slot.player) : (role ? esc(role.label) : '')) + '</span>' +
            '</span>' +
          '</li>';
      }).join('');
    });
  }

  /* ================= LIVE: ステージ ================= */
  function renderStage(uiState) {
    const stage = $('stage');
    const n = S.currentRoundNumber();
    const side = S.sideForRound(n);

    if (S.state.pending) {
      stage.innerHTML = liveCardHTML(n, side);
    } else {
      stage.innerHTML = pickHTML(n, side, uiState);
    }
  }

  function liveCardHTML(n, side) {
    const t = S.tacticById(S.state.pending.tacticId);
    if (!t) { S.clearPending(); return ''; }
    const st = S.statsFor(t.id);
    const kind = D.kindById(t.kind);
    const eco = D.ECONOMY.find(function (e) { return e.id === S.state.pending.economy; });

    return '' +
      '<div class="stage-head">' +
        '<h3>ROUND ' + n + ' — 実行中</h3>' +
        '<div class="stage-actions">' +
          '<button class="btn btn-ghost btn-sm" data-act="change">戦術を選び直す</button>' +
          '<button class="btn btn-ghost btn-sm" data-act="flip-side">サイド反転</button>' +
        '</div>' +
        '<p>コールを共有したら、ラウンド終了後に下の WIN / LOSS を押してください。</p>' +
      '</div>' +
      '<div class="live-card" data-side="' + side + '">' +
        '<span class="lc-bar"></span>' +
        '<div class="lc-top">' +
          '<span class="lc-site">' + esc(t.site || '-') + '</span>' +
          '<span class="lc-label">' + D.SIDES[side].label + ' / ' + esc(kind.label) + '</span>' +
        '</div>' +
        '<h2 class="lc-name">' + esc(t.name) + '</h2>' +
        (t.note ? '<p class="lc-note">' + esc(t.note) + '</p>' : '') +
        '<div class="lc-meta">' +
          '<span class="meta-pill">' + esc(kind.jp) + '</span>' +
          '<span class="meta-pill">' + (eco ? esc(eco.label) : 'FULL BUY') + '</span>' +
          '<span class="meta-pill">' + (st.used ? st.win + 'W ' + st.loss + 'L / ' + st.winRate + '%' : '初使用') + '</span>' +
          (st.streak >= 2 ? '<span class="meta-pill" style="color:#F5A623;border-color:rgba(245,166,35,.4)">' + st.streak + '連投</span>' : '') +
        '</div>' +
        '<div class="lc-actions">' +
          '<button class="res-btn res-win" data-act="result" data-result="WIN">WIN<small>ラウンド取得</small></button>' +
          '<button class="res-btn res-loss" data-act="result" data-result="LOSS">LOSS<small>ラウンド失陥</small></button>' +
        '</div>' +
      '</div>';
  }

  function pickHTML(n, side, uiState) {
    const head = A.headline();
    const includeOffSide = !!(uiState && uiState.includeOffSide);
    const ranked = A.rank({ side: side, includeOffSide: includeOffSide });
    const eco = (uiState && uiState.economy) || 'full';

    const ecoSeg = D.ECONOMY.map(function (e) {
      return '<button type="button" data-act="eco" data-eco="' + e.id + '"' +
             (e.id === eco ? ' class="is-active"' : '') + '>' + esc(e.label) + '</button>';
    }).join('');

    const body = ranked.length
      ? '<div class="pick-list">' + ranked.map(function (r, i) {
          const st = r.stats;
          return '' +
            '<button type="button" class="pick' + (i === 0 ? ' is-top' : '') + '" data-act="pick" data-id="' + r.tactic.id + '">' +
              '<span class="pick-score ' + r.tone + '"><b>' + r.score + '</b><small>SCORE</small></span>' +
              '<span class="pick-main">' +
                '<span class="pick-name">' + esc(r.tactic.name) +
                  sideBadge(r.tactic.side) +
                  '<span class="badge badge-site">' + esc(r.tactic.site || '-') + '</span>' +
                '</span>' +
                (r.reasons.length
                  ? '<span class="pick-reasons">' + r.reasons.map(function (rs) {
                      return '<span class="reason ' + rs.tone + '">' + esc(rs.text) + '</span>';
                    }).join('') + '</span>'
                  : '') +
              '</span>' +
              '<span class="pick-record">' +
                (st.used ? '<b>' + st.winRate + '%</b><br>' + st.win + 'W ' + st.loss + 'L' : '<b>—</b><br>未使用') +
              '</span>' +
            '</button>';
        }).join('') + '</div>'
      : '<p class="deck-empty">このサイドで使える戦術がありません。<b>「他サイドも表示」</b>を有効にするか、戦術を追加してください。</p>';

    return '' +
      '<div class="stage-head">' +
        '<h3>ROUND ' + n + ' — 戦術を選択 <span class="result-pill ' +
          (S.lastRound() ? (S.lastRound().result === 'WIN' ? 'win">前R WIN' : 'loss">前R LOSS') : '">START') +
        '</span></h3>' +
        '<div class="stage-actions">' +
          '<button class="btn btn-ghost btn-sm" data-act="toggle-offside">' + (includeOffSide ? '✓ ' : '') + '他サイドも表示</button>' +
          '<button class="btn btn-ghost btn-sm" data-act="flip-side">サイド反転</button>' +
          '<button class="btn btn-primary btn-sm" data-act="new-tactic">+ 戦術</button>' +
        '</div>' +
        '<p><b>' + esc(head.title) + '</b> — ' + esc(head.text) + '</p>' +
      '</div>' +
      '<div class="stage-head pick-tools">' +
        '<span class="lc-label">ECONOMY</span>' +
        '<span class="eco-seg">' + ecoSeg + '</span>' +
      '</div>' +
      body;
  }

  /* ================= LIVE: タイムライン ================= */
  function renderTimeline() {
    const rounds = S.state.rounds;
    $('timeline-empty').hidden = rounds.length > 0;
    $('timeline').innerHTML = rounds.slice().reverse().map(function (r) {
      const t = S.tacticById(r.tacticId);
      return '' +
        '<li class="tl-row ' + r.result.toLowerCase() + '">' +
          '<span class="tl-round">R' + r.n + '</span>' +
          '<span class="tl-side" data-side="' + r.side + '">' + r.side + '</span>' +
          '<span class="tl-name">' + esc(t ? t.name : '(削除された戦術)') + '</span>' +
          '<span class="tl-res">' + r.result + '</span>' +
        '</li>';
    }).join('');
  }

  /* ================= LIVE: 戦術成績 ================= */
  function renderPerf() {
    const list = S.state.tactics
      .map(function (t) { return { t: t, st: S.statsFor(t.id) }; })
      .sort(function (a, b) {
        if (b.st.used !== a.st.used) return b.st.used - a.st.used;
        return (b.st.winRate || 0) - (a.st.winRate || 0);
      });

    $('perf-list').innerHTML = list.map(function (row) {
      const rate = row.st.winRate;
      const cls = rate === null ? '' : (rate >= 60 ? '' : (rate >= 40 ? 'mid' : 'low'));
      const color = rate === null ? 'var(--text-mute)' : (rate >= 60 ? 'var(--teal)' : (rate >= 40 ? 'var(--gold)' : 'var(--red)'));
      return '' +
        '<li class="perf-item">' +
          '<span class="perf-top">' +
            '<span class="perf-name">' + esc(row.t.name) + '</span>' +
            '<span class="perf-rate" style="color:' + color + '">' + (rate === null ? '—' : rate + '%') + '</span>' +
            '<span class="perf-count">' + row.st.win + 'W ' + row.st.loss + 'L</span>' +
          '</span>' +
          '<span class="perf-bar ' + cls + '"><span style="width:' + (rate === null ? 0 : rate) + '%"></span></span>' +
        '</li>';
    }).join('');
  }

  /* ================= MODAL: エージェント ================= */
  function renderRoleFilter(active) {
    $('role-filter').innerHTML =
      '<button type="button" class="role-chip' + (active === 'all' ? ' is-active' : '') + '" data-role="all">ALL</button>' +
      Object.keys(D.ROLES).map(function (k) {
        const r = D.ROLES[k];
        return '<button type="button" class="role-chip' + (active === k ? ' is-active' : '') +
               '" data-role="' + k + '" style="color:' + (active === k ? r.color : '') + '">' + esc(r.label) + '</button>';
      }).join('');
  }

  function renderAgentGrid(opts) {
    const query = (opts.query || '').trim().toLowerCase();
    const role = opts.role || 'all';
    const current = opts.current || '';
    const list = D.AGENTS.filter(function (a) {
      if (role !== 'all' && a.role !== role) return false;
      if (!query) return true;
      return a.name.toLowerCase().indexOf(query) >= 0 || a.jp.indexOf(opts.query.trim()) >= 0;
    });

    $('agent-grid').innerHTML = list.length
      ? list.map(function (a) {
          const r = D.ROLES[a.role];
          return '' +
            '<button type="button" class="agent-opt' + (a.id === current ? ' is-active' : '') + '" data-agent="' + a.id + '">' +
              avatarHTML(a.id) +
              '<b>' + esc(a.name) + '</b>' +
              '<small style="color:' + r.color + '">' + esc(r.label) + '</small>' +
            '</button>';
        }).join('')
      : '<p class="deck-empty" style="grid-column:1/-1">該当するエージェントがいません。</p>';
  }

  /* ================= MODAL: 戦術フォーム ================= */
  function renderKindSelect(value) {
    $('t-kind').innerHTML = D.KINDS.map(function (k) {
      return '<option value="' + k.id + '"' + (k.id === value ? ' selected' : '') + '>' +
             esc(k.label) + ' — ' + esc(k.jp) + '</option>';
    }).join('');
  }

  function renderSiteSeg(value) {
    const map = D.mapById(S.state.match.map);
    const sites = (map ? map.sites : ['A', 'B']).concat(['MID', '-']);
    $('t-site').innerHTML = sites.map(function (s) {
      return '<button type="button" data-val="' + esc(s) + '"' +
             (s === value ? ' class="is-active"' : '') + '>' + esc(s) + '</button>';
    }).join('');
  }

  function setSegActive(container, value) {
    container.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.val === value);
    });
  }

  function segValue(container) {
    const active = container.querySelector('button.is-active');
    return active ? active.dataset.val : null;
  }

  /* ================= TOAST ================= */
  let toastTimer = null;
  function toast(message, kind) {
    const el = $('toast');
    el.textContent = message;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  global.VCT_UI = {
    $: $, esc: esc, avatarHTML: avatarHTML,
    renderMapSelect: renderMapSelect,
    renderSideToggle: renderSideToggle,
    renderMatchFields: renderMatchFields,
    renderRoster: renderRoster,
    renderDeck: renderDeck,
    renderReady: renderReady,
    renderScorebar: renderScorebar,
    renderBoardRosters: renderBoardRosters,
    renderStage: renderStage,
    renderTimeline: renderTimeline,
    renderPerf: renderPerf,
    renderRoleFilter: renderRoleFilter,
    renderAgentGrid: renderAgentGrid,
    renderKindSelect: renderKindSelect,
    renderSiteSeg: renderSiteSeg,
    setSegActive: setSegActive,
    segValue: segValue,
    toast: toast
  };
})(window);

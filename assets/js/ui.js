/* =========================================================
   UI RENDERING
   状態 → DOM の描画のみを担当（イベント登録は app.js 側）
   表示文字列はすべて i18n 経由で解決する。
   ========================================================= */
(function (global) {
  'use strict';

  const D = global.VCT_DATA;
  const S = global.VCT_STORE;
  const A = global.VCT_ADVISOR;
  const I = global.VCT_I18N;
  const CFG = global.VCT_CONFIG;

  const $ = function (id) { return document.getElementById(id); };
  const t = function (key, params) { return I.t(key, params); };

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ================= 共通パーツ ================= */
  function avatarHTML(agentId, extraClass) {
    const agent = D.agentById(agentId);
    if (!agent) return '<span class="avatar is-empty ' + (extraClass || '') + '">?</span>';
    const role = D.ROLES[agent.role];
    const style = 'background:linear-gradient(150deg,' + role.color + ',' + shade(role.color, -34) + ');' +
                  'box-shadow:0 0 16px ' + hexA(role.color, .35) + ';';
    return '<span class="avatar ' + (extraClass || '') + '" style="' + style + '">' + esc(agent.abbr) + '</span>';
  }

  function hexA(hex, alpha) {
    const c = hex.replace('#', '');
    return 'rgba(' + parseInt(c.slice(0, 2), 16) + ',' + parseInt(c.slice(2, 4), 16) + ',' +
           parseInt(c.slice(4, 6), 16) + ',' + alpha + ')';
  }

  function shade(hex, amount) {
    const c = hex.replace('#', '');
    const parts = [c.slice(0, 2), c.slice(2, 4), c.slice(4, 6)].map(function (h) {
      return Math.max(0, Math.min(255, parseInt(h, 16) + amount)).toString(16).padStart(2, '0');
    });
    return '#' + parts.join('');
  }

  function sideBadge(side) {
    if (side === 'ATK') return '<span class="badge badge-atk">ATK</span>';
    if (side === 'DEF') return '<span class="badge badge-def">DEF</span>';
    return '<span class="badge badge-both">BOTH</span>';
  }

  function reasonText(r) {
    return r.key ? t(r.key, r.params) : (r.text || '');
  }

  /* ================= 言語切り替え ================= */
  function renderLangPicker() {
    const sel = $('lang-select');
    const current = I.get();
    sel.innerHTML = I.languages().map(function (l) {
      return '<option value="' + l.code + '"' + (l.code === current ? ' selected' : '') + '>' +
             l.flag + '  ' + esc(l.name) + '</option>';
    }).join('');
  }

  /* ================= SETUP ================= */
  function renderMapSelect() {
    $('map-select').innerHTML = D.MAPS.map(function (m) {
      return '<button type="button" class="map-opt' + (m.id === S.state.match.map ? ' is-active' : '') +
             '" data-map="' + m.id + '">' + esc(m.name) + '</button>';
    }).join('');
  }

  function renderSideToggle() {
    $('side-toggle').querySelectorAll('.side-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.side === S.state.match.startSide);
    });
  }

  function renderMatchFields() {
    $('inp-ally-team').value = S.state.match.allyTeam;
    $('inp-enemy-team').value = S.state.match.enemyTeam;
    $('inp-match-note').value = S.state.match.note || '';
    $('roster-ally-name').textContent = S.state.match.allyTeam || t('team.ally.default');
    $('roster-enemy-name').textContent = S.state.match.enemyTeam || t('team.enemy.default');
  }

  function renderRoster() {
    [['ally', 'slots-ally'], ['enemy', 'slots-enemy']].forEach(function (pair) {
      const team = pair[0];
      const list = S.state[team === 'ally' ? 'allies' : 'enemies'];
      $(pair[1]).innerHTML = list.map(function (slot, i) {
        const agent = D.agentById(slot.agent);
        return '' +
          '<li>' +
            '<button type="button" class="slot' + (agent ? '' : ' is-empty') + '" data-team="' + team + '" data-index="' + i + '">' +
              avatarHTML(slot.agent) +
              '<span class="slot-meta">' +
                '<span class="slot-agent">' + (agent ? esc(agent.name) : t('roster.empty')) + '</span>' +
                '<span class="slot-role">' + (agent ? t('role.' + agent.role) : t('roster.clickToSelect')) + '</span>' +
              '</span>' +
              (slot.player ? '<span class="slot-player">' + esc(slot.player) + '</span>' : '') +
            '</button>' +
          '</li>';
      }).join('');
    });
  }

  function renderDeck(filter) {
    const all = S.state.tactics;
    const list = all.filter(function (tac) {
      if (filter === 'ATK') return tac.side === 'ATK' || tac.side === 'BOTH';
      if (filter === 'DEF') return tac.side === 'DEF' || tac.side === 'BOTH';
      return true;
    });

    $('deck-empty').hidden = all.length > 0;
    $('deck-grid').innerHTML = list.map(function (tac) {
      const st = S.statsFor(tac.id);
      const kind = D.kindById(tac.kind);
      return '' +
        '<article class="tcard" data-side="' + tac.side + '" data-id="' + tac.id + '" tabindex="0">' +
          '<div class="tcard-top">' +
            '<span class="tcard-site">' + esc(tac.site || '-') + '</span>' +
            '<span class="tcard-kind">' + esc(kind.label) + '</span>' +
            '<span class="tcard-sidetag">' + esc(tac.side) + '</span>' +
          '</div>' +
          '<h3 class="tcard-name">' + esc(tac.name) + '</h3>' +
          (tac.note ? '<p class="tcard-note">' + esc(tac.note) + '</p>' : '') +
          '<div class="tcard-stat">' +
            (st.used
              ? '<span>' + st.win + 'W ' + st.loss + 'L</span><span>/</span><span>' + st.winRate + '%</span>'
              : '<span>' + t('common.unused') + '</span>') +
            '<span style="margin-left:auto">' + t('deck.edit') + '</span>' +
          '</div>' +
        '</article>';
    }).join('');
  }

  function renderReady() {
    const allyCount = S.state.allies.filter(function (s) { return s.agent; }).length;
    const enemyCount = S.state.enemies.filter(function (s) { return s.agent; }).length;
    const tacticCount = S.state.tactics.length;

    const items = [
      { label: t('ready.ally', { n: allyCount }), ok: allyCount === 5 },
      { label: t('ready.enemy', { n: enemyCount }), ok: enemyCount === 5 },
      { label: t('ready.tactics', { n: tacticCount }), ok: tacticCount > 0 }
    ];

    $('ready-list').innerHTML = items.map(function (it) {
      return '<span class="ready-item ' + (it.ok ? 'is-ok' : 'is-ng') + '">' +
               '<span class="mark">' + (it.ok ? '✓' : '!') + '</span>' + esc(it.label) +
             '</span>';
    }).join('');

    const ready = items.every(function (it) { return it.ok; });
    $('btn-start').disabled = !ready;
    $('btn-start').querySelector('em').textContent = ready
      ? t('btn.start.ready', { n: S.currentRoundNumber() })
      : t('btn.start.notReady');
    return ready;
  }

  /* ================= LIVE ================= */
  function renderScorebar() {
    const n = S.currentRoundNumber();
    const side = S.sideForRound(n);
    const sc = S.score();
    const map = D.mapById(S.state.match.map);

    $('score-ally-name').textContent = S.state.match.allyTeam || t('team.ally.default');
    $('score-enemy-name').textContent = S.state.match.enemyTeam || t('team.enemy.default');
    $('score-ally').textContent = sc.ally;
    $('score-enemy').textContent = sc.enemy;
    $('score-round').textContent = t('live.round', { n: n }) + (n > 24 ? ' ' + t('live.ot') : '');
    $('score-map').textContent = map ? map.name : '-';

    const opp = side === 'ATK' ? 'DEF' : 'ATK';
    const allySideEl = $('score-ally-side');
    const enemySideEl = $('score-enemy-side');
    allySideEl.textContent = t(side === 'ATK' ? 'side.attack' : 'side.defense');
    allySideEl.dataset.side = side;
    enemySideEl.textContent = t(opp === 'ATK' ? 'side.attack' : 'side.defense');
    enemySideEl.dataset.side = opp;

    const banner = $('match-banner');
    const result = S.matchResult();
    if (result) {
      banner.hidden = false;
      banner.className = 'match-banner ' + (result === 'WIN' ? 'win' : 'loss');
      banner.textContent = t(result === 'WIN' ? 'banner.won' : 'banner.lost', { a: sc.ally, b: sc.enemy });
    } else if (sc.ally >= 12 || sc.enemy >= 12) {
      banner.hidden = false;
      banner.className = 'match-banner point';
      banner.textContent = (sc.ally >= 12 && sc.enemy >= 12)
        ? t('banner.overtime')
        : t(sc.ally >= 12 ? 'banner.pointAlly' : 'banner.pointEnemy');
    } else {
      banner.hidden = true;
    }
  }

  function renderBoardRosters() {
    [['board-ally', S.state.allies], ['board-enemy', S.state.enemies]].forEach(function (pair) {
      $(pair[0]).innerHTML = pair[1].map(function (slot) {
        const agent = D.agentById(slot.agent);
        return '' +
          '<li class="broster-item">' +
            avatarHTML(slot.agent) +
            '<span class="slot-meta">' +
              '<span class="slot-agent">' + (agent ? esc(agent.name) : '—') + '</span>' +
              '<span class="slot-role">' + (slot.player ? esc(slot.player) : (agent ? t('role.' + agent.role) : '')) + '</span>' +
            '</span>' +
          '</li>';
      }).join('');
    });
  }

  function renderStage(uiState) {
    const n = S.currentRoundNumber();
    const side = S.sideForRound(n);
    $('stage').innerHTML = S.state.pending ? liveCardHTML(n, side, uiState) : pickHTML(n, side, uiState);
  }

  function liveCardHTML(n, side, uiState) {
    const tac = S.tacticById(S.state.pending.tacticId);
    if (!tac) { S.clearPending(); return ''; }
    const st = S.statsFor(tac.id);
    const kind = D.kindById(tac.kind);
    const eco = D.ECONOMY.find(function (e) { return e.id === S.state.pending.economy; });

    return '' +
      '<div class="stage-head">' +
        '<h3>' + t('live.executing', { n: n }) + '</h3>' +
        '<div class="stage-actions">' +
          '<button class="btn btn-ghost btn-sm" data-act="change">' + t('stage.change') + '</button>' +
          '<button class="btn btn-ghost btn-sm" data-act="flip-side">' + t('stage.flipSide') + '</button>' +
        '</div>' +
        '<p>' + t('live.hint') + '</p>' +
      '</div>' +
      '<div class="live-card" data-side="' + side + '">' +
        '<span class="lc-bar"></span>' +
        '<div class="lc-top">' +
          '<span class="lc-site">' + esc(tac.site || '-') + '</span>' +
          '<span class="lc-label">' + t(side === 'ATK' ? 'side.attack' : 'side.defense') + ' / ' + esc(kind.label) + '</span>' +
        '</div>' +
        '<h2 class="lc-name">' + esc(tac.name) + '</h2>' +
        (tac.note ? '<p class="lc-note">' + esc(tac.note) + '</p>' : '') +
        '<div class="lc-meta">' +
          '<span class="meta-pill">' + t('kind.' + tac.kind) + '</span>' +
          '<span class="meta-pill">' + t('eco.' + (eco ? eco.id : 'full')) + '</span>' +
          '<span class="meta-pill">' + (st.used ? st.win + 'W ' + st.loss + 'L / ' + st.winRate + '%' : t('meta.firstUse')) + '</span>' +
          (st.streak >= 2 ? '<span class="meta-pill is-warn">' + t('meta.streak', { n: st.streak }) + '</span>' : '') +
        '</div>' +
        '<div class="lc-actions">' +
          '<button class="res-btn res-win" data-act="result" data-result="WIN">' + t('res.win') +
            '<small>' + t('res.win.sub') + '</small></button>' +
          '<button class="res-btn res-loss" data-act="result" data-result="LOSS">' + t('res.loss') +
            '<small>' + t('res.loss.sub') + '</small></button>' +
        '</div>' +
        shareBarHTML() +
      '</div>' +
      analysisHTML(uiState);
  }

  function shareBarHTML() {
    return '' +
      '<div class="share-bar">' +
        '<span class="lc-label">' + t('share.title') + '</span>' +
        '<button class="btn btn-ghost btn-sm btn-x" data-act="share-x">' + t('share.x') + '</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="share-copy">' + t('share.copy') + '</button>' +
        (global.VCT_COMMUNITY.enabled()
          ? '<button class="btn btn-ghost btn-sm" data-act="share-post">' + t('community.post') + '</button>'
          : '') +
      '</div>';
  }

  /* --- 相性判定パネル --- */
  function analysisHTML(uiState) {
    const result = uiState && uiState.analysis;
    const running = uiState && uiState.aiRunning;
    const ai = uiState && uiState.aiReview;

    let body;
    if (!result) {
      body = '<div class="panel-body">' +
               '<button class="btn btn-primary btn-sm" data-act="analyze">' + t('analyst.run') + '</button>' +
             '</div>';
    } else if (!result.ready) {
      body = '<div class="panel-body"><p class="deck-empty">' + t('analyst.needComp') + '</p></div>';
    } else {
      body = '<div class="panel-body">' +
               '<div class="verdict-row">' +
                 '<span class="verdict verdict-' + result.verdict + '">' + t('analyst.' + result.verdict) + '</span>' +
                 '<span class="verdict-score">' + result.score + '<small>/100</small></span>' +
                 '<div class="verdict-bar"><span style="width:' + result.score + '%"></span></div>' +
               '</div>' +
               findingListHTML(result.strengths, 'analyst.strengths', 'good') +
               findingListHTML(result.weaknesses, 'analyst.weaknesses', 'bad') +
               (result.findings.length === 0
                 ? '<p class="deck-empty">' + t('analyst.noFindings') + '</p>' : '') +
               aiBlockHTML(running, ai) +
             '</div>';
    }

    return '<article class="panel panel-clip analysis-panel">' +
             '<header class="panel-head">' +
               '<h2><span class="idx">AI</span>' + t('analyst.title') + '</h2>' +
               '<p class="panel-sub">' + t('analyst.sub') + '</p>' +
               (result ? '<div class="panel-head-actions">' +
                 '<button class="btn btn-ghost btn-sm" data-act="analyze">' + t('analyst.run') + '</button>' +
               '</div>' : '') +
             '</header>' + body +
           '</article>';
  }

  function findingListHTML(list, titleKey, tone) {
    if (!list.length) return '';
    return '<div class="finding-block">' +
             '<h4 class="finding-title finding-' + tone + '">' + t(titleKey) + '</h4>' +
             '<ul class="finding-list">' + list.map(function (f) {
               return '<li class="finding finding-' + f.tone + '">' +
                        '<span class="finding-cat">' + t('analyst.cat.' + f.cat) + '</span>' +
                        '<span>' + esc(t(f.key, f.params)) + '</span>' +
                      '</li>';
             }).join('') + '</ul>' +
           '</div>';
  }

  function aiBlockHTML(running, ai) {
    if (!CFG.AI_REVIEW_ENABLED || !global.VCT_COMMUNITY.enabled()) return '';
    if (running) {
      return '<div class="ai-block is-running"><span class="spinner"></span>' + t('analyst.aiRunning') + '</div>';
    }
    if (!ai) {
      return '<button class="btn btn-ghost btn-sm ai-trigger" data-act="ai-review">✦ ' + t('analyst.ai') + '</button>';
    }
    return '' +
      '<div class="ai-block">' +
        '<h4 class="finding-title">✦ ' + t('analyst.aiTitle') + '</h4>' +
        '<p class="ai-summary">' + esc(ai.summary || '') + '</p>' +
        aiListHTML(ai.strengths, 'good') +
        aiListHTML(ai.weaknesses, 'bad') +
        aiListHTML(ai.counterplay, 'warn') +
      '</div>';
  }

  function aiListHTML(list, tone) {
    if (!Array.isArray(list) || !list.length) return '';
    return '<ul class="finding-list">' + list.map(function (item) {
      return '<li class="finding finding-' + tone + '"><span>' + esc(String(item)) + '</span></li>';
    }).join('') + '</ul>';
  }

  /* --- 戦術選択 --- */
  function pickHTML(n, side, uiState) {
    const head = A.headline();
    const includeOffSide = !!(uiState && uiState.includeOffSide);
    const ranked = A.rank({ side: side, includeOffSide: includeOffSide });
    const eco = (uiState && uiState.economy) || 'full';
    const last = S.lastRound();

    const ecoSeg = D.ECONOMY.map(function (e) {
      return '<button type="button" data-act="eco" data-eco="' + e.id + '"' +
             (e.id === eco ? ' class="is-active"' : '') + '>' + t('eco.' + e.id) + '</button>';
    }).join('');

    const pill = last
      ? '<span class="result-pill ' + (last.result === 'WIN' ? 'win">' + t('stage.prevWin') : 'loss">' + t('stage.prevLoss')) + '</span>'
      : '<span class="result-pill">' + t('stage.start') + '</span>';

    const body = ranked.length
      ? '<div class="pick-list">' + ranked.map(function (r, i) {
          const st = r.stats;
          return '' +
            '<button type="button" class="pick' + (i === 0 ? ' is-top' : '') + '" data-act="pick" data-id="' + r.tactic.id + '">' +
              '<span class="pick-score ' + r.tone + '"><b>' + r.score + '</b><small>' + t('pick.score') + '</small></span>' +
              '<span class="pick-main">' +
                '<span class="pick-name">' + esc(r.tactic.name) + sideBadge(r.tactic.side) +
                  '<span class="badge badge-site">' + esc(r.tactic.site || '-') + '</span>' +
                '</span>' +
                (r.reasons.length
                  ? '<span class="pick-reasons">' + r.reasons.map(function (rs) {
                      return '<span class="reason ' + rs.tone + '">' + esc(reasonText(rs)) + '</span>';
                    }).join('') + '</span>'
                  : '') +
              '</span>' +
              '<span class="pick-record">' +
                (st.used ? '<b>' + st.winRate + '%</b><br>' + st.win + 'W ' + st.loss + 'L'
                         : '<b>—</b><br>' + t('common.unused')) +
              '</span>' +
            '</button>';
        }).join('') + '</div>'
      : '<p class="deck-empty">' + t('pick.noTactics') + '</p>';

    return '' +
      '<div class="stage-head">' +
        '<h3>' + t('live.selecting', { n: n }) + ' ' + pill + '</h3>' +
        '<div class="stage-actions">' +
          '<button class="btn btn-ghost btn-sm" data-act="toggle-offside">' + (includeOffSide ? '✓ ' : '') + t('stage.showOffside') + '</button>' +
          '<button class="btn btn-ghost btn-sm" data-act="flip-side">' + t('stage.flipSide') + '</button>' +
          '<button class="btn btn-primary btn-sm" data-act="new-tactic">' + t('stage.newTactic') + '</button>' +
        '</div>' +
        '<p><b>' + esc(t(head.titleKey, head.params)) + '</b> — ' + esc(t(head.textKey, head.params)) + '</p>' +
      '</div>' +
      '<div class="stage-head pick-tools">' +
        '<span class="lc-label">' + t('eco.label') + '</span>' +
        '<span class="eco-seg">' + ecoSeg + '</span>' +
      '</div>' +
      body;
  }

  /* --- タイムライン / 成績 --- */
  function renderTimeline() {
    const rounds = S.state.rounds;
    $('timeline-empty').hidden = rounds.length > 0;
    $('timeline').innerHTML = rounds.slice().reverse().map(function (r) {
      const tac = S.tacticById(r.tacticId);
      return '' +
        '<li class="tl-row ' + r.result.toLowerCase() + '">' +
          '<span class="tl-round">R' + r.n + '</span>' +
          '<span class="tl-side" data-side="' + r.side + '">' + r.side + '</span>' +
          '<span class="tl-name">' + esc(tac ? tac.name : t('timeline.deleted')) + '</span>' +
          '<span class="tl-res">' + t('res.' + r.result.toLowerCase()) + '</span>' +
        '</li>';
    }).join('');
  }

  function renderPerf() {
    const list = S.state.tactics
      .map(function (tac) { return { t: tac, st: S.statsFor(tac.id) }; })
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

  /* ================= COMMUNITY ================= */
  function renderAccount() {
    const C = global.VCT_COMMUNITY;
    const wrap = $('community-account');
    if (!wrap) return;
    const name = C.displayName();
    wrap.innerHTML = name
      ? '<span class="account-name">' + esc(name) + '</span>' +
        '<button class="btn btn-ghost btn-sm" data-act="logout">' + t('community.logout') + '</button>'
      : '<button class="btn btn-ghost btn-sm" data-act="login">' + t('community.login') + '</button>';
  }

  function renderCommunityMapFilter(value) {
    $('community-map').innerHTML =
      '<option value="">' + t('community.filterAll') + '</option>' +
      D.MAPS.map(function (m) {
        return '<option value="' + m.id + '"' + (m.id === value ? ' selected' : '') + '>' + esc(m.name) + '</option>';
      }).join('');
  }

  function renderPosts(posts, status) {
    const grid = $('post-grid');
    const empty = $('post-empty');

    if (status) {
      grid.innerHTML = '';
      empty.hidden = false;
      empty.textContent = status;
      return;
    }
    if (!posts.length) {
      grid.innerHTML = '';
      empty.hidden = false;
      empty.textContent = t('community.empty');
      return;
    }
    empty.hidden = true;

    grid.innerHTML = posts.map(function (p) {
      const map = D.mapById(p.map);
      return '' +
        '<article class="post-card" data-side="' + esc(p.side) + '" data-id="' + esc(p.id) + '">' +
          '<div class="tcard-top">' +
            '<span class="tcard-site">' + esc(p.site || '-') + '</span>' +
            '<span class="tcard-kind">' + esc(String(p.kind || '').toUpperCase()) + '</span>' +
            '<span class="tcard-sidetag">' + esc(map ? map.name : p.map) + '</span>' +
          '</div>' +
          '<h3 class="tcard-name">' + esc(p.name) + '</h3>' +
          (p.note ? '<p class="tcard-note">' + esc(p.note) + '</p>' : '') +
          compStripHTML(p.enemy_comp) +
          '<div class="post-foot">' +
            '<span class="post-author">@' + esc(p.author_name || 'ANONYMOUS') + '</span>' +
            (p.analysis_score !== null && p.analysis_score !== undefined
              ? '<span class="post-score">' + p.analysis_score + '/100</span>' : '') +
            '<button class="btn-like" data-act="like" data-id="' + esc(p.id) + '">♥ ' + (p.likes || 0) + '</button>' +
            '<button class="btn btn-ghost btn-sm" data-act="import-post" data-id="' + esc(p.id) + '">' + t('community.import') + '</button>' +
          '</div>' +
        '</article>';
    }).join('');
  }

  /** 想定されている相手構成をアイコンで並べる */
  function compStripHTML(comp) {
    if (!Array.isArray(comp) || !comp.length) return '';
    return '<div class="comp-strip">' +
             '<span class="comp-label">' + t('tag.enemy') + '</span>' +
             comp.map(function (id) { return avatarHTML(id, 'avatar-sm'); }).join('') +
           '</div>';
  }

  function renderPostForm(selectedId) {
    const sel = $('post-tactic');
    sel.innerHTML = S.state.tactics.map(function (tac) {
      return '<option value="' + tac.id + '"' + (tac.id === selectedId ? ' selected' : '') + '>' +
             esc(tac.name) + ' (' + esc(tac.side) + ' / ' + esc(tac.site) + ')</option>';
    }).join('');
  }

  function renderPostPreview(tactic, analysis) {
    const box = $('post-preview');
    if (!tactic) { box.innerHTML = ''; return; }
    const map = D.mapById(S.state.match.map);
    box.innerHTML = '' +
      '<div class="preview-card">' +
        '<span class="lc-label">' + esc(map ? map.name : '-') + ' / ' + esc(tactic.side) + ' / ' + esc(tactic.site) + '</span>' +
        '<h4>' + esc(tactic.name) + '</h4>' +
        (tactic.note ? '<p>' + esc(tactic.note) + '</p>' : '') +
        (analysis && analysis.ready
          ? '<span class="verdict verdict-' + analysis.verdict + '">' + t('analyst.' + analysis.verdict) + ' ' + analysis.score + '/100</span>'
          : '') +
      '</div>';
  }

  /* ================= モーダル ================= */
  function renderRoleFilter(active) {
    $('role-filter').innerHTML =
      '<button type="button" class="role-chip' + (active === 'all' ? ' is-active' : '') + '" data-role="all">' + t('role.all') + '</button>' +
      Object.keys(D.ROLES).map(function (k) {
        const r = D.ROLES[k];
        return '<button type="button" class="role-chip' + (active === k ? ' is-active' : '') +
               '" data-role="' + k + '" style="color:' + (active === k ? r.color : '') + '">' + t('role.' + k) + '</button>';
      }).join('');
  }

  function renderAgentGrid(opts) {
    const raw = (opts.query || '').trim();
    const query = raw.toLowerCase();
    const role = opts.role || 'all';
    const current = opts.current || '';
    const list = D.AGENTS.filter(function (a) {
      if (role !== 'all' && a.role !== role) return false;
      if (!query) return true;
      return a.name.toLowerCase().indexOf(query) >= 0 || a.jp.indexOf(raw) >= 0;
    });

    $('agent-grid').innerHTML = list.length
      ? list.map(function (a) {
          const r = D.ROLES[a.role];
          return '' +
            '<button type="button" class="agent-opt' + (a.id === current ? ' is-active' : '') + '" data-agent="' + a.id + '">' +
              avatarHTML(a.id) +
              '<b>' + esc(a.name) + '</b>' +
              '<small style="color:' + r.color + '">' + t('role.' + a.role) + '</small>' +
            '</button>';
        }).join('')
      : '<p class="deck-empty" style="grid-column:1/-1">' + t('agent.none') + '</p>';
  }

  function renderKindSelect(value) {
    $('t-kind').innerHTML = D.KINDS.map(function (k) {
      return '<option value="' + k.id + '"' + (k.id === value ? ' selected' : '') + '>' +
             esc(k.label) + ' — ' + t('kind.' + k.id) + '</option>';
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

  /* ================= トースト ================= */
  let toastTimer = null;
  function toast(message, kind) {
    const el = $('toast');
    el.textContent = message;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2800);
  }

  global.VCT_UI = {
    $: $, esc: esc, avatarHTML: avatarHTML,
    renderLangPicker: renderLangPicker,
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
    renderAccount: renderAccount,
    renderCommunityMapFilter: renderCommunityMapFilter,
    renderPosts: renderPosts,
    renderPostForm: renderPostForm,
    renderPostPreview: renderPostPreview,
    renderRoleFilter: renderRoleFilter,
    renderAgentGrid: renderAgentGrid,
    renderKindSelect: renderKindSelect,
    renderSiteSeg: renderSiteSeg,
    setSegActive: setSegActive,
    segValue: segValue,
    toast: toast
  };
})(window);

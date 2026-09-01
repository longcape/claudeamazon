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
  const P = global.VCT_PORTRAITS;
  const B = global.VCT_BOARD;
  const AB = global.VCT_ABILITIES;

  /**
   * エージェントアイコン。
   * 公式画像が読み込まれていればそれを、無ければエージェント固有色の
   * 六角アイコンを描く。外周のリングはロール色。
   */
  function avatarHTML(agentId, extraClass) {
    const agent = D.agentById(agentId);
    if (!agent) {
      return '<span class="avatar is-empty ' + (extraClass || '') + '"><span class="avatar-core">?</span></span>';
    }

    const role = D.ROLES[agent.role];
    const sig = P.signature(agent.id);
    const img = P.official(agent.id);

    const core = img
      ? '<span class="avatar-core"><img class="avatar-img" src="' + img + '" alt="' + esc(agent.name) + '" loading="lazy" /></span>'
      : '<span class="avatar-core" style="background:linear-gradient(150deg,' + sig + ',' + shade(sig, -46) + ');color:' + readable(sig) + '">' +
          esc(agent.abbr) +
        '</span>';

    return '<span class="avatar ' + (extraClass || '') + '" title="' + esc(agent.name) + '"' +
           ' style="background:' + role.color + ';box-shadow:0 0 14px ' + hexA(sig, .38) + '">' + core + '</span>';
  }

  function rgbOf(hex) {
    const c = hex.replace('#', '');
    return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
  }

  function hexA(hex, alpha) {
    const p = rgbOf(hex);
    return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + alpha + ')';
  }

  function shade(hex, amount) {
    return '#' + rgbOf(hex).map(function (v) {
      return Math.max(0, Math.min(255, v + amount)).toString(16).padStart(2, '0');
    }).join('');
  }

  /** 明るい下地には濃い文字、暗い下地には白文字を返す */
  function readable(hex) {
    const p = rgbOf(hex);
    const luminance = (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255;
    return luminance > 0.58 ? '#0A1218' : '#FFFFFF';
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
    renderMapFigure();
  }

  /** セットアップ画面のマップ図（選択中のマップの構造を示す） */
  function renderMapFigure() {
    const box = $('map-figure');
    if (!box) return;
    const map = D.mapById(S.state.match.map);
    box.innerHTML = mapFigureHTML({
      map: S.state.match.map,
      side: S.state.match.startSide,
      size: 168,
      caption: (map ? map.name : '') + ' · ' + t('map.schematic')
    });
  }

  /**
   * マップ図。公式ミニマップが読み込まれていればそちらを、
   * 無ければ簡易図（サイトの位置関係）を描く。
   */
  function mapFigureHTML(opts) {
    const M = global.VCT_MAPS;
    if (!M.has(opts.map)) return '';

    const shot = M.minimap(opts.map);
    const spin = M.rotation(opts.map);
    const body = shot
      ? '<img class="map-shot" src="' + shot + '" alt="' + esc(opts.map) + '" ' +
          'style="width:' + opts.size + 'px' + (spin ? ';transform:rotate(' + spin + 'deg)' : '') + '" />'
      : M.render({ map: opts.map, highlight: opts.highlight, side: opts.side, size: opts.size });

    return '<figure class="map-fig-wrap">' + body +
             (opts.caption ? '<figcaption>' + esc(opts.caption) + '</figcaption>' : '') +
           '</figure>';
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
    renderCompBar('ally');
    renderCompBar('enemy');
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

  /* 検索の対象は戦術名・コール詳細・サイトだけにする。
     サイドや戦術タイプまで含めると、'a' が ATK や DEFAULT にも当たって
     一文字の検索がまるごと素通りしてしまう。
     この 2 つは絞り込みチップとまとめ分けで足りている。 */
  function matchesQuery(tac, q) {
    if (!q) return true;
    const hay = [tac.name, tac.note, tac.site].join(' ').toLowerCase();
    /* 空白区切りは AND。「A ラッシュ」で絞り込める */
    return q.toLowerCase().split(/\s+/).filter(Boolean)
      .every(function (word) { return hay.indexOf(word) >= 0; });
  }

  const GROUP_KEYS = ['none', 'site', 'kind', 'side'];

  function groupOf(tac, mode) {
    if (mode === 'site') return tac.site || '-';
    if (mode === 'kind') return tac.kind;
    if (mode === 'side') return tac.side;
    return '';
  }

  function groupLabel(key, mode) {
    if (mode === 'site') return key === '-' ? t('deck.noSite') : t('deck.siteN', { n: key });
    if (mode === 'kind') return D.kindById(key).label;
    if (mode === 'side') return t('filter.' + (key === 'BOTH' ? 'both' : key.toLowerCase()));
    return '';
  }

  /* まとめ方のセレクト。言語を切り替えたときにも描き直す */
  function renderDeckGroupSelect(current) {
    $('deck-group').innerHTML = GROUP_KEYS.map(function (k) {
      return '<option value="' + k + '"' + (k === current ? ' selected' : '') + '>' +
               esc(t('deck.group.' + k)) + '</option>';
    }).join('');
  }

  function renderDeck(uiState) {
    const filter = (uiState && uiState.deckFilter) || 'ALL';
    const query = (uiState && uiState.deckQuery) || '';
    const group = (uiState && uiState.deckGroup) || 'none';

    const all = S.state.tactics;
    const list = all.filter(function (tac) {
      if (filter === 'ATK' && !(tac.side === 'ATK' || tac.side === 'BOTH')) return false;
      if (filter === 'DEF' && !(tac.side === 'DEF' || tac.side === 'BOTH')) return false;
      return matchesQuery(tac, query);
    });

    $('deck-empty').hidden = all.length > 0;

    /* 絞り込みの結果が 0 件なのと、そもそも 1 つも登録が無いのは別物 */
    const narrowed = filter !== 'ALL' || !!query;
    const countEl = $('deck-count');
    if (!all.length) {
      countEl.hidden = true;
    } else {
      countEl.hidden = false;
      countEl.textContent = narrowed
        ? t('deck.countFiltered', { n: list.length, total: all.length })
        : t('deck.count', { n: all.length });
      countEl.classList.toggle('is-empty', list.length === 0);
    }

    if (all.length && !list.length) {
      $('deck-grid').innerHTML = '<p class="deck-empty">' + t('deck.noMatch') + '</p>';
      return;
    }

    if (group === 'none') {
      $('deck-grid').className = 'deck-grid';
      $('deck-grid').innerHTML = list.map(cardHTML).join('');
      return;
    }

    /* 出現順にまとめる。並べ替えはしない（登録した順が作者の意図の順） */
    const order = [];
    const buckets = {};
    list.forEach(function (tac) {
      const key = groupOf(tac, group);
      if (!buckets[key]) { buckets[key] = []; order.push(key); }
      buckets[key].push(tac);
    });

    $('deck-grid').className = 'deck-grouped';
    $('deck-grid').innerHTML = order.map(function (key) {
      return '<section class="deck-section">' +
               '<h3 class="deck-section-head">' +
                 '<span>' + esc(groupLabel(key, group)) + '</span>' +
                 '<b>' + buckets[key].length + '</b>' +
               '</h3>' +
               '<div class="deck-grid">' + buckets[key].map(cardHTML).join('') + '</div>' +
             '</section>';
    }).join('');
  }

  function cardHTML(tac) {
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
            (B.tacticIsEmpty(tac) ? '' : '<span class="tcard-hasboard">▣</span>') +
            '<button type="button" class="tcard-board" data-board-for="' + tac.id + '">' +
              '▣ ' + t('board.edit') + '</button>' +
          '</div>' +
        '</article>';
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
      banner.className = 'match-banner is-final ' + (result === 'WIN' ? 'win' : 'loss');
      /* 決着したら「次のマッチへ」をここに大きく出す。
         下段の小さな「スコアリセット」は見つけにくい。 */
      banner.innerHTML =
        '<span class="banner-text">' +
          esc(t(result === 'WIN' ? 'banner.won' : 'banner.lost', { a: sc.ally, b: sc.enemy })) +
        '</span>' +
        '<button class="btn btn-ghost btn-sm btn-x" data-act="share-x">' + t('share.x') + '</button>' +
        '<button class="btn btn-primary btn-sm" id="btn-next-match">' + t('banner.nextMatch') + '</button>';
    } else if (sc.ally >= 12 || sc.enemy >= 12) {
      banner.hidden = false;
      banner.className = 'match-banner point';
      banner.innerHTML = '';
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
        mapFigureHTML({ map: S.state.match.map, highlight: tac.site, side: side, size: 132 }) +
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
      boardPanelHTML(tac, side, uiState.livePhase) +
      analysisHTML(uiState);
  }

  /* ラウンド中に押されるのはチームへコールを流すときだけ。
     X へのポストはこの画面に要らない（試合中に誰も呟かない）ので、
     試合が終わったときのバナーへ移した。 */
  function shareBarHTML() {
    return '' +
      '<div class="share-bar">' +
        '<span class="lc-label">' + t('share.title') + '</span>' +
        '<button class="btn btn-ghost btn-sm" data-act="share-copy">' + t('share.copy') + '</button>' +
        (global.VCT_COMMUNITY.enabled()
          ? '<button class="btn btn-ghost btn-sm" data-act="share-post">' + t('community.post') + '</button>'
          : '') +
      '</div>';
  }

  /* --- 配置盤（ライブボード上の表示） --- */
  function boardPanelHTML(tactic, side, phaseIndex) {
    const list = B.phases(tactic);
    const idx = Math.max(0, Math.min(list.length - 1, phaseIndex || 0));
    const phase = list[idx];

    /* 局面が 2 つ以上あるときだけタブを出す。
       A フェイク → B 本命 のように、1 枚に混ぜると読めない動きを分けて見る */
    const tabs = list.length > 1
      ? '<div class="stage-bar stage-bar-view">' + list.map(function (p, i) {
          return '<button type="button" class="stage-tab' + (i === idx ? ' is-active' : '') + '"' +
                   ' data-act="live-phase" data-phase-index="' + i + '">' +
                   '<b>' + (i + 1) + '</b>' + esc(p.name || t('board.phaseN', { n: i + 1 })) +
                 '</button>';
        }).join('') + '</div>'
      : '';

    const body = B.isEmpty(phase)
      ? '<div class="panel-body">' + tabs + '<p class="deck-empty">' + t('board.empty') + '</p></div>'
      : '<div class="panel-body board-view">' + tabs +
          B.render({
            phase: phase,
            map: S.state.match.map,
            side: side,
            highlight: tactic.site,
            size: boardSize('view'),
            interactive: false
          }) +
          boardLegendHTML(phase) +
        '</div>';

    return '<article class="panel panel-clip board-panel">' +
             '<header class="panel-head">' +
               '<h2><span class="idx">▣</span>' + t('board.title') + '</h2>' +
               '<div class="panel-head-actions">' +
                 boardSizeControlHTML('act') +
                 '<button class="btn btn-primary btn-sm" data-act="edit-board">' + t('board.edit') + '</button>' +
               '</div>' +
             '</header>' + body +
           '</article>';
  }

  /** エージェントごとにまとめたスキルの使用順。実戦ではこれを読み上げる */
  function boardLegendHTML(phase) {
    const board = B.ensure(phase);
    const abilities = board.marks.filter(function (m) {
      return m.kind === 'ability' && m.team === 'ally';
    });
    /* 設置位置は読み上げの起点になるので、スキルより先に出す */
    const plantRow = B.plantMark(phase)
      ? '<p class="board-plant-note">' + B.spikeIconHTML() +
          '<b>' + t('board.plant') + '</b>' +
          '<span>' + t('board.plantMarked') + '</span></p>'
      : '';
    if (!abilities.length) return plantRow;

    /* エージェント単位にまとめ、各エージェントの中で使用順に並べる */
    const order = [];
    const groups = {};
    abilities.forEach(function (m) {
      const id = B.agentOf(m);
      if (!groups[id]) { groups[id] = []; order.push(id); }
      groups[id].push(m);
    });

    return plantRow + '<ul class="board-legend">' + order.map(function (id) {
      const agent = D.agentById(id);
      const color = agent ? P.signature(id) : '#6B7F8C';
      const steps = groups[id]
        .sort(function (a, b) { return (a.order || 99) - (b.order || 99); })
        .map(function (m) {
          const slot = String(m.ref).split(':')[1] || '?';
          const icon = AB.iconOf(id, slot);
          return '<span class="legend-step">' +
                   '<span class="legend-num">' + (m.order || '-') + '</span>' +
                   (icon
                     ? '<img class="legend-icon" src="' + icon + '" alt="" />'
                     : '<span class="legend-slot">' + esc(slot) + '</span>') +
                   '<span class="legend-name">' + esc(AB.nameOf(id, slot)) + '</span>' +
                 '</span>';
        }).join('');

      return '<li class="board-legend-row" style="--sig:' + color + '">' +
               '<span class="legend-agent">' +
                 avatarHTML(id, 'avatar-sm') +
                 '<b>' + esc(agent ? agent.name : id) + '</b>' +
               '</span>' +
               '<span class="legend-steps">' + steps + '</span>' +
             '</li>';
    }).join('') + '</ul>';
  }

  /* --- 確認・入力ダイアログ --- */

  /**
   * confirm() / prompt() の代わり。
   *
   * 公開ページはサンドボックスの中で動くので、ブラウザが
   * confirm() と prompt() を無視する。押しても何も起きないボタンに
   * なってしまうため、自前のモーダルで受ける。
   *
   * @param {Object} opts { message, okLabel, danger, input, value, placeholder }
   * @returns {Promise} 入力ありなら文字列 / なしなら true。取り消しは null
   */
  function ask(opts) {
    const o = opts || {};
    const modal = $('modal-ask');
    const input = $('ask-input');
    const okBtn = $('ask-ok');

    $('ask-title').textContent = o.title || t('ask.confirm');
    $('ask-message').textContent = o.message || '';
    $('ask-message').hidden = !o.message;
    okBtn.textContent = o.okLabel || t('ask.ok');
    okBtn.classList.toggle('btn-danger', !!o.danger);
    $('ask-cancel').textContent = t('ask.cancel');

    input.hidden = !o.input;
    input.value = o.input ? (o.value || '') : '';
    input.placeholder = o.placeholder || '';

    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(function () { (o.input ? input : okBtn).focus(); }, 0);

    return new Promise(function (resolve) {
      function done(value) {
        modal.hidden = true;
        document.body.style.overflow = '';
        modal.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKey, true);
        resolve(value);
      }
      function accept() {
        if (o.input) {
          const v = input.value.trim();
          if (!v) { input.focus(); return; }   /* 空では決定させない */
          done(v);
          return;
        }
        done(true);
      }
      function onClick(e) {
        if (e.target.closest('[data-ask-cancel]')) { done(null); return; }
        if (e.target.closest('#ask-ok')) accept();
      }
      /* Esc と Enter は他のモーダルより先に拾う。
         重なって開いているとき、下のモーダルまで閉じてしまわないように */
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        else if (e.key === 'Enter') { e.stopPropagation(); accept(); }
      }
      modal.addEventListener('click', onClick);
      document.addEventListener('keydown', onKey, true);
    });
  }

  /* --- 構成のプリセット --- */

  /**
   * 保存済みの 5 人構成。
   * エージェントセレクトの 30 秒で 10 体を選び直すのは間に合わないので、
   * よく当たる構成を 1 クリックで流し込めるようにしている。
   */
  function renderCompBar(team) {
    const list = S.state.comps || [];
    const filled = (team === 'enemy' ? S.state.enemies : S.state.allies)
      .filter(function (s2) { return s2.agent; }).length;

    const chips = list.map(function (c) {
      const icons = c.agents.filter(Boolean).map(function (id) {
        return avatarHTML(id, 'avatar-xs');
      }).join('');
      return '<button type="button" class="comp-chip" data-comp-apply="' + esc(c.id) + '" ' +
               'data-comp-team="' + team + '" title="' + esc(c.name) + '">' +
               '<span class="comp-icons">' + icons + '</span>' +
               '<span class="comp-name">' + esc(c.name) + '</span>' +
             '</button>';
    }).join('');

    /* 保存できるのは 5 人揃っているときだけ。
       欠けた構成を保存しても呼び出したとき結局埋め直しになる */
    const save = filled === 5 && list.length < S.MAX_COMPS
      ? '<button type="button" class="comp-save" data-comp-save="' + team + '">＋ ' +
          t('comp.save') + '</button>'
      : '';

    $('comp-bar-' + team).innerHTML =
      (chips || save ? '<span class="comp-label">' + t('comp.label') + '</span>' : '') + chips + save;
  }

  /* --- 分岐ツリー --- */

  /**
   * 戦術の分岐図。
   * 線は裏の SVG、ノードは HTML の箱。
   * 全部 SVG で描くと分岐先を選ぶ操作を自前で作ることになるので、
   * 箱は HTML にして素の <select> を使っている。
   */
  function renderTree(uiState) {
    const T = global.VCT_TREE;
    const tactics = S.state.tactics;
    const el = $('tree-canvas');

    if (!tactics.length) {
      el.innerHTML = '<p class="deck-empty">' + t('tree.noTactics') + '</p>';
      return;
    }

    const plan = T.layout(tactics);
    const nodes = plan.nodes.map(function (n) {
      return nodeHTML(n, tactics, uiState);
    }).join('');

    el.innerHTML =
      '<div class="tree-stage" style="width:' + plan.width + 'px;height:' + plan.height + 'px">' +
        T.edgeLayerHTML(plan) + nodes +
      '</div>';
  }

  function nodeHTML(n, tactics, uiState) {
    const T = global.VCT_TREE;
    const tac = n.tactic;
    const current = uiState && uiState.treeFocusId === tac.id;

    const picker = function (result) {
      const sel = tac.next[result] || '';
      const opts = ['<option value="">' + esc(t('tree.unset')) + '</option>'].concat(
        tactics.map(function (o) {
          return '<option value="' + esc(o.id) + '"' + (o.id === sel ? ' selected' : '') + '>' +
                   esc(o.id === tac.id ? t('tree.again') : o.name) + '</option>';
        })
      ).join('');
      return '<label class="tree-branch tree-branch-' + result + '">' +
               '<span>' + t('tree.' + result) + '</span>' +
               '<select data-tree-node="' + esc(tac.id) + '" data-tree-result="' + result + '">' +
                 opts + '</select>' +
             '</label>';
    };

    return '<article class="tree-node' + (current ? ' is-current' : '') + '" ' +
             'data-side="' + esc(tac.side) + '" ' +
             'style="left:' + n.x + 'px;top:' + n.y + 'px;width:' + T.NODE_W + 'px">' +
             '<h4>' +
               '<span class="badge badge-site">' + esc(tac.site || '-') + '</span>' +
               '<b>' + esc(tac.name) + '</b>' +
             '</h4>' +
             '<div class="tree-branches">' + picker('win') + picker('loss') + '</div>' +
           '</article>';
  }

  /* --- クラウド保存 --- */

  /**
   * 保存済みセットアップの一覧。
   * ログインしていないと自分の行が引けない（RLS）ので、
   * 未ログインならログインへ誘導するだけにする。
   */
  function renderCloud(uiState) {
    const el = $('cloud-body');
    const C = global.VCT_COMMUNITY;

    if (!C.currentUser()) {
      el.innerHTML =
        '<p class="cloud-note">' + esc(t('cloud.needLogin')) + '</p>' +
        '<button type="button" class="btn btn-primary" data-cloud-act="login">' +
          t('community.login') + '</button>';
      return;
    }

    const list = uiState.cloudSetups || [];
    const rows = list.length
      ? '<ul class="cloud-list">' + list.map(function (row) {
          return '<li class="cloud-row" data-cloud-id="' + esc(row.id) + '">' +
                   '<div class="cloud-row-main">' +
                     '<b>' + esc(row.name) + '</b>' +
                     '<span>' + esc(cloudMeta(row)) + '</span>' +
                   '</div>' +
                   '<div class="cloud-row-acts">' +
                     '<button type="button" class="btn btn-ghost btn-sm" data-cloud-act="load">' +
                       t('cloud.load') + '</button>' +
                     '<button type="button" class="btn btn-ghost btn-sm" data-cloud-act="overwrite">' +
                       t('cloud.overwrite') + '</button>' +
                     '<button type="button" class="btn btn-ghost btn-sm btn-danger" data-cloud-act="delete">' +
                       t('cloud.delete') + '</button>' +
                   '</div>' +
                 '</li>';
        }).join('') + '</ul>'
      : '<p class="cloud-note">' + esc(t('cloud.none')) + '</p>';

    el.innerHTML =
      '<div class="cloud-save">' +
        '<input type="text" id="cloud-name" maxlength="60" value="' + esc(defaultSetupName()) + '" ' +
          'placeholder="' + esc(t('cloud.namePh')) + '" />' +
        '<button type="button" class="btn btn-primary" data-cloud-act="save">' +
          t('cloud.save') + '</button>' +
      '</div>' +
      '<p class="cloud-note">' + esc(t('cloud.scope')) + '</p>' +
      (uiState.cloudLoading ? '<p class="cloud-note">' + esc(t('common.loading')) + '</p>' : rows);
  }

  /** 「アセント / 戦術 7 件 / 8月27日」のような見出しの補助行 */
  function cloudMeta(row) {
    const n = row.payload && Array.isArray(row.payload.tactics) ? row.payload.tactics.length : 0;
    const map = row.payload && row.payload.match && row.payload.match.map;
    const mapName = map ? (D.mapById(map) || {}).name || map : '';
    const when = row.updated_at ? new Date(row.updated_at).toLocaleString() : '';
    return [mapName, t('deck.count', { n: n }), when].filter(Boolean).join(' / ');
  }

  function defaultSetupName() {
    const m = D.mapById(S.state.match.map);
    const d = new Date();
    const stamp = (d.getMonth() + 1) + '/' + d.getDate();
    return [(m && m.name) || '', S.state.match.enemyTeam || '', stamp]
      .filter(Boolean).join(' ').slice(0, 60);
  }

  /* --- 配置盤エディタ --- */
  function renderBoardEditor(uiState) {
    const tactic = uiState.boardTactic;
    if (!tactic) return;

    $('board-tactic-name').textContent = tactic.name;
    renderBoardPhases(uiState);
    renderBoardPalette('ally', uiState);
    renderBoardPalette('enemy', uiState);
    renderBoardTools(uiState);
    /* ヒントの高さも予算に入るので、盤面より先に確定させる */
    renderBoardHint(uiState);
    renderBoardCanvas(uiState);
  }

  /* 局面のタブ。名前は空でもよく、その場合は「局面 N」と表示する */
  function renderBoardPhases(uiState) {
    const list = B.phases(uiState.boardTactic);
    const idx = uiState.phaseIndex || 0;

    const tabs = list.map(function (p, i) {
      return '<button type="button" class="stage-tab' + (i === idx ? ' is-active' : '') + '"' +
               ' data-phase-act="go" data-phase-index="' + i + '">' +
               '<b>' + (i + 1) + '</b>' + esc(p.name || t('board.phaseN', { n: i + 1 })) +
             '</button>';
    }).join('');

    const add = list.length < B.MAX_PHASES
      ? '<button type="button" class="stage-add" data-phase-act="add">＋ ' + t('board.phaseAdd') + '</button>'
      : '';

    $('board-phases').innerHTML =
      tabs + add +
      '<input type="text" id="phase-name" maxlength="24" value="' + esc(list[idx].name) + '" ' +
        'placeholder="' + esc(t('board.phaseNamePh')) + '" />' +
      (list.length > 1
        ? '<button type="button" class="btn btn-ghost btn-sm btn-danger" data-phase-act="del">' +
            t('board.phaseDel') + '</button>'
        : '');
  }

  function renderBoardPalette(team, uiState) {
    const slots = team === 'ally' ? S.state.allies : S.state.enemies;
    const armed = uiState.armed;

    const groups = slots.map(function (slot) {
      const agent = D.agentById(slot.agent);
      if (!agent) return '';
      const color = P.signature(agent.id);
      const abilityChips = AB.listFor(agent.id).map(function (ab) {
        const isArmed = armed && armed.kind === 'ability' && armed.ref === ab.ref && armed.team === team;
        return '<button type="button" class="pal-ability' + (isArmed ? ' is-armed' : '') + '"' +
                 ' data-place-kind="ability" data-place-ref="' + esc(ab.ref) + '" data-place-team="' + team + '"' +
                 ' title="' + esc(ab.slot + '  ' + ab.name) + '"' +
                 ' style="--sig:' + color + '">' +
                 (ab.icon
                   ? '<img class="pal-icon" src="' + ab.icon + '" alt="' + esc(ab.name) + '" />'
                   : '<b>' + esc(ab.slot) + '</b>') +
                 '<i>' + esc(ab.slot) + '</i>' +
               '</button>';
      }).join('');

      const agentArmed = armed && armed.kind === 'agent' && armed.ref === agent.id && armed.team === team;
      return '<div class="pal-group">' +
               '<button type="button" class="pal-agent' + (agentArmed ? ' is-armed' : '') + '"' +
                 ' data-place-kind="agent" data-place-ref="' + esc(agent.id) + '" data-place-team="' + team + '">' +
                 avatarHTML(agent.id, 'avatar-sm') +
                 '<span>' + esc(agent.name) + '</span>' +
               '</button>' +
               '<div class="pal-abilities">' + abilityChips + '</div>' +
             '</div>';
    }).join('');

    $('board-palette-' + team).innerHTML =
      '<h3 class="pal-title"><span class="tag tag-' + team + '">' + t('tag.' + team) + '</span></h3>' +
      (groups.trim() ? groups : '<p class="deck-empty">' + t('board.noRoster') + '</p>');
  }

  function renderBoardTools(uiState) {
    const routing = !!uiState.routeTeam;
    const selected = uiState.selectedMarkId
      ? B.findMark(B.phaseAt(uiState.boardTactic, uiState.phaseIndex), uiState.selectedMarkId) : null;

    let html = '<div class="board-tool-row">';
    if (routing) {
      html += '<button class="btn btn-primary btn-sm" data-board-act="route-done">' + t('board.routeDone') + '</button>' +
              '<button class="btn btn-ghost btn-sm" data-board-act="route-cancel">' + t('board.routeCancel') + '</button>';
    } else {
      const planted = !!B.plantMark(B.phaseAt(uiState.boardTactic, uiState.phaseIndex));
      const plantArmed = uiState.armed && uiState.armed.kind === 'plant';
      /* スパイクはどちらのチームのものでもないので、
         味方／敵のパレットではなくツールバーに置いている */
      html += '<button type="button" class="btn btn-sm pal-plant' +
                (plantArmed ? ' is-armed' : '') + (planted ? ' is-placed' : '') + '"' +
                ' data-place-kind="plant" data-place-ref="spike" data-place-team="ally"' +
                ' title="' + esc(t('board.plant')) + '">' +
                B.spikeIconHTML() + '<span>' + t('board.plant') + '</span>' +
              '</button>' +
              '<button class="btn btn-ghost btn-sm" data-board-act="route-start" data-team="ally">' +
                '<span class="dot-ally"></span>' + t('board.route') + ' / ' + t('tag.ally') + '</button>' +
              '<button class="btn btn-ghost btn-sm" data-board-act="route-start" data-team="enemy">' +
                '<span class="dot-enemy"></span>' + t('board.route') + ' / ' + t('tag.enemy') + '</button>';
      if (uiState.armed) {
        html += '<button class="btn btn-ghost btn-sm is-armed-note" data-board-act="disarm">✕ ' +
                  esc(armedLabel(uiState.armed)) + '</button>';
      }
    }
    html += boardSizeControlHTML('board-act');
    html += '</div>';

    if (selected) {
      html += '<div class="board-tool-row board-tool-selected">';
      if (selected.kind === 'ability') {
        html += '<button class="btn btn-ghost btn-sm" data-board-act="order-up">↑ ' + t('board.orderUp') + '</button>' +
                '<button class="btn btn-ghost btn-sm" data-board-act="order-down">↓ ' + t('board.orderDown') + '</button>';
      }
      html += '<button class="btn btn-ghost btn-sm btn-danger" data-board-act="delete-mark">' + t('board.delete') + '</button>' +
              '</div>';
    }

    $('board-tools').innerHTML = html;
  }

  /* 表示サイズ。localStorage に覚えさせる */
  const SIZE_STEPS = [520, 660, 800, 940, 1080];
  const SIZE_KEY = 'vct.boardSize';

  function boardSize(mode) {
    let idx = 2;
    try {
      const saved = parseInt(localStorage.getItem(SIZE_KEY), 10);
      if (Number.isFinite(saved)) idx = Math.max(0, Math.min(SIZE_STEPS.length - 1, saved));
    } catch (e) { /* 使えなくても既定値で動く */ }
    const base = SIZE_STEPS[idx];
    /* ライブボードは横に凡例を並べるので少し小さめにする */
    return mode === 'view' ? Math.round(base * 0.8) : base;
  }

  function setBoardSizeIndex(idx) {
    const clamped = Math.max(0, Math.min(SIZE_STEPS.length - 1, idx));
    try { localStorage.setItem(SIZE_KEY, String(clamped)); } catch (e) { /* noop */ }
    return clamped;
  }

  function boardSizeIndex() {
    try {
      const saved = parseInt(localStorage.getItem(SIZE_KEY), 10);
      if (Number.isFinite(saved)) return Math.max(0, Math.min(SIZE_STEPS.length - 1, saved));
    } catch (e) { /* noop */ }
    return 2;
  }

  /**
   * 表示サイズの増減。ライブボードと編集画面の両方から使えるよう、
   * 属性名（data-act / data-board-act）を切り替えられるようにしている。
   */
  function boardSizeControlHTML(attr) {
    const idx = boardSizeIndex();
    const a = attr === 'act' ? 'data-act' : 'data-board-act';
    /* 編集画面では画面に収まる大きさへ抑えるので、実寸を出す */
    const shown = attr === 'act' ? SIZE_STEPS[idx] : fitBoardSize(SIZE_STEPS[idx]);
    return '<span class="board-size">' +
             '<span class="lc-label">' + t('board.size') + '</span>' +
             '<button class="btn btn-ghost btn-sm" ' + a + '="size-down"' +
               (idx <= 0 ? ' disabled' : '') + '>−</button>' +
             '<b>' + shown + '</b>' +
             '<button class="btn btn-ghost btn-sm" ' + a + '="size-up"' +
               (idx >= SIZE_STEPS.length - 1 ? ' disabled' : '') + '>＋</button>' +
           '</span>';
  }

  /**
   * 盤面に使える高さ。
   * 指定サイズのまま描くと画面からはみ出し、下半分に置くたびに
   * スクロールする羽目になるので、収まる大きさに抑える。
   */
  function fitBoardSize(desired) {
    const card = document.querySelector('#modal-board .modal-card');
    const stage = document.querySelector('#modal-board .board-stage');
    const canvas = $('board-canvas');
    if (!card || !stage) return desired;

    /* 予算は「今のカードの高さ」ではなく「カードの最大高さ」から引く。
       今の高さを基準にすると、盤面を縮める → カードが縮む → さらに縮める、と
       描き直すたびに小さくなっていってしまう。 */
    const maxH = parseFloat(getComputedStyle(card).maxHeight);
    if (!(maxH > 0)) return desired;

    let used = 0;
    Array.prototype.forEach.call(card.children, function (el) {
      if (el.classList.contains('modal-body')) return;
      /* 余白ぶんも数える。数え落とすとその分だけ盤面がはみ出す */
      const cs = getComputedStyle(el);
      used += el.getBoundingClientRect().height +
              (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    });
    Array.prototype.forEach.call(stage.children, function (el) {
      if (el !== canvas) used += el.getBoundingClientRect().height + 8;
    });

    const body = card.querySelector('.modal-body');
    const pad = body
      ? parseFloat(getComputedStyle(body).paddingTop) + parseFloat(getComputedStyle(body).paddingBottom)
      : 36;
    const avail = Math.floor(maxH - used - pad - 18);   /* 18 は端に触れないための余裕 */
    if (!(avail > 0)) return desired;
    return Math.max(360, Math.min(desired, avail));
  }

  function renderBoardCanvas(uiState) {
    $('board-canvas').innerHTML = B.render({
      phase: B.phaseAt(uiState.boardTactic, uiState.phaseIndex),
      map: S.state.match.map,
      side: uiState.boardSide,
      highlight: uiState.boardTactic.site,
      size: fitBoardSize(boardSize('edit')),
      interactive: true,
      selectedId: uiState.selectedMarkId,
      draftRoute: uiState.draftRoute,
      draftTeam: uiState.routeTeam
    });
  }

  function renderBoardHint(uiState) {
    const el = $('board-hint');
    if (uiState.routeTeam) { el.textContent = t('board.hintRoute'); return; }
    if (uiState.armed) {
      el.textContent = t('board.armed', { name: armedLabel(uiState.armed) });
      return;
    }
    const selected = uiState.selectedMarkId
      ? B.findMark(B.phaseAt(uiState.boardTactic, uiState.phaseIndex), uiState.selectedMarkId) : null;
    if (selected) {
      el.textContent = t('board.hintSelected', { name: markLabel(selected) });
      return;
    }
    el.textContent = t('board.hintPlace') + ' ' + t('board.orderNote');
  }

  function armedLabel(armed) {
    if (armed.kind === 'plant') return t('board.plant');
    if (armed.kind === 'agent') {
      const a = D.agentById(armed.ref);
      return a ? a.name : armed.ref;
    }
    const parts = String(armed.ref).split(':');
    return AB.nameOf(parts[0], parts[1]);
  }

  function markLabel(mark) {
    return armedLabel({ kind: mark.kind, ref: mark.ref });
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

    /* 直前ラウンドの結果から、ツリーが指している次の戦術。
       縛りではなく道しるべなので、先頭に出したうえで
       他の戦術も必ず選べるようにしておく */
    const T = global.VCT_TREE;
    const suggested = last ? T.nextOf(S.state.tactics, S.tacticById(last.tacticId), last.result) : null;
    const treeHTML = suggested
      ? '<div class="tree-next">' +
          '<span class="tree-next-label">' +
            t('tree.nextAfter', { result: t(last.result === 'WIN' ? 'res.win' : 'res.loss') }) +
          '</span>' +
          '<button type="button" class="pick is-tree" data-act="pick" data-id="' + esc(suggested.id) + '">' +
            '<span class="pick-score good"><b>⑂</b><small>' + t('tree.badge') + '</small></span>' +
            '<span class="pick-main">' +
              '<span class="pick-name">' + esc(suggested.name) + sideBadge(suggested.side) +
                '<span class="badge badge-site">' + esc(suggested.site || '-') + '</span>' +
              '</span>' +
              (suggested.note ? '<span class="pick-reasons"><span class="reason">' +
                esc(suggested.note) + '</span></span>' : '') +
            '</span>' +
          '</button>' +
        '</div>'
      : '';

    const listLabel = suggested
      ? '<p class="pick-others">' + t('tree.others') + '</p>'
      : '';

    const body = ranked.length
      ? treeHTML + listLabel + '<div class="pick-list">' + ranked.map(function (r, i) {
          const st = r.stats;
          return '' +
            '<button type="button" class="pick' + (i === 0 && !suggested ? ' is-top' : '') + '" data-act="pick" data-id="' + r.tactic.id + '">' +
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

  function renderPosts(posts, status, query) {
    const grid = $('post-grid');
    const empty = $('post-empty');

    /* 検索は取ってきたぶんを手元で絞る。
       自分のデッキ検索（renderDeck）とは別物なので、当てる先も文言も分けている */
    if (query && Array.isArray(posts)) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      posts = posts.filter(function (p) {
        /* 列名は name / note。title / body という列はテーブルに無い。
           以前ここを title / body にしていたせいで、戦術名でもコール詳細でも
           絶対にヒットしない検索になっていた（投稿者とマップだけ引っかかっていた）。 */
        const map = D.mapById(p.map);
        const hay = [p.name, p.note, p.site, p.kind, p.map, map ? map.name : '', p.author_name]
          .join(' ').toLowerCase();
        return words.every(function (w) { return hay.indexOf(w) >= 0; });
      });
      if (!posts.length) { status = t('community.noMatch'); }
    }

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
    renderMapFigure: renderMapFigure,
    mapFigureHTML: mapFigureHTML,
    renderSideToggle: renderSideToggle,
    renderMatchFields: renderMatchFields,
    renderRoster: renderRoster,
    ask: ask,
    renderCloud: renderCloud,
    renderTree: renderTree,
    renderCompBar: renderCompBar,
    renderDeck: renderDeck,
    renderDeckGroupSelect: renderDeckGroupSelect,
    renderReady: renderReady,
    renderScorebar: renderScorebar,
    renderBoardRosters: renderBoardRosters,
    renderStage: renderStage,
    renderBoardEditor: renderBoardEditor,
    renderBoardCanvas: renderBoardCanvas,
    renderBoardTools: renderBoardTools,
    renderBoardHint: renderBoardHint,
    renderBoardPalette: renderBoardPalette,
    renderBoardPhases: renderBoardPhases,
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
    boardSize: boardSize,
    boardSizeIndex: boardSizeIndex,
    setBoardSizeIndex: setBoardSizeIndex,
    setSegActive: setSegActive,
    segValue: segValue,
    toast: toast
  };
})(window);

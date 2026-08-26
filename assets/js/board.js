/* =========================================================
   TACTICAL BOARD
   ---------------------------------------------------------
   マップ上にエージェントとアビリティを配置し、進行ルートを
   矢印で描くための盤面。配置は戦術ごとに保存される。

   データ構造（tactic.board）:
     marks:  [{ id, kind:'agent'|'ability', ref, team, x, y, order }]
     routes: [{ id, team, points:[{x,y}] }]
   座標はマップ簡易図と同じ 0-100 の正規化空間。
   ========================================================= */
(function (global) {
  'use strict';

  const D = global.VCT_DATA;
  const P = global.VCT_PORTRAITS;
  const AB = global.VCT_ABILITIES;
  const M = global.VCT_MAPS;

  function uid(prefix) {
    return prefix + Math.random().toString(36).slice(2, 8);
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 戦術に board が無ければ空の board を用意する */
  function ensure(tactic) {
    if (!tactic) return null;
    if (!tactic.board || typeof tactic.board !== 'object') {
      tactic.board = { marks: [], routes: [] };
    }
    if (!Array.isArray(tactic.board.marks)) tactic.board.marks = [];
    if (!Array.isArray(tactic.board.routes)) tactic.board.routes = [];
    return tactic.board;
  }

  function isEmpty(tactic) {
    const b = tactic && tactic.board;
    return !b || ((b.marks || []).length === 0 && (b.routes || []).length === 0);
  }

  /* ---------------- 配置の操作 ---------------- */

  function addMark(tactic, mark) {
    const b = ensure(tactic);
    const entry = {
      id: uid('mk_'),
      kind: mark.kind === 'ability' ? 'ability' : 'agent',
      ref: String(mark.ref),
      team: mark.team === 'enemy' ? 'enemy' : 'ally',
      x: clamp(mark.x),
      y: clamp(mark.y),
      order: null
    };
    /* アビリティは使用順が意味を持つので自動で採番する。
       番号はエージェントごとに 1 から振る（ジェットの 1 個目 / 2 個目、という読み方をするため） */
    if (entry.kind === 'ability') entry.order = nextOrder(b, entry.team, agentOf(entry));
    b.marks.push(entry);
    return entry;
  }

  /** マークが属するエージェント id。'jett:C' → 'jett' */
  function agentOf(mark) {
    return String(mark.ref).split(':')[0];
  }

  function nextOrder(board, team, agentId) {
    const used = board.marks
      .filter(function (m) {
        return m.kind === 'ability' && m.team === team && agentOf(m) === agentId && m.order;
      })
      .map(function (m) { return m.order; });
    return used.length ? Math.max.apply(null, used) + 1 : 1;
  }

  function moveMark(tactic, id, x, y) {
    const m = findMark(tactic, id);
    if (!m) return;
    m.x = clamp(x);
    m.y = clamp(y);
  }

  function removeMark(tactic, id) {
    const b = ensure(tactic);
    b.marks = b.marks.filter(function (m) { return m.id !== id; });
    renumber(b);
  }

  /** 削除や並び替えのあとに、エージェントごとに 1 から振り直す */
  function renumber(board) {
    const groups = {};
    board.marks.forEach(function (m) {
      if (m.kind !== 'ability') return;
      const key = m.team + '/' + agentOf(m);
      (groups[key] = groups[key] || []).push(m);
    });
    Object.keys(groups).forEach(function (key) {
      groups[key]
        .sort(function (a, b) { return (a.order || 99) - (b.order || 99); })
        .forEach(function (m, i) { m.order = i + 1; });
    });
  }

  function bumpOrder(tactic, id, delta) {
    const b = ensure(tactic);
    const target = findMark(tactic, id);
    if (!target || target.kind !== 'ability') return;

    const peers = b.marks
      .filter(function (m) {
        return m.kind === 'ability' && m.team === target.team && agentOf(m) === agentOf(target);
      })
      .sort(function (a, b2) { return a.order - b2.order; });

    const idx = peers.indexOf(target);
    const swapWith = peers[idx + delta];
    if (!swapWith) return;

    const tmp = target.order;
    target.order = swapWith.order;
    swapWith.order = tmp;
  }

  function findMark(tactic, id) {
    const b = ensure(tactic);
    return b.marks.filter(function (m) { return m.id === id; })[0] || null;
  }

  function addRoute(tactic, team, points) {
    if (!points || points.length < 2) return null;
    const b = ensure(tactic);
    const route = {
      id: uid('rt_'),
      team: team === 'enemy' ? 'enemy' : 'ally',
      points: points.map(function (p) { return { x: clamp(p.x), y: clamp(p.y) }; })
    };
    b.routes.push(route);
    return route;
  }

  function removeRoute(tactic, id) {
    const b = ensure(tactic);
    b.routes = b.routes.filter(function (r) { return r.id !== id; });
  }

  function clearBoard(tactic) {
    const b = ensure(tactic);
    b.marks = [];
    b.routes = [];
  }

  function clamp(v) {
    return Math.max(2, Math.min(98, Number(v) || 0));
  }

  /* ---------------- 描画 ---------------- */

  /**
   * 盤面を SVG で描く。
   * @param {Object} opts { tactic, map, side, size, interactive, selectedId, draftRoute, draftTeam }
   */
  function render(opts) {
    const tactic = opts.tactic;
    const board = ensure(tactic);
    const size = opts.size || 420;
    const interactive = !!opts.interactive;

    /* 下地はマップ簡易図（公式ミニマップがあればそちら） */
    const shot = M.minimap(opts.map);
    const base = shot
      ? '<image href="' + shot + '" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid slice" opacity="0.75" />'
      : baseLayerHTML(opts.map, opts.highlight, opts.side);

    const routes = board.routes.map(function (r) { return routeHTML(r); }).join('');
    const draft = opts.draftRoute && opts.draftRoute.length
      ? routeHTML({ id: 'draft', team: opts.draftTeam || 'ally', points: opts.draftRoute }, true)
      : '';
    const marks = board.marks.map(function (m) {
      return markHTML(m, m.id === opts.selectedId);
    }).join('');

    return '' +
      '<svg class="board-svg' + (interactive ? ' is-interactive' : '') + '" viewBox="0 0 100 100" ' +
           'width="' + size + '" height="' + size + '" ' +
           (interactive ? 'data-board="1" ' : '') +
           'role="img" aria-label="tactical board">' +
        '<defs>' +
          '<marker id="ml-arrow-ally" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">' +
            '<path d="M0 0 L10 5 L0 10 z" fill="#35C6E8" />' +
          '</marker>' +
          '<marker id="ml-arrow-enemy" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">' +
            '<path d="M0 0 L10 5 L0 10 z" fill="#FF4655" />' +
          '</marker>' +
        '</defs>' +
        base + routes + draft + marks +
      '</svg>';
  }

  /** マップ簡易図を下地として埋め込む（外枠は盤面側で描く） */
  function baseLayerHTML(mapId, highlight, side) {
    const svg = M.render({ map: mapId, highlight: highlight, side: side, size: 100 });
    /* 外側の <svg> を剥がして中身だけ使う */
    const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    return '<g class="board-base">' + inner + '</g>';
  }

  function routeHTML(route, isDraft) {
    const pts = route.points.map(function (p) { return p.x + ',' + p.y; }).join(' ');
    return '<polyline class="board-route board-route-' + route.team + (isDraft ? ' is-draft' : '') + '" ' +
           'points="' + pts + '" ' +
           'marker-end="url(#ml-arrow-' + route.team + ')" ' +
           'data-route="' + esc(route.id) + '" />';
  }

  function markHTML(mark, selected) {
    if (mark.kind === 'agent') return agentMarkHTML(mark, selected);
    return abilityMarkHTML(mark, selected);
  }

  function agentMarkHTML(mark, selected) {
    const agent = D.agentById(mark.ref);
    const color = agent ? P.signature(agent.id) : '#6B7F8C';
    const label = agent ? agent.abbr : '?';
    const ring = mark.team === 'enemy' ? '#FF4655' : '#35C6E8';

    return '<g class="board-mark board-mark-agent' + (selected ? ' is-selected' : '') + '" ' +
             'data-mark="' + esc(mark.id) + '" transform="translate(' + mark.x + ',' + mark.y + ')">' +
             '<circle r="4.6" fill="' + ring + '" opacity="0.9" />' +
             '<circle r="3.6" fill="' + color + '" />' +
             '<text class="board-mark-label" y="1.3">' + esc(label) + '</text>' +
           '</g>';
  }

  function abilityMarkHTML(mark, selected) {
    const parts = String(mark.ref).split(':');
    const agent = D.agentById(parts[0]);
    const slot = parts[1] || '?';
    const color = agent ? P.signature(agent.id) : '#6B7F8C';
    const icon = AB.iconOf(parts[0], slot);

    /* 公式アイコンがあればそれを、無ければスロット文字を出す */
    const face = icon
      ? '<image href="' + icon + '" x="-3" y="-3" width="6" height="6" preserveAspectRatio="xMidYMid meet" />'
      : '<text class="board-mark-slot" y="1.2">' + esc(slot) + '</text>';

    return '<g class="board-mark board-mark-ability' + (selected ? ' is-selected' : '') + '" ' +
             'data-mark="' + esc(mark.id) + '" transform="translate(' + mark.x + ',' + mark.y + ')">' +
             '<rect x="-3.9" y="-3.9" width="7.8" height="7.8" rx="1.4" ' +
               'fill="' + color + '" fill-opacity="0.3" stroke="' + color + '" stroke-width="0.7" />' +
             face +
             (mark.order
               ? '<circle class="board-order-bg" cx="4.1" cy="-4.1" r="2.5" />' +
                 '<text class="board-order" x="4.1" y="-3.2">' + mark.order + '</text>'
               : '') +
           '</g>';
  }

  /* ---------------- 座標変換 ---------------- */

  /** ポインタ座標を盤面の 0-100 空間に変換する */
  function toBoardPoint(svg, evt) {
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return { x: 50, y: 50 };
    return {
      x: clamp(((evt.clientX - r.left) / r.width) * 100),
      y: clamp(((evt.clientY - r.top) / r.height) * 100)
    };
  }

  global.VCT_BOARD = {
    ensure: ensure,
    isEmpty: isEmpty,
    addMark: addMark,
    moveMark: moveMark,
    removeMark: removeMark,
    bumpOrder: bumpOrder,
    findMark: findMark,
    addRoute: addRoute,
    removeRoute: removeRoute,
    clearBoard: clearBoard,
    render: render,
    toBoardPoint: toBoardPoint,
    renumber: renumber,
    agentOf: agentOf
  };
})(window);

/* =========================================================
   TACTIC TREE — 勝敗で分岐する戦術のつながり
   ---------------------------------------------------------
   「この戦術で勝ったら次はこれ、負けたらこれ」を戦術ごとに持たせ、
   ラウンドの勝敗が付いた時点で次の候補を出せるようにする。

   データ:
     tactic.next = { win: <tacticId>|null, loss: <tacticId>|null }

   ツリーと言いつつ実際は有向グラフ。
   「勝ったら同じ形をもう一度」（自分自身へ戻る）や、
   2 つの戦術が互いを指す形は実戦で普通に出てくるので、
   循環を禁止せず、描画側で辿り直さないようにして扱う。

   分岐は縛りではなく道しるべ。ライブ画面では
   ツリーの次を先頭に出したうえで、他の戦術も必ず選べるようにしている。
   ========================================================= */
(function (global) {
  'use strict';

  const RESULTS = ['win', 'loss'];

  /* 描画の寸法。ノードの箱と列の間隔 */
  const NODE_W = 208;
  const NODE_H = 78;
  const COL_GAP = 86;
  const ROW_GAP = 18;
  const PAD = 16;

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function ensure(tactic) {
    if (!tactic) return null;
    if (!tactic.next || typeof tactic.next !== 'object') tactic.next = { win: null, loss: null };
    RESULTS.forEach(function (r) {
      if (typeof tactic.next[r] !== 'string' || !tactic.next[r]) tactic.next[r] = null;
    });
    return tactic.next;
  }

  /**
   * 分岐先の戦術。
   * 消された戦術を指したままの枝は、存在しない扱いにして黙って無視する。
   * （消すたびに全戦術を舐めて掃除するより、読むときに確かめる方が安全）
   */
  function nextOf(tactics, tactic, result) {
    const next = ensure(tactic);
    if (!next) return null;
    const key = result === 'WIN' || result === 'win' ? 'win' : 'loss';
    const id = next[key];
    if (!id) return null;
    return tactics.filter(function (t) { return t.id === id; })[0] || null;
  }

  function setNext(tactic, result, id) {
    const next = ensure(tactic);
    if (!next) return;
    const key = result === 'WIN' || result === 'win' ? 'win' : 'loss';
    next[key] = id || null;
  }

  /** 分岐がひとつでも設定されているか */
  function hasBranches(tactics) {
    return tactics.some(function (t) {
      const n = ensure(t);
      return !!(n.win || n.loss);
    });
  }

  /* ---------------- 配置 ---------------- */

  /**
   * 各戦術を「何手目に出てくるか」で列に振り分ける。
   * 入ってくる枝が無いものを起点にし、そこから幅優先で辿る。
   * 全部が循環している場合は起点が見つからないので、
   * 残ったものを順に起点として扱う。
   */
  function layout(tactics) {
    const byId = {};
    tactics.forEach(function (t) { ensure(t); byId[t.id] = t; });

    const incoming = {};
    tactics.forEach(function (t) {
      RESULTS.forEach(function (r) {
        const id = t.next[r];
        /* 自分から自分への枝は「入ってくる枝」に数えない。
           数えると自己ループだけの戦術が起点から外れて消える */
        if (id && byId[id] && id !== t.id) incoming[id] = (incoming[id] || 0) + 1;
      });
    });

    const col = {};
    const order = [];
    const queue = [];

    tactics.forEach(function (t) {
      if (!incoming[t.id]) { col[t.id] = 0; order.push(t.id); queue.push(t.id); }
    });
    /* 全部が循環している場合の逃げ道 */
    if (!queue.length && tactics.length) {
      col[tactics[0].id] = 0; order.push(tactics[0].id); queue.push(tactics[0].id);
    }

    while (queue.length) {
      const id = queue.shift();
      const t = byId[id];
      RESULTS.forEach(function (r) {
        const nid = t.next[r];
        if (!nid || !byId[nid] || col[nid] !== undefined) return;
        col[nid] = col[id] + 1;
        order.push(nid);
        queue.push(nid);
      });
    }

    /* どこからも辿り着けなかったもの（循環の中だけにいる戦術）を拾う */
    tactics.forEach(function (t) {
      if (col[t.id] === undefined) { col[t.id] = 0; order.push(t.id); }
    });

    const rows = {};
    const nodes = order.map(function (id) {
      const c = col[id];
      const row = rows[c] = (rows[c] === undefined ? 0 : rows[c] + 1);
      return {
        id: id,
        tactic: byId[id],
        col: c,
        row: row,
        x: PAD + c * (NODE_W + COL_GAP),
        y: PAD + row * (NODE_H + ROW_GAP)
      };
    });

    const pos = {};
    nodes.forEach(function (n) { pos[n.id] = n; });

    const edges = [];
    nodes.forEach(function (n) {
      RESULTS.forEach(function (r) {
        const nid = n.tactic.next[r];
        if (nid && pos[nid]) edges.push({ from: n.id, to: nid, result: r });
      });
    });

    const cols = Math.max.apply(null, nodes.map(function (n) { return n.col; }).concat([0])) + 1;
    const maxRow = Math.max.apply(null, nodes.map(function (n) { return n.row; }).concat([0])) + 1;

    return {
      nodes: nodes,
      edges: edges,
      pos: pos,
      width: PAD * 2 + cols * NODE_W + (cols - 1) * COL_GAP,
      height: PAD * 2 + maxRow * NODE_H + (maxRow - 1) * ROW_GAP
    };
  }

  /* ---------------- 描画 ---------------- */

  /**
   * 枝の線。ノードの箱は HTML で置くので、線だけを裏の SVG に描く。
   * 直線で結ぶと箱の上を横切って読めなくなるため、
   * 一度右へ出してから縦に降り、そこから左へ入る折れ線にしている。
   */
  function edgePath(a, b) {
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;

    /* 自分自身へ戻る枝は、右に出して上を回り込ませる */
    if (a.id === b.id) {
      const top = a.y - 10;
      return 'M' + x1 + ' ' + y1 +
             ' H' + (x1 + 24) + ' V' + top + ' H' + (a.x - 24) + ' V' + y1 + ' H' + a.x;
    }

    /* 前の列へ戻る枝は、下を回り込ませる */
    if (x2 <= x1) {
      const bottom = Math.max(a.y, b.y) + NODE_H + 12;
      return 'M' + x1 + ' ' + y1 +
             ' H' + (x1 + 20) + ' V' + bottom + ' H' + (x2 - 20) + ' V' + y2 + ' H' + x2;
    }

    const mid = x1 + (x2 - x1) / 2;
    return 'M' + x1 + ' ' + y1 + ' H' + mid + ' V' + y2 + ' H' + x2;
  }

  function edgeLayerHTML(plan) {
    const paths = plan.edges.map(function (e) {
      const a = plan.pos[e.from];
      const b = plan.pos[e.to];
      return '<path class="tree-edge tree-edge-' + e.result + '" d="' + edgePath(a, b) + '" ' +
             'marker-end="url(#tree-arrow-' + e.result + ')" />';
    }).join('');

    return '<svg class="tree-edges" width="' + plan.width + '" height="' + plan.height + '" ' +
             'aria-hidden="true">' +
             '<defs>' +
               '<marker id="tree-arrow-win" viewBox="0 0 10 10" refX="9" refY="5" ' +
                 'markerWidth="5" markerHeight="5" orient="auto-start-reverse">' +
                 '<path d="M0 0 L10 5 L0 10 z" fill="#35C6E8" /></marker>' +
               '<marker id="tree-arrow-loss" viewBox="0 0 10 10" refX="9" refY="5" ' +
                 'markerWidth="5" markerHeight="5" orient="auto-start-reverse">' +
                 '<path d="M0 0 L10 5 L0 10 z" fill="#FF4655" /></marker>' +
             '</defs>' + paths +
           '</svg>';
  }

  global.VCT_TREE = {
    RESULTS: RESULTS,
    NODE_W: NODE_W,
    NODE_H: NODE_H,
    ensure: ensure,
    nextOf: nextOf,
    setNext: setNext,
    hasBranches: hasBranches,
    layout: layout,
    edgeLayerHTML: edgeLayerHTML,
    esc: esc
  };
})(window);

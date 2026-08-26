/* =========================================================
   MAP LAYOUTS — 簡易図（SCHEMATIC）
   ---------------------------------------------------------
   実寸のミニマップではなく、「サイトがどの位置関係にあるか」を
   戦術ボード上で即座に読めるようにするための簡略図。
   座標は 0-100 の正規化空間、y=0 が上（ディフェンダー側）。

   公式ミニマップに差し替えたい場合は tools/fetch-assets.mjs を
   実行すると MINIMAP に画像が入り、そちらが優先される。
   ========================================================= */
(function (global) {
  'use strict';

  /* fetch-assets.mjs が { mapId: 'data:image/webp;base64,...' } を書き込む */
  const MINIMAP = {};

  const N = function (x, y) { return { x: x, y: y }; };

  const LAYOUTS = {
    ascent: {
      atk: N(50, 90), def: N(50, 10),
      sites: { A: N(78, 34), B: N(22, 34) }, mid: N(50, 56),
      lanes: [['atk', 'A'], ['atk', 'mid'], ['atk', 'B'], ['mid', 'A'], ['mid', 'B'], ['def', 'A'], ['def', 'B'], ['def', 'mid']]
    },
    bind: {
      atk: N(50, 90), def: N(50, 12),
      sites: { A: N(24, 36), B: N(76, 36) }, mid: null,
      lanes: [['atk', 'A'], ['atk', 'B'], ['def', 'A'], ['def', 'B']],
      links: [['A', 'B']]   /* テレポーター */
    },
    haven: {
      atk: N(50, 90), def: N(50, 10),
      sites: { A: N(82, 32), B: N(50, 30), C: N(18, 32) }, mid: N(50, 58),
      lanes: [['atk', 'A'], ['atk', 'mid'], ['atk', 'C'], ['mid', 'B'], ['mid', 'A'], ['mid', 'C'], ['def', 'A'], ['def', 'B'], ['def', 'C']]
    },
    split: {
      atk: N(50, 90), def: N(50, 12),
      sites: { A: N(76, 32), B: N(24, 34) }, mid: N(50, 52),
      lanes: [['atk', 'A'], ['atk', 'mid'], ['atk', 'B'], ['mid', 'A'], ['mid', 'B'], ['def', 'A'], ['def', 'B']]
    },
    icebox: {
      atk: N(50, 90), def: N(50, 12),
      sites: { A: N(26, 32), B: N(76, 34) }, mid: N(50, 56),
      lanes: [['atk', 'A'], ['atk', 'mid'], ['atk', 'B'], ['mid', 'A'], ['mid', 'B'], ['def', 'A'], ['def', 'B']]
    },
    breeze: {
      atk: N(50, 90), def: N(50, 12),
      sites: { A: N(80, 32), B: N(20, 34) }, mid: N(50, 58),
      lanes: [['atk', 'A'], ['atk', 'mid'], ['atk', 'B'], ['mid', 'A'], ['mid', 'B'], ['def', 'A'], ['def', 'B']]
    },
    fracture: {
      /* アタッカーが両側から挟み込む特殊構造 */
      atk: N(12, 84), atk2: N(88, 84), def: N(50, 26),
      sites: { A: N(80, 46), B: N(20, 46) }, mid: null,
      lanes: [['atk', 'B'], ['atk2', 'A'], ['atk', 'A'], ['atk2', 'B'], ['def', 'A'], ['def', 'B']]
    },
    pearl: {
      atk: N(50, 90), def: N(50, 12),
      sites: { A: N(24, 32), B: N(76, 34) }, mid: N(50, 56),
      lanes: [['atk', 'A'], ['atk', 'mid'], ['atk', 'B'], ['mid', 'A'], ['mid', 'B'], ['def', 'A'], ['def', 'B']]
    },
    lotus: {
      atk: N(50, 90), def: N(50, 10),
      sites: { A: N(18, 32), B: N(50, 28), C: N(82, 32) }, mid: N(50, 58),
      lanes: [['atk', 'A'], ['atk', 'mid'], ['atk', 'C'], ['mid', 'B'], ['mid', 'A'], ['mid', 'C'], ['def', 'A'], ['def', 'B'], ['def', 'C']]
    },
    sunset: {
      atk: N(50, 90), def: N(50, 12),
      sites: { A: N(26, 32), B: N(76, 34) }, mid: N(50, 56),
      lanes: [['atk', 'A'], ['atk', 'mid'], ['atk', 'B'], ['mid', 'A'], ['mid', 'B'], ['def', 'A'], ['def', 'B']]
    },
    abyss: {
      atk: N(50, 90), def: N(50, 12),
      sites: { A: N(26, 30), B: N(74, 32) }, mid: N(50, 58),
      lanes: [['atk', 'A'], ['atk', 'mid'], ['atk', 'B'], ['mid', 'A'], ['mid', 'B'], ['def', 'A'], ['def', 'B']]
    },
    corrode: {
      atk: N(50, 90), def: N(50, 12),
      sites: { A: N(26, 32), B: N(74, 32) }, mid: N(50, 56),
      lanes: [['atk', 'A'], ['atk', 'mid'], ['atk', 'B'], ['mid', 'A'], ['mid', 'B'], ['def', 'A'], ['def', 'B']]
    },
    summit: {
      /* 横に広い 3 レーン構成。サイトが狭くミッドの攻防が中心になる。
         A / ミッド / B に「展開可能な壁」があり、ラウンド中に射線と経路が変わる。 */
      atk: N(50, 90), def: N(50, 12),
      sites: { A: N(84, 36), B: N(16, 36) }, mid: N(50, 52),
      lanes: [['atk', 'A'], ['atk', 'mid'], ['atk', 'B'], ['mid', 'A'], ['mid', 'B'], ['def', 'A'], ['def', 'B'], ['def', 'mid']],
      gates: [N(70, 44), N(50, 34), N(30, 44)]
    }
  };

  function nodeOf(layout, key) {
    if (key === 'atk') return layout.atk;
    if (key === 'atk2') return layout.atk2;
    if (key === 'def') return layout.def;
    if (key === 'mid') return layout.mid;
    return layout.sites[key] || null;
  }

  /**
   * マップの簡易図を SVG 文字列で返す。
   * @param {Object} opts { map, highlight, side, size }
   *   highlight … 'A' | 'B' | 'C' | 'MID' | '-'
   *   side      … 'ATK' | 'DEF'（進行方向の矢印の向きに使う）
   */
  function render(opts) {
    const id = opts.map;
    const layout = LAYOUTS[id];
    if (!layout) return '';

    const size = opts.size || 150;
    const highlight = String(opts.highlight || '').toUpperCase();
    const side = opts.side === 'DEF' ? 'DEF' : 'ATK';
    const parts = [];

    /* 通路 */
    layout.lanes.forEach(function (lane) {
      const a = nodeOf(layout, lane[0]);
      const b = nodeOf(layout, lane[1]);
      if (!a || !b) return;
      const hot = highlight && (lane[0] === highlight || lane[1] === highlight ||
                                (highlight === 'MID' && (lane[0] === 'mid' || lane[1] === 'mid')));
      parts.push('<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y +
                 '" class="ml-lane' + (hot ? ' is-hot' : '') + '" />');
    });

    /* テレポーターなどの特殊接続 */
    (layout.links || []).forEach(function (link) {
      const a = nodeOf(layout, link[0]);
      const b = nodeOf(layout, link[1]);
      if (!a || !b) return;
      parts.push('<path d="M' + a.x + ' ' + a.y + ' Q 50 8 ' + b.x + ' ' + b.y + '" class="ml-link" />');
    });

    /* 展開可能な壁（ラウンド中に射線が変わる箇所） */
    (layout.gates || []).forEach(function (g) {
      parts.push('<line x1="' + (g.x - 5) + '" y1="' + g.y + '" x2="' + (g.x + 5) + '" y2="' + g.y +
                 '" class="ml-gate" />');
    });

    /* ミッド */
    if (layout.mid) {
      const hot = highlight === 'MID';
      parts.push('<circle cx="' + layout.mid.x + '" cy="' + layout.mid.y + '" r="6" class="ml-mid' + (hot ? ' is-hot' : '') + '" />');
      parts.push('<text x="' + layout.mid.x + '" y="' + (layout.mid.y + 2.6) + '" class="ml-mid-label">M</text>');
    }

    /* サイト */
    Object.keys(layout.sites).forEach(function (key) {
      const n = layout.sites[key];
      const hot = highlight === key;
      parts.push('<rect x="' + (n.x - 8) + '" y="' + (n.y - 8) + '" width="16" height="16" rx="2" ' +
                 'class="ml-site' + (hot ? ' is-hot' : '') + '" />');
      parts.push('<text x="' + n.x + '" y="' + (n.y + 3.4) + '" class="ml-site-label' + (hot ? ' is-hot' : '') + '">' + key + '</text>');
    });

    /* スポーン */
    [['atk', layout.atk], ['atk2', layout.atk2], ['def', layout.def]].forEach(function (pair) {
      const n = pair[1];
      if (!n) return;
      const isAtk = pair[0] !== 'def';
      parts.push('<circle cx="' + n.x + '" cy="' + n.y + '" r="4.5" class="ml-spawn ml-spawn-' +
                 (isAtk ? 'atk' : 'def') + (side === (isAtk ? 'ATK' : 'DEF') ? ' is-ours' : '') + '" />');
    });

    return '<svg class="map-fig" viewBox="0 0 100 100" width="' + size + '" height="' + size +
           '" role="img" aria-label="' + id + ' schematic">' +
             '<rect x="2" y="2" width="96" height="96" rx="4" class="ml-frame" />' +
             parts.join('') +
           '</svg>';
  }

  /* ---------------------------------------------------------
     公式ミニマップの向き
     ---------------------------------------------------------
     公式画像はマップごとに向きがばらばらで、縦に長いものも
     横に長いものもある。戦術を読むときに毎回向きを考え直すのは
     負担なので、ディフェンダースポーンが上・アタッカースポーンが下に
     なるよう、マップごとに時計回りの回転角を持たせて揃える。

     角度は画像から機械的に求めた。ボムサイトは必ずディフェンダー
     スポーン寄りにあるため、サイト（画像上で黄土色に塗られた領域）の
     重心から画像全体の重心へ向かう向きが、そのままアタッカー側を指す。
     その向きが真下になる角度を 90 度単位に丸めている。

     フラクチャーだけは例外。アタッカーが南北の両側から攻めるため
     「アタッカー側が下」に揃えようがなく、見慣れた向きのままにしている。
     --------------------------------------------------------- */
  const ROTATION = {
    abyss: 90,
    ascent: 90,
    bind: 0,
    breeze: 0,
    corrode: 90,
    fracture: 0,
    haven: 90,
    icebox: 270,
    lotus: 0,
    pearl: 0,
    split: 90,
    summit: 0,
    sunset: 0
  };

  function minimap(mapId) { return MINIMAP[mapId] || null; }
  function rotation(mapId) { return ROTATION[mapId] || 0; }
  function has(mapId) { return !!LAYOUTS[mapId]; }

  global.VCT_MAPS = {
    render: render, minimap: minimap, rotation: rotation, has: has,
    LAYOUTS: LAYOUTS, MINIMAP: MINIMAP, ROTATION: ROTATION
  };
})(window);

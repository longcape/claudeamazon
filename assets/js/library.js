/* =========================================================
   TACTIC LIBRARY — 定石ライブラリの読み出し
   ---------------------------------------------------------
   データ本体は tactics-library.js（自動生成）。ここはそれを
   「いまのマップ・いまのデッキ」に合わせて切り出すだけで、
   DOM も保存も触らない。

   載っているのは競技シーンで実際に使われている型を調べたもので、
   勝てる保証ではない。パッチで古くなるので、確認したパッチを
   必ず一緒に出す（画面側の仕事）。
   ========================================================= */
(function (global) {
  'use strict';

  const DATA = global.VCT_LIBRARY || { patch: '', checkedAt: '', pool: [], maps: {} };

  /* データに無い言語は英語へ落とす（i18n の t() と同じ順） */
  function pick(obj, lang) {
    const src = obj || {};
    return src[lang] || src.en || src.ja || '';
  }

  function forMap(mapId) {
    return Array.isArray(DATA.maps[mapId]) ? DATA.maps[mapId] : [];
  }

  function has(mapId) { return forMap(mapId).length > 0; }

  /* デッキに入れる形へ直す。
     ライブラリ側の key や id は持ち込まない（store が採番する）。
     盤面は必ず複製する。同じ配列を渡すと、取り込んだ先で動かしたマークが
     ライブラリ側にも書き戻ってしまう。 */
  function toPayload(item, lang) {
    const payload = {
      name: pick(item.name, lang),
      note: pick(item.note, lang),
      side: item.side,
      site: item.site,
      kind: item.kind
    };
    if (Array.isArray(item.phases) && item.phases.length) {
      payload.phases = JSON.parse(JSON.stringify(item.phases));
    }
    return payload;
  }

  /* すでにデッキにあるか。取り込んだあと名前を変えたものは別物として扱う
     （勝手に同一視すると、書き換えた戦術が「追加済み」に見えて足せなくなる）。
     言語を切り替えたあとでも当たるよう、全言語の名前で見る。 */
  function isAdded(item, tactics) {
    const names = ['ja', 'en', 'ko'].map(function (l) { return (item.name || {})[l]; }).filter(Boolean);
    return (tactics || []).some(function (t) {
      return t.side === item.side && names.indexOf(t.name) >= 0;
    });
  }

  /* デッキに足りない型。
     「ライブラリにはあるのに、デッキにそのサイド × 戦術タイプが 1 つも無い」ものを返す。
     何が足りないかの基準を自前で決めず、実際に使われている型の有無だけで見ている。 */
  function gaps(mapId, tactics) {
    const have = {};
    (tactics || []).forEach(function (t) {
      const sides = t.side === 'BOTH' ? ['ATK', 'DEF'] : [t.side];
      sides.forEach(function (s) { have[s + ':' + t.kind] = true; });
    });
    const out = [];
    const seen = {};
    forMap(mapId).forEach(function (item) {
      const id = item.side + ':' + item.kind;
      if (have[id] || seen[id]) return;
      seen[id] = true;
      out.push({ side: item.side, kind: item.kind });
    });
    return out;
  }

  /* 画面の絞り込み。一覧の表示と「表示中をすべて追加」が同じ結果を使うよう、ここ 1 か所に置く
     （別々に書くと、見えていないものまで追加される食い違いが起きる） */
  function filter(list, f, lang) {
    const words = String(f.query || '').toLowerCase().split(/\s+/).filter(Boolean);
    return (list || []).filter(function (it) {
      if (!((f.side === 'ALL' || it.side === f.side) &&
            (!f.kind || it.kind === f.kind) &&
            (f.level === 'ALL' || it.lv === f.level))) return false;
      /* 確認したラウンド数。1 ラウンドだけのものと、2 ラウンド以上で見えたものは重みが違う */
      if (f.rounds === 'ONE' && roundsOf(it) !== 1) return false;
      if (f.rounds === 'MULTI' && roundsOf(it) < 2) return false;
      if (!words.length) return true;
      /* 検索は、いま見ている言語の名前・説明に加えて、サイト・戦術タイプ・証拠のチーム名にも当てる */
      const hay = [pick(it.name, lang), pick(it.note, lang), it.site, it.kind]
        .concat((it.proofs || []).map(function (p) { return p.team + ' ' + p.opp + ' ' + p.ev; }))
        .join(' ').toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) >= 0; });
    });
  }

  function roundsOf(item) { return Number(item && item.rounds) || 0; }

  DATA.filter = filter;
  DATA.roundsOf = roundsOf;
  DATA.pick = pick;
  DATA.forMap = forMap;
  DATA.has = has;
  DATA.toPayload = toPayload;
  DATA.isAdded = isAdded;
  DATA.gaps = gaps;
  global.VCT_LIBRARY = DATA;
})(window);

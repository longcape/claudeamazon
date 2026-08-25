/* =========================================================
   SHELF — ルームを「商品棚」として整える
   ---------------------------------------------------------
   高級品の隣に激安品を置くと購買心理が落ちる。ROOMは
   並びがそのまま棚として見えるので、投稿順の価格差は
   ブランドそのものになる。
   役割（評価取り/売上/送客）の並びは崩さずに、同じ役割の
   商品どうしを入れ替えて価格の段差だけを均す。
   ========================================================= */
'use strict';

function ratio(a, b) {
  const hi = Math.max(a, b);
  const lo = Math.max(1, Math.min(a, b));
  return hi / lo;
}

function violations(seq, cfg) {
  const out = [];
  for (let i = 1; i < seq.length; i += 1) {
    const r = ratio(seq[i - 1].price, seq[i].price);
    const jump = Math.abs(seq[i - 1].price - seq[i].price);
    if (r > cfg.maxAdjacentPriceRatio || jump > cfg.maxPriceJumpYen) {
      out.push({ at: i, ratio: Number(r.toFixed(2)), jump: jump, prev: seq[i - 1].price, next: seq[i].price });
    }
  }
  return out;
}

function cost(seq, cfg) {
  return violations(seq, cfg).reduce(function (a, v) {
    return a + 1 + Math.max(0, v.ratio - cfg.maxAdjacentPriceRatio);
  }, 0);
}

/* 同じ役割どうしの入れ替えだけで段差を均す。
   役割の並び（評価→売上）は絶対に触らない。 */
function smooth(seq, strategy) {
  const cfg = strategy.shelf;
  const work = seq.slice();
  let current = cost(work, cfg);
  const maxPasses = work.length * 4;

  for (let pass = 0; pass < maxPasses && current > 0; pass += 1) {
    const vs = violations(work, cfg);
    if (!vs.length) break;
    const target = vs[0].at;
    let improved = false;

    for (let j = 0; j < work.length; j += 1) {
      if (j === target || work[j].role !== work[target].role) continue;
      const trial = work.slice();
      const tmp = trial[target];
      trial[target] = trial[j];
      trial[j] = tmp;
      const c = cost(trial, cfg);
      if (c < current) {
        work[target] = trial[target];
        work[j] = trial[j];
        current = c;
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }

  return work.map(function (post, i) {
    return Object.assign({}, post, { order: i + 1 });
  });
}

function auditShelf(seq, strategy) {
  const cfg = strategy.shelf;
  const prices = seq.map(function (p) { return p.price; });
  const golden = strategy.goldenPrice;
  const inGolden = prices.filter(function (p) { return p >= golden.min && p <= golden.max; }).length;

  const subCount = {};
  seq.forEach(function (p) { subCount[p.primarySubTheme] = (subCount[p.primarySubTheme] || 0) + 1; });
  const maxShare = seq.length ? Math.max.apply(null, Object.values(subCount)) / seq.length : 0;

  const windows = [];
  for (let i = 0; i + cfg.priceWaveWindow <= prices.length; i += cfg.priceWaveWindow) {
    const w = prices.slice(i, i + cfg.priceWaveWindow);
    windows.push({ from: i + 1, min: Math.min.apply(null, w), max: Math.max.apply(null, w) });
  }

  const issues = [];
  const vs = violations(seq, cfg);
  vs.forEach(function (v) {
    issues.push({ at: v.at + 1, level: 'warn', message: v.prev + '円 の隣に ' + v.next + '円（' + v.ratio + '倍の段差）' });
  });
  if (maxShare > cfg.maxShareSingleSubTheme) {
    issues.push({ at: 0, level: 'warn', message: '単一サブテーマが全体の ' + Math.round(maxShare * 100) + '%（上限 ' + Math.round(cfg.maxShareSingleSubTheme * 100) + '%）' });
  }

  return {
    issues: issues,
    goldenRate: seq.length ? inGolden / seq.length : 0,
    priceRange: prices.length ? { min: Math.min.apply(null, prices), max: Math.max.apply(null, prices) } : null,
    subThemeShare: subCount,
    priceWindows: windows,
    violations: vs
  };
}

module.exports = { smooth, auditShelf, violations, cost };

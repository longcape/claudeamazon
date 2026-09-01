/* =========================================================
   SEQUENCE — 投稿の並び（導線設計）
   ---------------------------------------------------------
   関連商品を続けるとROOM内の比較・回遊を作りやすい、という
   攻略動画由来の仮説を検証する。楽天公式の内部仕様ではない。
   計画内では比較可能な〈入口＋成約候補〉の小単位を作る。

   パターン文字列を頭から消費していく方式だと、末尾で
   評価取りが尽きて売上が連続する事故が起きる。そこで先に
   〈評価取り＋売上〉のペアを確定させ、その隙間へ評価取り単発と
   送客を配る方式にする。これなら規則が構造的に壊れない。
   ========================================================= */
'use strict';

const log = require('../util/log');

function groupByRole(picked) {
  const q = { bait: [], cv: [], traffic: [] };
  picked.forEach(function (item) { (q[item.role] || q.bait).push(item); });
  Object.keys(q).forEach(function (r) {
    q[r].sort(function (a, b) { return b.roleScore - a.roleScore; });
  });
  return q;
}

/* 売上商品には、同じ棚（サブテーマ）の評価取りを充てる。
   直前に見せたものと地続きなほど、行動リズムがそのまま乗る。 */
function relationScore(a, b) {
  const ac = new Set(a.giftCollections || []);
  const ao = new Set(a.giftOccasions || []);
  let score = 0;
  (b.giftCollections || []).forEach(function (v) { if (ac.has(v)) score += 3; });
  (b.giftOccasions || []).forEach(function (v) { if (ao.has(v)) score += 2; });
  if (a.primarySubTheme && a.primarySubTheme === b.primarySubTheme) score += 1;
  return score;
}

function buildPairs(baits, cvs) {
  const pairs = [];
  const pool = baits.slice();

  /* 同じ棚の評価取りが少ない売上から先に相手を決める。
     後回しにすると、棚をまたいだ不自然なペアが増える。 */
  const supply = {};
  pool.forEach(function (b) { supply[b.primarySubTheme] = (supply[b.primarySubTheme] || 0) + 1; });
  const ordered = cvs.slice().sort(function (a, b) {
    return (supply[a.primarySubTheme] || 0) - (supply[b.primarySubTheme] || 0);
  });

  ordered.forEach(function (cv) {
    if (!pool.length) return;
    let idx = 0;
    let best = -1;
    pool.forEach(function (b, i) {
      const score = relationScore(b, cv);
      if (score > best) { best = score; idx = i; }
    });
    const bait = pool.splice(idx, 1)[0];
    pairs.push({ kind: 'pair', subTheme: cv.primarySubTheme, posts: [bait, cv] });
  });

  return { pairs: pairs, leftoverBaits: pool };
}

/* 同じサブテーマが続きすぎないように、ペアを棚ごとに束ねて回す */
function orderPairs(pairs, maxRun) {
  const bySub = new Map();
  pairs.forEach(function (p) {
    const k = p.subTheme || '_none';
    if (!bySub.has(k)) bySub.set(k, []);
    bySub.get(k).push(p);
  });

  const perRun = Math.max(1, Math.floor(maxRun / 2));
  const out = [];
  let lastSub = null;

  while (out.length < pairs.length) {
    /* 残りが多い棚から出す。直前と同じ棚は、連続上限まではむしろ続けたい */
    const keys = Array.from(bySub.keys()).filter(function (k) { return bySub.get(k).length > 0; });
    if (!keys.length) break;
    keys.sort(function (a, b) { return bySub.get(b).length - bySub.get(a).length; });

    let sub = keys[0];
    if (sub === lastSub && keys.length > 1) sub = keys[1];

    const bucket = bySub.get(sub);
    const take = Math.min(perRun, bucket.length);
    for (let i = 0; i < take; i += 1) out.push(bucket.shift());
    lastSub = sub;
  }
  return out;
}

/* singles[from..] のうち、前後の棚と違うものを先頭へ入れ替えて取り出す */
function takeDivider(singles, from, avoidA, avoidB) {
  for (let i = from; i < singles.length; i += 1) {
    const sub = singles[i].subTheme;
    if (sub !== avoidA && sub !== avoidB) {
      const tmp = singles[from];
      singles[from] = singles[i];
      singles[i] = tmp;
      break;
    }
  }
  return singles[from];
}

function arrange(picked, strategy) {
  const cfg = strategy.sequence;
  const q = groupByRole(picked);
  const built = buildPairs(q.bait, q.cv);
  const pairs = orderPairs(built.pairs, cfg.maxSameSubThemeRun);
  const singles = built.leftoverBaits.map(function (b) {
    return { kind: 'bait', subTheme: b.primarySubTheme, posts: [b] };
  });
  const traffic = q.traffic.map(function (t) {
    return { kind: 'traffic', subTheme: t.primarySubTheme, posts: [t] };
  });

  /* 評価取り単発は、ペアの前に均等に差し込んで評価を貯めてから売る。
     送客投稿はペアの切れ目にだけ入れ、評価→売上の対を割らない。 */
  const units = [];
  const baitEvery = singles.length ? Math.max(1, Math.round(pairs.length / (singles.length + 1))) : 0;
  let sinceTraffic = 0;
  let singleIdx = 0;
  let trafficIdx = 0;

  pairs.forEach(function (pair, i) {
    if (baitEvery && singleIdx < singles.length && i > 0 && i % baitEvery === 0) {
      /* 単発の評価取りは棚の切れ目に置く。前後のペアと違う棚のものを選ぶと、
         同一サブテーマの連続を伸ばさずに済む */
      const prevSub = units.length ? units[units.length - 1].subTheme : null;
      const divider = takeDivider(singles, singleIdx, prevSub, pair.subTheme);
      units.push(divider);
      sinceTraffic += 1;
      singleIdx += 1;
    }
    units.push(pair);
    sinceTraffic += 2;

    if (trafficIdx < traffic.length && sinceTraffic >= cfg.trafficEveryN) {
      units.push(takeDivider(traffic, trafficIdx, pair.subTheme, null));
      trafficIdx += 1;
      sinceTraffic = 0;
    }
  });

  /* 余りは末尾へ。評価取り→送客の順で置き、売上で終わらせない */
  while (singleIdx < singles.length) {
    const prevSub = units.length ? units[units.length - 1].subTheme : null;
    units.push(takeDivider(singles, singleIdx, prevSub, null));
    singleIdx += 1;
  }
  while (trafficIdx < traffic.length) {
    const prevSub = units.length ? units[units.length - 1].subTheme : null;
    units.push(takeDivider(traffic, trafficIdx, prevSub, null));
    trafficIdx += 1;
  }

  const out = [];
  let currentSub = null;
  let run = 0;

  units.forEach(function (unit) {
    unit.posts.forEach(function (post) {
      if (post.primarySubTheme === currentSub) { run += 1; } else { currentSub = post.primarySubTheme; run = 1; }
      const prev = out[out.length - 1] || null;
      out.push(Object.assign({}, post, {
        order: out.length + 1,
        burstSubTheme: currentSub,
        burstIndex: run,
        /* 直前の投稿と同じ棚なら、紹介文で明示的に導線を張る */
        linkPrev: prev && relationScore(prev, post) > 0 ? prev.core : null
      }));
    });
  });

  if (out.length < picked.length) {
    /* 相手のいない売上投稿は並びに入れられない。黙って消すと
       選定数と投稿数が食い違って原因が分からなくなる */
    const dropped = picked.length - out.length;
    log.warn('売上投稿 ' + dropped + ' 件を並びから外しました（対になる評価取り投稿が足りません）。' +
      'strategy.json の mix で bait を cv 以上にしてください');
  }

  return out;
}

/* 並びが規則を満たしているかの検査 */
function auditSequence(seq, strategy) {
  const cfg = strategy.sequence;
  const issues = [];
  let run = 0;
  let prevSub = null;

  seq.forEach(function (post, i) {
    const prev = seq[i - 1];
    if (post.role === 'cv' && cfg.cvMustFollowBait) {
      if (!prev || prev.role !== 'bait') {
        issues.push({ at: post.order, level: 'error', message: '売上投稿が評価取り投稿の直後にない（直前: ' + (prev ? prev.role : 'なし') + '）' });
      }
    }
    if (post.primarySubTheme === prevSub) run += 1; else { run = 1; prevSub = post.primarySubTheme; }
    if (run > cfg.maxSameSubThemeRun) {
      issues.push({ at: post.order, level: 'warn', message: '同一サブテーマが ' + run + ' 連続（上限 ' + cfg.maxSameSubThemeRun + '）' });
    }
  });

  const cvCount = seq.filter(function (p) { return p.role === 'cv'; }).length;
  const cvAfterBait = seq.filter(function (p, i) { return p.role === 'cv' && i > 0 && seq[i - 1].role === 'bait'; }).length;
  return {
    issues: issues,
    cvCount: cvCount,
    cvAfterBaitRate: cvCount ? cvAfterBait / cvCount : 1,
    roleCounts: seq.reduce(function (a, p) { a[p.role] = (a[p.role] || 0) + 1; return a; }, {})
  };
}

module.exports = { arrange, auditSequence, groupByRole, buildPairs, orderPairs, takeDivider, relationScore };

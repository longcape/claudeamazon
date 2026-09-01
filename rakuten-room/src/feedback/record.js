/* =========================================================
   FEEDBACK — 実績の記録と学習
   ---------------------------------------------------------
   「CV誘導・閲覧誘導・外部送客」は2026-01-07公開の攻略動画由来の
   仮説名であり、楽天公式が内部スコアとして公開した名称ではない。
   表示名は動画由来の仮説に対応する観測指標へ統一する。

     閲覧誘導 → ROOM反応観測    outboundClicks / postCount
     CV誘導   → 購買転換観測    confirmedConversions / outboundClicks（成熟投稿のみ）
     外部送客 → 楽天市場送客観測 uniqueOutboundUsers / postCount
                                取れなければ outboundClicks / postCount

   旧実装の誤りを2つ直している。

     clicks / likes を「閲覧率」と呼んでいた
       いいねはインプレッションの母数ではない。率ではない。
       補助比率としてだけ残し、閲覧率とは呼ばない。

     trafficClicks / allClicks を「外部送客量」と呼んでいた
       これは構成比であって量ではない。クリック総量が減っても
       送客役割の比率だけ上がれば数字が良く見えてしまう。

   さらに、成果の成熟を扱う。アフィリエイト成果はクリック後89日以内の
   購入まで発生しうるため、投稿直後の「成約0」は失敗ではなく
   観測期間が未成熟なだけである。30日未満の投稿をCV=0として
   学習へ入れると、直近投稿・遅延購入される商品・高価格商品を誤って減点する。
   ========================================================= */
'use strict';

const store = require('../util/store');
const T = require('../util/text');
const time = require('../util/time');

/* 旧フィールド。読み書きとも維持する */
const METRICS = ['likes', 'clicks', 'conversions', 'revenue'];

const MATURITY = ['click_ready', 'cv_early', 'cv_mature', 'final'];

function load(strategy) {
  const raw = store.readJson('results.json', { entries: [] });
  if (!raw.entries) raw.entries = [];
  return strategy ? migrate(raw, strategy) : raw;
}

function priceBand(price, golden) {
  if (price < golden.min) return 'under';
  if (price <= golden.max) return 'golden';
  if (price <= golden.max * 2) return 'over';
  return 'high';
}

/* ---------- セッション日 ----------
   0時台の投稿は暦日では翌日だが、運用上は前夜の続きである。
   sessionCutoverHour より前の投稿は前日のセッションに紐づける。 */
function sessionDateOf(dateKey, timeJst, strategy) {
  const cut = ((strategy || {}).experiment || {}).sessionCutoverHour;
  const cutover = cut === undefined ? 4 : cut;
  const hour = Number(String(timeJst || '').split(':')[0]);
  if (!Number.isFinite(hour) || hour >= cutover) return dateKey;
  return time.addDaysToKey(dateKey, -1);
}

/* ---------- 成熟 ---------- */
function hoursBetween(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return (b - a) / 3600000;
}

function maturityOf(entry, asOfIso, strategy) {
  const cfg = (strategy || {}).maturity || {};
  const published = entry.publishedAt;
  if (!published) return 'click_ready';
  const hours = hoursBetween(published, asOfIso || new Date().toISOString());
  const days = hours / 24;
  if (days >= (cfg.finalDays || 89)) return 'final';
  if (days >= (cfg.cvMatureDays || 30)) return 'cv_mature';
  if (days >= (cfg.cvEarlyDays || 7)) return 'cv_early';
  return 'click_ready';
}

function isCvUsable(entry) {
  /* 30日未満はCV学習へ入れない。ただし確定CVが明示されていれば使える */
  if (entry.conversionsConfirmed !== undefined && entry.conversionsConfirmed !== null) return true;
  return entry.maturity === 'cv_mature' || entry.maturity === 'final';
}

/* ---------- migration ----------
   旧 results.json を壊さずに読む。旧フィールドは残したまま新形へ埋める。 */
function migrateEntry(e, strategy) {
  const out = Object.assign({}, e);

  if (out.schemaVersion === undefined) out.schemaVersion = 1;
  if (out.experimentId === undefined) out.experimentId = null;
  if (out.clusterId === undefined) out.clusterId = null;
  if (out.slotVariant === undefined) out.slotVariant = 'control';
  if (out.dataSource === undefined) out.dataSource = 'manual';

  if (out.publishedAt === undefined || out.publishedAt === null) {
    /* 旧データは date と timeJst しか持たない。JSTの投稿時刻から復元する */
    out.publishedAt = (out.date && out.timeJst)
      ? time.jstAt(out.date, out.timeJst).toISOString()
      : (out.recordedAt || null);
  }
  if (out.sessionDate === undefined) {
    out.sessionDate = sessionDateOf(out.date, out.timeJst, strategy);
  }
  if (out.observationAsOf === undefined) out.observationAsOf = out.recordedAt || null;

  /* 旧 clicks は外部送客クリックとして読み替える。旧データはこれしか無い */
  if (out.outboundClicks === undefined) out.outboundClicks = Number(out.clicks) || 0;
  if (out.uniqueOutboundUsers === undefined) out.uniqueOutboundUsers = null;

  if (out.conversionsConfirmed === undefined) {
    /* 旧 conversions が確定値か保留かは区別されていなかった。
       確定と断定できないので保留側へ寄せる。0件を確定0として
       学習へ入れると未成熟投稿を誤って減点する */
    out.conversionsConfirmed = null;
    out.conversionsPending = Number(out.conversions) || 0;
  }
  if (out.revenueConfirmed === undefined) {
    out.revenueConfirmed = null;
    out.revenuePending = Number(out.revenue) || 0;
  }

  out.maturity = maturityOf(out, out.observationAsOf, strategy);
  out.schemaVersion = 2;
  return out;
}

function migrate(data, strategy) {
  const before = (data.entries || []).filter(function (e) { return (e.schemaVersion || 1) < 2; }).length;
  const entries = (data.entries || []).map(function (e) { return migrateEntry(e, strategy); });
  return Object.assign({}, data, { entries: entries, migratedCount: before });
}

/* ---------- 記録 ---------- */
function record(plan, orders, metrics, strategy) {
  const data = load(strategy);
  const set = new Set(orders);
  const added = [];
  const asOf = metrics.asOf || new Date().toISOString();

  plan.posts.forEach(function (p) {
    if (!set.has(p.order)) return;
    const publishedAt = p.scheduledAt ||
      (p.date && p.timeJst ? time.jstAt(p.date, p.timeJst).toISOString() : asOf);

    const entry = {
      schemaVersion: 2,
      itemCode: p.itemCode,
      name: p.core,
      date: p.date,
      timeJst: p.timeJst,
      hour: Number(String(p.timeJst || '0:0').split(':')[0]),
      sessionDate: sessionDateOf(p.date, p.timeJst, strategy),
      role: p.role,
      subTheme: p.primarySubTheme,
      shopCode: p.shopCode,
      price: p.price,
      priceBand: priceBand(p.price, strategy.goldenPrice),
      planKind: plan.kind,
      experimentId: p.experimentId || plan.experimentId || null,
      clusterId: p.clusterId || null,
      slotVariant: p.slotVariant || 'control',
      publishedAt: publishedAt,
      observationAsOf: asOf,
      outboundClicks: Number(metrics.outboundClicks !== undefined ? metrics.outboundClicks : metrics.clicks) || 0,
      uniqueOutboundUsers: metrics.uniqueUsers === undefined ? null : Number(metrics.uniqueUsers),
      conversionsPending: Number(metrics.cvPending) || 0,
      conversionsConfirmed: metrics.cvConfirmed === undefined ? null : Number(metrics.cvConfirmed),
      revenuePending: Number(metrics.revenuePending) || 0,
      revenueConfirmed: metrics.revenueConfirmed === undefined ? null : Number(metrics.revenueConfirmed),
      dataSource: metrics.dataSource || 'manual',
      recordedAt: new Date().toISOString()
    };
    /* 旧フィールドも埋めておく。既存の集計や外部の読み手を壊さない */
    entry.likes = Number(metrics.likes) || 0;
    entry.clicks = entry.outboundClicks;
    entry.conversions = entry.conversionsConfirmed !== null
      ? entry.conversionsConfirmed : entry.conversionsPending;
    entry.revenue = entry.revenueConfirmed !== null
      ? entry.revenueConfirmed : entry.revenuePending;

    entry.maturity = maturityOf(entry, asOf, strategy);

    const idx = data.entries.findIndex(function (e) {
      return e.itemCode === entry.itemCode && e.date === entry.date;
    });
    if (idx >= 0) data.entries[idx] = entry; else data.entries.push(entry);
    added.push(entry);
  });

  data.updatedAt = new Date().toISOString();
  store.writeJson('results.json', { entries: data.entries, updatedAt: data.updatedAt });
  return added;
}

function safeRate(num, den) { return den > 0 ? num / den : 0; }

/* ---------- 観測指標 ----------
   動画由来の3仮説に対応する観測値。楽天公式の内部スコアではない。 */
const OBSERVATION_NOTE = '動画由来の仮説に対応する観測値。楽天公式の内部スコアではない。';

function observations(entries, strategy) {
  const posts = entries.length;
  const sum = function (key, filter) {
    return entries.filter(filter || function () { return true; })
      .reduce(function (a, e) { return a + (Number(e[key]) || 0); }, 0);
  };

  const outbound = sum('outboundClicks');
  const likes = sum('likes');

  /* unique users は取れないことがある。取れた投稿だけで割ると
     母数が変わって比較にならないので、全投稿で取れている場合のみ使う */
  const withUnique = entries.filter(function (e) {
    return e.uniqueOutboundUsers !== null && e.uniqueOutboundUsers !== undefined;
  });
  const uniqueAvailable = posts > 0 && withUnique.length === posts;
  const uniqueUsers = sum('uniqueOutboundUsers', function (e) {
    return e.uniqueOutboundUsers !== null && e.uniqueOutboundUsers !== undefined;
  });

  /* 購買転換は成熟した投稿だけを母集団にする */
  const mature = entries.filter(isCvUsable);
  const matureClicks = mature.reduce(function (a, e) { return a + (Number(e.outboundClicks) || 0); }, 0);
  const confirmedCv = mature.reduce(function (a, e) {
    return a + (Number(e.conversionsConfirmed) || 0);
  }, 0);

  return {
    note: OBSERVATION_NOTE,
    postCount: posts,
    ROOM反応観測: {
      value: safeRate(outbound, posts),
      label: '外部クリック/投稿',
      outboundClicks: outbound,
      参考_いいね毎投稿: Number(safeRate(likes, posts).toFixed(2)),
      /* いいねはインプレッション母数ではないので閲覧率とは呼ばない */
      補助_クリック対いいね比: likes > 0 ? Number(safeRate(outbound, likes).toFixed(3)) : null
    },
    楽天市場送客観測: {
      value: uniqueAvailable ? safeRate(uniqueUsers, posts) : safeRate(outbound, posts),
      label: uniqueAvailable ? 'ユニーク送客者/投稿' : '外部クリック/投稿（ユニーク数を取得できないため代替）',
      uniqueAvailable: uniqueAvailable,
      uniqueOutboundUsers: uniqueAvailable ? uniqueUsers : null
    },
    購買転換観測: {
      value: safeRate(confirmedCv, matureClicks),
      label: '確定成約/外部クリック（成熟投稿のみ）',
      maturePosts: mature.length,
      matureClicks: matureClicks,
      confirmedConversions: confirmedCv,
      immaturePosts: posts - mature.length
    },
    売上金額: {
      confirmed: sum('revenueConfirmed'),
      pending: sum('revenuePending')
    }
  };
}

/* 後方互換。古い呼び出しが落ちないよう観測指標へ委譲する */
function hiddenScores(entries, strategy) {
  return observations(entries, strategy);
}

/* ---------- 次元別の成績 ---------- */
function dimensionStats(entries, dimension) {
  const buckets = new Map();
  entries.forEach(function (e) {
    const k = String(e[dimension]);
    const b = buckets.get(k) || { n: 0, clicks: 0, conversions: 0, likes: 0, revenue: 0, mature: 0 };
    b.n += 1;
    b.clicks += Number(e.outboundClicks) || 0;
    b.likes += Number(e.likes) || 0;
    b.revenue += Number(e.revenueConfirmed) || 0;
    if (isCvUsable(e)) {
      b.mature += 1;
      b.conversions += Number(e.conversionsConfirmed) || 0;
    }
    buckets.set(k, b);
  });

  const overall = { clicks: 0, conversions: 0, n: 0, mature: 0 };
  buckets.forEach(function (b) {
    overall.clicks += b.clicks; overall.conversions += b.conversions;
    overall.n += b.n; overall.mature += b.mature;
  });
  const meanClicks = safeRate(overall.clicks, overall.n);
  const meanCv = safeRate(overall.conversions, overall.mature);

  const out = {};
  buckets.forEach(function (b, k) {
    const perPostClicks = safeRate(b.clicks, b.n);
    const perMatureCv = safeRate(b.conversions, b.mature);
    out[k] = {
      n: b.n,
      mature: b.mature,
      clicksPerPost: Number(perPostClicks.toFixed(2)),
      cvPerMaturePost: Number(perMatureCv.toFixed(3)),
      clickIndex: meanClicks > 0 ? Number((perPostClicks / meanClicks).toFixed(2)) : 1,
      cvIndex: meanCv > 0 ? Number((perMatureCv / meanCv).toFixed(2)) : 1
    };
  });
  return out;
}

/* ---------- 学習ゲート ----------
   「6件で学習開始」は少なすぎた。サンプルが足りないときは
   数値を出してよいが、重みは動かさない。 */
function learningGate(entries, strategy) {
  const cfg = (strategy || {}).learning || {};
  const total = entries.length;
  const mature = entries.filter(isCvUsable).length;

  const slotCounts = {};
  entries.forEach(function (e) {
    const k = e.slotVariant || 'control';
    slotCounts[k] = (slotCounts[k] || 0) + 1;
  });

  const reasons = [];
  const clickReady = total >= (cfg.minTotalPosts || 24);
  if (!clickReady) reasons.push('全体 ' + total + '/' + (cfg.minTotalPosts || 24) + ' 投稿');

  const cvReady = mature >= (cfg.minMatureForCv || 30);
  if (!cvReady) reasons.push('成熟投稿 ' + mature + '/' + (cfg.minMatureForCv || 30) + ' 件');

  const slotReady = Object.keys(slotCounts).length >= 2 &&
    Object.keys(slotCounts).every(function (k) {
      return k === 'control' || slotCounts[k] >= (cfg.minPerSlotForWinner || 12);
    });

  return {
    clickLearning: clickReady,
    cvLearning: cvReady,
    slotWinner: slotReady,
    totalPosts: total,
    maturePosts: mature,
    slotCounts: slotCounts,
    reasons: reasons
  };
}

/* ---------- スコアへの反映 ---------- */
function applyFeedback(scored, strategy) {
  const data = load(strategy);
  const entries = data.entries;
  const gate = learningGate(entries, strategy);

  if (!gate.clickLearning) {
    return {
      applied: false,
      gate: gate,
      reason: 'サンプル不足のため重みは変更しない（' + gate.reasons.join(' / ') + '）'
    };
  }

  const cfg = strategy.learning || {};
  const perRun = cfg.maxAdjustPerRun || 0.05;
  const cumulative = cfg.maxAdjustCumulative || 0.15;
  const minCell = cfg.minPerCell || 6;

  const sub = dimensionStats(entries, 'subTheme');
  const band = dimensionStats(entries, 'priceBand');
  const shop = dimensionStats(entries, 'shopCode');

  const factorOf = function (table, key, useCv) {
    const s = table[String(key)];
    if (!s || s.n < minCell) return 1;
    /* CVは成熟投稿が足りているときだけ混ぜる */
    const idx = (useCv && gate.cvLearning && s.mature >= (cfg.minPerCellCv || 5))
      ? (s.clickIndex + s.cvIndex) / 2
      : s.clickIndex;
    const raw = (idx - 1) * 0.25;
    /* 1回の変更幅は±5%まで */
    return 1 + Math.max(-perRun, Math.min(perRun, raw));
  };

  let moved = 0;
  scored.forEach(function (item) {
    const shopStat = shop[String(item.shopCode)];
    const shopFactor = (shopStat && shopStat.n >= (cfg.minShopPosts || 5))
      ? factorOf(shop, item.shopCode, true) : 1;

    const f = factorOf(sub, item.primarySubTheme, true)
      * factorOf(band, priceBand(item.price, strategy.goldenPrice), true)
      * shopFactor;
    /* 累積の上限も守る */
    const capped = Math.max(1 - cumulative, Math.min(1 + cumulative, f));
    if (Math.abs(capped - 1) < 0.005) return;
    item.feedbackFactor = Number(capped.toFixed(3));
    item.total = T.clamp01(item.total * capped);
    Object.keys(item.roles).forEach(function (r) { item.roles[r] = T.clamp01(item.roles[r] * capped); });
    item.reasons.push('実績学習 ×' + item.feedbackFactor);
    moved += 1;
  });

  scored.sort(function (a, b) { return b.total - a.total; });
  return { applied: true, gate: gate, entries: entries.length, adjusted: moved };
}

function summarize(strategy) {
  const data = load(strategy);
  const entries = data.entries;
  if (!entries.length) return { entries: 0, migrated: data.migratedCount || 0 };
  return {
    entries: entries.length,
    migrated: data.migratedCount || 0,
    observations: observations(entries, strategy),
    gate: learningGate(entries, strategy),
    maturity: MATURITY.reduce(function (a, m) {
      a[m] = entries.filter(function (e) { return e.maturity === m; }).length;
      return a;
    }, {}),
    bySubTheme: dimensionStats(entries, 'subTheme'),
    byRole: dimensionStats(entries, 'role'),
    byPriceBand: dimensionStats(entries, 'priceBand'),
    bySlotVariant: dimensionStats(entries, 'slotVariant'),
    bySessionDate: dimensionStats(entries, 'sessionDate'),
    byShop: dimensionStats(entries, 'shopCode')
  };
}

module.exports = {
  record, summarize, applyFeedback, observations, hiddenScores, dimensionStats,
  load, migrate, migrateEntry, maturityOf, isCvUsable, sessionDateOf, learningGate,
  METRICS, MATURITY, priceBand, OBSERVATION_NOTE
};

/* =========================================================
   FEEDBACK — 実績の記録と学習
   ---------------------------------------------------------
   楽天ROOMの内部スコア（CV誘導・閲覧誘導・外部送客）は
   外から読めない。読めない以上、こちらで代理指標を積む。
     閲覧誘導スコアの代理 = クリック / いいね
     CV誘導スコアの代理   = 成約 / クリック
     外部送客スコアの代理 = 送客投稿のクリック総量
   投稿ごとにこれを貯めると、どのサブテーマ・価格帯・時間帯・
   ショップが効いているかが数字で出る。次の選定に効かせる。
   ========================================================= */
'use strict';

const store = require('../util/store');
const T = require('../util/text');

const METRICS = ['likes', 'clicks', 'conversions', 'revenue'];

function load() {
  const r = store.readJson('results.json', { entries: [] });
  if (!r.entries) r.entries = [];
  return r;
}

function priceBand(price, golden) {
  if (price < golden.min) return 'under';
  if (price <= golden.max) return 'golden';
  if (price <= golden.max * 2) return 'over';
  return 'high';
}

function record(plan, orders, metrics, strategy) {
  const data = load();
  const set = new Set(orders);
  const added = [];

  plan.posts.forEach(function (p) {
    if (!set.has(p.order)) return;
    const entry = {
      itemCode: p.itemCode,
      name: p.core,
      date: p.date,
      timeJst: p.timeJst,
      hour: Number(p.timeJst.split(':')[0]),
      role: p.role,
      subTheme: p.primarySubTheme,
      shopCode: p.shopCode,
      price: p.price,
      priceBand: priceBand(p.price, strategy.goldenPrice),
      planKind: plan.kind,
      recordedAt: new Date().toISOString()
    };
    METRICS.forEach(function (m) { entry[m] = Number(metrics[m]) || 0; });
    /* 同じ投稿を再記録した場合は上書きする */
    const idx = data.entries.findIndex(function (e) { return e.itemCode === entry.itemCode && e.date === entry.date; });
    if (idx >= 0) data.entries[idx] = entry; else data.entries.push(entry);
    added.push(entry);
  });

  data.updatedAt = new Date().toISOString();
  store.writeJson('results.json', data);
  return added;
}

function safeRate(num, den) { return den > 0 ? num / den : 0; }

/* 楽天ROOMの隠しスコア3種の代理指標 */
function hiddenScores(entries) {
  const sum = function (key, filter) {
    return entries.filter(filter || function () { return true; })
      .reduce(function (a, e) { return a + (e[key] || 0); }, 0);
  };
  const likes = sum('likes');
  const clicks = sum('clicks');
  const cv = sum('conversions');
  const trafficClicks = sum('clicks', function (e) { return e.role === 'traffic'; });

  return {
    閲覧誘導: { value: safeRate(clicks, likes), label: 'クリック/いいね', clicks: clicks, likes: likes },
    CV誘導: { value: safeRate(cv, clicks), label: '成約/クリック', conversions: cv, clicks: clicks },
    外部送客: { value: safeRate(trafficClicks, clicks), label: '送客投稿クリック比', trafficClicks: trafficClicks },
    売上金額: sum('revenue')
  };
}

/* 次元ごとの成績。全体平均に対する倍率で返す */
function dimensionStats(entries, dimension) {
  const buckets = new Map();
  entries.forEach(function (e) {
    const k = String(e[dimension]);
    const b = buckets.get(k) || { n: 0, clicks: 0, conversions: 0, likes: 0, revenue: 0 };
    b.n += 1;
    METRICS.forEach(function (m) { b[m] += e[m] || 0; });
    buckets.set(k, b);
  });

  const overall = { clicks: 0, conversions: 0, n: 0 };
  buckets.forEach(function (b) { overall.clicks += b.clicks; overall.conversions += b.conversions; overall.n += b.n; });
  const meanClicks = safeRate(overall.clicks, overall.n);
  const meanCv = safeRate(overall.conversions, overall.n);

  const out = {};
  buckets.forEach(function (b, k) {
    const perPostClicks = safeRate(b.clicks, b.n);
    const perPostCv = safeRate(b.conversions, b.n);
    out[k] = {
      n: b.n,
      clicksPerPost: Number(perPostClicks.toFixed(2)),
      cvPerPost: Number(perPostCv.toFixed(3)),
      /* 全体平均比。1.0が平均どおり */
      clickIndex: meanClicks > 0 ? Number((perPostClicks / meanClicks).toFixed(2)) : 1,
      cvIndex: meanCv > 0 ? Number((perPostCv / meanCv).toFixed(2)) : 1
    };
  });
  return out;
}

function summarize(strategy) {
  const data = load();
  const entries = data.entries;
  if (!entries.length) return { entries: 0 };
  return {
    entries: entries.length,
    hidden: hiddenScores(entries),
    bySubTheme: dimensionStats(entries, 'subTheme'),
    byRole: dimensionStats(entries, 'role'),
    byPriceBand: dimensionStats(entries, 'priceBand'),
    byHour: dimensionStats(entries, 'hour'),
    byShop: dimensionStats(entries, 'shopCode')
  };
}

/* 学習結果をスコアへ反映する。効いた棚を厚く、効かない棚を薄く。
   実績が薄いうちは動かさない（n>=3 を要求する）。 */
function applyFeedback(scored, strategy) {
  const data = load();
  if (data.entries.length < 6) return { applied: false, reason: '実績が少ないため学習は未適用（6件以上で有効）' };

  const sub = dimensionStats(data.entries, 'subTheme');
  const band = dimensionStats(data.entries, 'priceBand');
  const shop = dimensionStats(data.entries, 'shopCode');
  const maxAdjust = 0.15;

  const factorOf = function (table, key) {
    const s = table[String(key)];
    if (!s || s.n < 3) return 1;
    /* クリックとCVを半々で見る */
    const idx = (s.clickIndex + s.cvIndex) / 2;
    return 1 + Math.max(-maxAdjust, Math.min(maxAdjust, (idx - 1) * 0.25));
  };

  scored.forEach(function (item) {
    const f = factorOf(sub, item.primarySubTheme)
      * factorOf(band, priceBand(item.price, strategy.goldenPrice))
      * factorOf(shop, item.shopCode);
    if (Math.abs(f - 1) < 0.005) return;
    item.feedbackFactor = Number(f.toFixed(3));
    item.total = T.clamp01(item.total * f);
    Object.keys(item.roles).forEach(function (r) { item.roles[r] = T.clamp01(item.roles[r] * f); });
    item.reasons.push('実績学習 ×' + item.feedbackFactor);
  });

  scored.sort(function (a, b) { return b.total - a.total; });
  return { applied: true, entries: data.entries.length };
}

module.exports = { record, summarize, applyFeedback, hiddenScores, dimensionStats, load, METRICS, priceBand };

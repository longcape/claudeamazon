/* =========================================================
   TREND — 上昇ワードの自動抽出
   ---------------------------------------------------------
   楽天は検索ボリュームを公開しない。代わりに
   「レビューが速く増えている商品の名前に共通して現れる語」
   を上昇ワードとみなす。売れている実物から語を逆算する。
   抽出結果は config/trend-words.json の auto.observed に
   溜め、手で rising に昇格させる（誤検出を混ぜないため）。
   ========================================================= */
'use strict';

const store = require('../util/store');
const time = require('../util/time');
const crosscheck = require('./crosscheck');

function observe(scored, strategy) {
  const stats = new Map();

  scored.forEach(function (item) {
    const v = item.velocityInfo;
    const speed = v && v.known ? v.reviewsPerDay : null;
    const words = new Set(crosscheck.words(item.cleanName));
    words.forEach(function (w) {
      const s = stats.get(w) || { n: 0, speedSum: 0, speedN: 0, scoreSum: 0 };
      s.n += 1;
      s.scoreSum += item.total;
      if (speed !== null) { s.speedSum += speed; s.speedN += 1; }
      stats.set(w, s);
    });
  });

  const rows = [];
  stats.forEach(function (s, w) {
    if (s.n < 3) return;
    rows.push({
      word: w,
      count: s.n,
      avgScore: Number((s.scoreSum / s.n).toFixed(3)),
      avgReviewsPerDay: s.speedN ? Number((s.speedSum / s.speedN).toFixed(2)) : null,
      measured: s.speedN
    });
  });

  /* 速度が測れている語を優先し、次点でスコア平均で並べる */
  rows.sort(function (a, b) {
    const av = a.avgReviewsPerDay === null ? -1 : a.avgReviewsPerDay;
    const bv = b.avgReviewsPerDay === null ? -1 : b.avgReviewsPerDay;
    if (bv !== av) return bv - av;
    return b.avgScore - a.avgScore;
  });

  return rows;
}

function save(rows, limit) {
  const file = store.configPath('trend-words.json');
  const cfg = store.readJson(file, { rising: [], decaying: [], auto: { observed: {} } });
  if (!cfg.auto) cfg.auto = { observed: {} };

  const top = rows.slice(0, limit || 40);
  const observed = cfg.auto.observed || {};
  top.forEach(function (r) {
    const prev = observed[r.word] || { history: [] };
    prev.history = (prev.history || []).slice(-9);
    prev.history.push({ date: time.dateKey(), count: r.count, speed: r.avgReviewsPerDay, score: r.avgScore });
    prev.latest = r;
    observed[r.word] = prev;
  });
  cfg.auto.observed = observed;
  cfg.auto.updatedAt = new Date().toISOString();
  store.writeJson(file, cfg);
  return file;
}

/* 前回観測からの伸びが大きい語＝昇格候補 */
function risingCandidates(limit) {
  const cfg = store.readJson(store.configPath('trend-words.json'), { auto: { observed: {} } });
  const observed = (cfg.auto && cfg.auto.observed) || {};
  const already = new Set(cfg.rising || []);
  const out = [];

  Object.keys(observed).forEach(function (w) {
    if (already.has(w)) return;
    const h = observed[w].history || [];
    if (h.length < 2) return;
    const first = h[0];
    const last = h[h.length - 1];
    const growth = (last.count || 0) - (first.count || 0);
    const speed = last.speed || 0;
    out.push({ word: w, growth: growth, speed: speed, count: last.count, score: growth * 0.6 + speed * 2 });
  });

  out.sort(function (a, b) { return b.score - a.score; });
  return out.slice(0, limit || 15);
}

module.exports = { observe, save, risingCandidates };

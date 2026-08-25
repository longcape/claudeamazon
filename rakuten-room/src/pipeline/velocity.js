/* =========================================================
   VELOCITY — 売上速度の実測
   ---------------------------------------------------------
   「直近の売上が動いているか」は、楽天が数字で出してくれない。
   唯一外から観測できるのがレビュー件数の増え方で、これは
   ユーザーが言う「レビュー欄で売上スピードを確認する」を
   そのまま機械化したもの。定点観測の差分をとる。
   初回実行では差分が無いので unknown になる（2日目から効く）。
   ========================================================= */
'use strict';

const store = require('../util/store');
const time = require('../util/time');
const T = require('../util/text');

function loadSnapshots(windowDays) {
  const files = store.listData('snapshot-');
  const today = time.dateKey();
  return files.map(function (f) {
    const date = f.replace('snapshot-', '').replace('.json', '');
    return { date: date, file: f, ageDays: time.daysBetweenKeys(date, today) };
  }).filter(function (s) {
    return s.ageDays >= 0 && s.ageDays <= windowDays;
  }).sort(function (a, b) {
    return a.date < b.date ? -1 : 1;
  }).map(function (s) {
    s.data = store.readJson(s.file, { items: {} });
    return s;
  });
}

/* 商品ごとの { reviewsPerDay, days, priceDrop, pointJump } を作る */
function buildVelocityIndex(strategy) {
  const snaps = loadSnapshots(strategy.velocity.windowDays);
  const index = new Map();
  if (snaps.length < 2) return { index: index, snapshotCount: snaps.length, spanDays: 0 };

  const first = snaps[0];
  const last = snaps[snaps.length - 1];
  const spanDays = Math.max(1, time.daysBetweenKeys(first.date, last.date));

  Object.keys(last.data.items || {}).forEach(function (code) {
    const now = last.data.items[code];
    /* その商品を含む最も古いスナップショットを起点にする */
    let base = null;
    let baseDate = null;
    for (const s of snaps) {
      if (s.data.items && s.data.items[code]) { base = s.data.items[code]; baseDate = s.date; break; }
    }
    if (!base || baseDate === last.date) return;
    const days = Math.max(1, time.daysBetweenKeys(baseDate, last.date));
    const delta = (now.reviewCount || 0) - (base.reviewCount || 0);
    index.set(code, {
      reviewsPerDay: delta / days,
      reviewDelta: delta,
      days: days,
      priceDropRatio: base.price > 0 ? Math.max(0, (base.price - now.price) / base.price) : 0,
      pointJump: (now.pointRate || 1) - (base.pointRate || 1),
      rankImprove: base.rank && now.rank ? base.rank - now.rank : 0
    });
  });

  return { index: index, snapshotCount: snaps.length, spanDays: spanDays, from: first.date, to: last.date };
}

/* 0..1 のスコアへ。計測不能なら中庸の unknownScore を返し、
   「データが無いこと」を有利にも不利にもしすぎない。 */
function velocityScore(entry, cfg) {
  if (!entry) return { score: cfg.unknownScore, known: false, label: '未計測' };
  const rpd = entry.reviewsPerDay;
  let s = T.scale(rpd, 0, cfg.hotReviewsPerDay);
  /* 値引き・ポイント増は販促が動いた直後のサインで、売上速度の先行指標になる */
  if (entry.priceDropRatio > 0.05) s += 0.08;
  if (entry.pointJump >= 2) s += 0.10;
  if (entry.rankImprove > 0) s += 0.05;
  const label = rpd >= cfg.hotReviewsPerDay ? '加熱'
    : rpd >= cfg.goodReviewsPerDay ? '好調'
      : rpd > 0 ? '緩やか' : '停滞';
  return { score: T.clamp01(s), known: true, label: label, reviewsPerDay: Number(rpd.toFixed(2)), days: entry.days };
}

/* 保存期間を過ぎたスナップショットを消す */
function pruneSnapshots(strategy) {
  const fs = require('fs');
  const path = require('path');
  const today = time.dateKey();
  const removed = [];
  store.listData('snapshot-').forEach(function (f) {
    const date = f.replace('snapshot-', '').replace('.json', '');
    if (time.daysBetweenKeys(date, today) > strategy.velocity.snapshotKeepDays) {
      fs.unlinkSync(path.join(store.DATA_DIR, f));
      removed.push(f);
    }
  });
  return removed;
}

module.exports = { buildVelocityIndex, velocityScore, pruneSnapshots, loadSnapshots };

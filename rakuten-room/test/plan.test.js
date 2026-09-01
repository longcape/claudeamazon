'use strict';
require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const store = require('../src/util/store');
const shelf = require('../src/plan/shelf');
const schedule = require('../src/plan/schedule');
const sequence = require('../src/plan/sequence');
const feedback = require('../src/feedback/record');
const velocity = require('../src/pipeline/velocity');
const collect = require('../src/pipeline/collect');
const score = require('../src/pipeline/score');

const strategy = store.loadStrategy();

function post(price, role, sub) {
  return { price: price, role: role, primarySubTheme: sub || 'a', itemCode: 'c' + price + role, roleScore: 0.5, core: 'x' };
}

test('棚ならしが価格段差を減らす', function () {
  const seq = [post(1500, 'bait'), post(2900, 'cv'), post(900, 'bait'), post(1600, 'cv'), post(2800, 'bait'), post(1500, 'cv')];
  const before = shelf.cost(seq, strategy.shelf);
  const after = shelf.cost(shelf.smooth(seq, strategy), strategy.shelf);
  assert.ok(after <= before, '悪化した: ' + before + ' → ' + after);
});

test('棚ならしは役割の並びを壊さない', function () {
  const seq = [post(1500, 'bait'), post(2900, 'cv'), post(900, 'bait'), post(1600, 'cv')];
  const roles = shelf.smooth(seq, strategy).map(function (p) { return p.role; });
  assert.deepStrictEqual(roles, ['bait', 'cv', 'bait', 'cv']);
});

test('ハードフィルタが仕様どおりに弾く', function () {
  const f = strategy.filters;
  const base = { reviewAverage: 4.5, reviewCount: 500, price: 2000, availability: true, name: 'ふつうの商品' };
  assert.strictEqual(collect.passesHardFilter(base, f), null);
  assert.ok(collect.passesHardFilter(Object.assign({}, base, { reviewAverage: 3.9 }), f));
  assert.ok(collect.passesHardFilter(Object.assign({}, base, { reviewCount: 99 }), f));
  assert.ok(collect.passesHardFilter(Object.assign({}, base, { availability: false }), f));
  assert.ok(collect.passesHardFilter(Object.assign({}, base, { name: '訳あり 商品' }), f));
});

test('ゴールデン価格帯の適合度がピークで最大になる', function () {
  /* 価格帯は戦略で動く（キッチン収納の1980-2680円 → ギフトの2500-3500円）。
     値を直に書くと戦略変更のたびに落ちるので、設定から導いて検証する */
  const g = strategy.goldenPrice;
  const mid = Math.round((g.peakMin + g.peakMax) / 2);
  const peak = score.priceFitScore(mid, g);
  assert.strictEqual(peak, 1, 'ピーク帯の中央は最大値になる');
  assert.strictEqual(score.priceFitScore(g.peakMin, g), 1, 'ピーク帯の下端も最大値');
  assert.strictEqual(score.priceFitScore(g.peakMax, g), 1, 'ピーク帯の上端も最大値');
  assert.ok(score.priceFitScore(g.min, g) < peak, 'ゴールデン帯の下端はピークより低い');
  assert.ok(score.priceFitScore(g.max + 4000, g) < score.priceFitScore(g.max, g), '帯から離れるほど下がる');
  assert.ok(score.priceFitScore(100, g) >= 0, '極端に安くても0未満にはしない');
});

test('売上速度は計測できないとき中庸の値になる', function () {
  const unknown = velocity.velocityScore(null, strategy.velocity);
  assert.strictEqual(unknown.known, false);
  assert.strictEqual(unknown.score, strategy.velocity.unknownScore);

  const hot = velocity.velocityScore({ reviewsPerDay: 8, days: 5, priceDropRatio: 0, pointJump: 0, rankImprove: 0 }, strategy.velocity);
  assert.ok(hot.score > unknown.score);
  assert.strictEqual(hot.label, '加熱');
});

test('時間割はゴールデンタイムの外へはみ出さない', function () {
  const seq = [];
  for (let i = 0; i < 24; i += 1) seq.push(post(2000, i % 2 ? 'cv' : 'bait'));
  const posts = schedule.assignTimes(seq, strategy, { startDate: '2026-08-26', postsPerDay: 12, hotTimeOnly: true });
  posts.forEach(function (p) {
    const m = schedule.minutesOf(p.timeJst);
    assert.ok(m >= schedule.minutesOf('20:00') && m <= schedule.minutesOf('23:00'), p.timeJst);
  });
});

test('評価取りと売上のペアは日をまたいで分断されない', function () {
  const seq = [];
  for (let i = 0; i < 20; i += 1) seq.push(post(2000, i % 2 ? 'cv' : 'bait'));
  const posts = schedule.assignTimes(seq, strategy, { startDate: '2026-08-26', postsPerDay: 7 });
  posts.forEach(function (p, i) {
    if (p.role !== 'cv') return;
    const prev = posts[i - 1];
    assert.ok(prev && prev.role === 'bait' && prev.date === p.date, '#' + p.order + ' のペアが分断された');
  });
});

test('動画由来の3仮説に対応する観測指標が計算できる', function () {
  const entries = [
    { role: 'bait', likes: 100, clicks: 40, conversions: 0, revenue: 0 },
    { role: 'cv', likes: 60, clicks: 30, conversions: 3, revenue: 7000 },
    { role: 'traffic', likes: 40, clicks: 20, conversions: 1, revenue: 2000 }
  ];
  const h = feedback.hiddenScores(entries);
  assert.strictEqual(h.閲覧誘導.value, 90 / 200);
  assert.strictEqual(h.CV誘導.value, 4 / 90);
  assert.strictEqual(h.外部送客.value, 20 / 90);
  assert.strictEqual(h.売上金額, 9000);
});

test('関連コレクションを持つ商品がペアとして優先される', function () {
  const baitA = Object.assign(post(1200, 'bait', 'a'), { itemCode: 'ba', giftCollections: ['食べもの・スイーツ'] });
  const baitB = Object.assign(post(1300, 'bait', 'b'), { itemCode: 'bb', giftCollections: ['実用品・コスメ'] });
  const cv = Object.assign(post(3000, 'cv', 'x'), { itemCode: 'cv', giftCollections: ['実用品・コスメ'] });
  const pair = sequence.buildPairs([baitA, baitB], [cv]).pairs[0];
  assert.strictEqual(pair.posts[0].itemCode, 'bb');
});

test('価格帯の判定が境界で正しい', function () {
  const g = strategy.goldenPrice;
  assert.strictEqual(feedback.priceBand(g.min - 1, g), 'under');
  assert.strictEqual(feedback.priceBand(g.min, g), 'golden');
  assert.strictEqual(feedback.priceBand(g.max, g), 'golden');
  assert.strictEqual(feedback.priceBand(g.max + 1, g), 'over');
});

test('売上より評価取りが少ない場合でもペアの規則が破れない', function () {
  const picked = [];
  for (let i = 0; i < 4; i += 1) picked.push(Object.assign(post(2000, 'bait'), { itemCode: 'b' + i }));
  for (let i = 0; i < 9; i += 1) picked.push(Object.assign(post(2100, 'cv'), { itemCode: 'v' + i }));
  const seq = sequence.arrange(picked, strategy);
  const audit = sequence.auditSequence(seq, strategy);
  assert.strictEqual(audit.cvAfterBaitRate, 1, '評価取り不足でペアが崩れた');
  /* 相手のいない売上は並びから外れる。無理に出すほうが害が大きい */
  assert.strictEqual(audit.roleCounts.cv, 4);
});

test('一度提示した投稿は cron の再実行で二重に通知されない', function () {
  const queue = require('../src/post/queue');
  const now = new Date('2026-08-26T11:05:00Z');
  const plan = {
    kind: 'launch', startDate: '2026-08-26',
    posts: [
      { order: 1, scheduledAt: '2026-08-26T11:00:00Z' },
      { order: 2, scheduledAt: '2026-08-26T11:30:00Z' }
    ]
  };
  assert.strictEqual(queue.duePosts(plan, now, 90).length, 1);

  queue.markPresented(plan, [1]);
  assert.strictEqual(queue.duePosts(plan, now, 90).length, 0, '同じ投稿が再通知された');
  assert.strictEqual(queue.duePosts(plan, now, 90, { includeNotified: true }).length, 1);

  queue.markPosted(plan, [1], 'manual');
  assert.strictEqual(queue.duePosts(plan, now, 90, { includeNotified: true }).length, 0);
});

'use strict';
require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const store = require('../src/util/store');
const pipeline = require('../src/index');
const fixtures = require('./fixtures');
const time = require('../src/util/time');
const schedule = require('../src/plan/schedule');

const strategy = store.loadStrategy();
const START = '2026-08-26';

/* 楽天APIを叩かずに済むよう、収集済みの候補として置いておく */
store.writeJson('candidates-' + time.dateKey() + '.json', {
  date: time.dateKey(),
  genreId: strategy.genre.rootGenreId,
  items: fixtures.candidates(90)
});

async function buildLaunch(extra) {
  return pipeline.buildPlan(strategy, Object.assign({
    kind: 'launch',
    crosscheck: false,
    llm: false,
    startDate: START
  }, extra || {}));
}

test('初動プランがちょうど30件になる', async function () {
  const plan = await buildLaunch();
  assert.strictEqual(plan.posts.length, strategy.launch.size);
});

test('売上投稿は必ず評価取り投稿の直後に来る', async function () {
  const plan = await buildLaunch();
  plan.posts.forEach(function (p, i) {
    if (p.role !== 'cv') return;
    const prev = plan.posts[i - 1];
    assert.ok(prev && prev.role === 'bait',
      '#' + p.order + ' の売上投稿の直前が ' + (prev ? prev.role : 'なし'));
  });
});

test('初動は全件がゴールデンタイム(20-23時)に入る', async function () {
  const plan = await buildLaunch();
  plan.posts.forEach(function (p) {
    const m = schedule.minutesOf(p.timeJst);
    assert.ok(m >= schedule.minutesOf('20:00') && m <= schedule.minutesOf('23:00'),
      '#' + p.order + ' が ' + p.timeJst);
  });
});

test('ゴールデン価格帯が7割以上を占める', async function () {
  const plan = await buildLaunch();
  const g = strategy.goldenPrice;
  const inBand = plan.posts.filter(function (p) { return p.price >= g.min && p.price <= g.max; }).length;
  assert.ok(inBand / plan.posts.length >= 0.7, 'ゴールデン価格帯 ' + inBand + '/' + plan.posts.length);
});

test('同じ商品が二重に選ばれない / 同一ショップが上限を超えない', async function () {
  const plan = await buildLaunch();
  const codes = plan.posts.map(function (p) { return p.itemCode; });
  assert.strictEqual(new Set(codes).size, codes.length, '同じ商品が重複');

  const perShop = {};
  plan.posts.forEach(function (p) { perShop[p.shopCode] = (perShop[p.shopCode] || 0) + 1; });
  Object.keys(perShop).forEach(function (s) {
    assert.ok(perShop[s] <= strategy.filters.maxItemsPerShop, s + ' が ' + perShop[s] + ' 件');
  });
});

test('全投稿の紹介文がNG検査を通る', async function () {
  const plan = await buildLaunch();
  const bad = plan.posts.filter(function (p) { return !p.copyCheck.ok; });
  assert.strictEqual(bad.length, 0, JSON.stringify(bad.slice(0, 2).map(function (p) { return p.copyCheck.issues; })));
});

test('NG検査に停止項目が無い', async function () {
  const plan = await buildLaunch();
  assert.deepStrictEqual(plan.report.blockers, []);
  assert.ok(plan.report.score >= 70, '検査スコア ' + plan.report.score);
});

test('役割の比率が設定どおり', async function () {
  const plan = await buildLaunch();
  const counts = plan.posts.reduce(function (a, p) { a[p.role] = (a[p.role] || 0) + 1; return a; }, {});
  assert.deepStrictEqual(counts, strategy.launch.mix);
});

test('隣り合う投稿の価格差が棚を壊さない', async function () {
  const plan = await buildLaunch();
  const cfg = strategy.shelf;
  let bad = 0;
  for (let i = 1; i < plan.posts.length; i += 1) {
    const a = plan.posts[i - 1].price;
    const b = plan.posts[i].price;
    if (Math.max(a, b) / Math.min(a, b) > cfg.maxAdjacentPriceRatio) bad += 1;
  }
  assert.ok(bad <= 2, '価格段差 ' + bad + ' 箇所');
});

test('一度出した商品は次の計画で再登場しない', async function () {
  const first = await buildLaunch();
  const selectLib = require('../src/pipeline/select');
  selectLib.recordPosted(first.posts, START);

  const second = await pipeline.buildPlan(strategy, {
    kind: 'daily', crosscheck: false, llm: false, startDate: START, size: 10
  });
  const firstCodes = new Set(first.posts.map(function (p) { return p.itemCode; }));
  second.posts.forEach(function (p) {
    assert.ok(!firstCodes.has(p.itemCode), '重複投稿: ' + p.itemCode);
  });
});

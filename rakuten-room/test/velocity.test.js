/* 売上速度（velocity）の機構を固定するテスト。

   velocity は「レビュー件数の日次差分」を売れ行きの実測として使う軸で、
   重みは全11軸で最大（0.15）。ここが黙って0になると、スコアは
   ギフト適性と見た目だけで決まる別物になる。

   実運用では2日分の定点観測が要るため、実測は日をまたがないと得られない。
   このテストは「2日分そろったときに、差分が実際に計算され、
   総合点と順位へ反映されるか」だけを確かめる。 */
'use strict';
require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const store = require('../src/util/store');
const velocity = require('../src/pipeline/velocity');
const score = require('../src/pipeline/score');
const fixtures = require('./fixtures');

const strategy = store.loadStrategy();
const copyLexicon = require('../config/copy-lexicon.json');

/* 2日分のスナップショットを置く。差分はテスト用に作った値であり、
   実測値ではない。実測は日をまたいだ collect でしか得られない。 */
function writeSnapshots(items, deltas) {
  const day1 = {};
  const day2 = {};
  items.forEach(function (i, n) {
    day1[i.itemCode] = { reviewCount: i.reviewCount, reviewAverage: i.reviewAverage, price: i.price, pointRate: i.pointRate, rank: null };
    day2[i.itemCode] = { reviewCount: i.reviewCount + (deltas[n] || 0), reviewAverage: i.reviewAverage, price: i.price, pointRate: i.pointRate, rank: null };
  });
  store.writeJson('snapshot-2026-08-20.json', { date: '2026-08-20', items: day1, capturedAt: '2026-08-20T12:00:00Z' });
  store.writeJson('snapshot-2026-08-21.json', { date: '2026-08-21', items: day2, capturedAt: '2026-08-21T12:00:00Z' });
}

function clearSnapshots() {
  store.listData('snapshot-').forEach(function (f) {
    require('fs').unlinkSync(require('path').join(store.DATA_DIR, f));
  });
}

test('スナップショットが1日分だと売上速度は未計測になる', function () {
  clearSnapshots();
  const items = fixtures.candidates(5);
  const one = {};
  items.forEach(function (i) { one[i.itemCode] = { reviewCount: i.reviewCount, price: i.price, pointRate: 1, rank: null }; });
  store.writeJson('snapshot-2026-08-20.json', { date: '2026-08-20', items: one });

  const v = velocity.buildVelocityIndex(strategy);
  assert.strictEqual(v.snapshotCount, 1);
  assert.strictEqual(v.index.size, 0, '差分の取りようがないので空になる');

  const unknown = velocity.velocityScore(undefined, strategy.velocity);
  assert.strictEqual(unknown.known, false);
  assert.strictEqual(unknown.score, strategy.velocity.unknownScore,
    '未計測は0ではなく中庸の値。データが無いことを不利にしすぎない');
  clearSnapshots();
});

test('2日分そろうとレビュー件数の差分から速度が計算される', function () {
  clearSnapshots();
  const items = fixtures.candidates(10);
  /* 先頭3件だけ伸びる。残りは動かない */
  writeSnapshots(items, [30, 12, 5, 0, 0, 0, 0, 0, 0, 0]);

  const v = velocity.buildVelocityIndex(strategy);
  assert.strictEqual(v.snapshotCount, 2);
  assert.strictEqual(v.index.size, 10, '全商品に差分が付く');

  const moved = [...v.index.values()].filter(function (x) { return x.reviewDelta > 0; });
  assert.strictEqual(moved.length, 3, '実際に伸びたのは3件');

  const head = v.index.get(items[0].itemCode);
  assert.strictEqual(head.reviewDelta, 30);
  assert.strictEqual(head.days, 1);
  assert.strictEqual(head.reviewsPerDay, 30);

  const still = v.index.get(items[9].itemCode);
  assert.strictEqual(still.reviewDelta, 0);
  assert.strictEqual(still.reviewsPerDay, 0,
    '伸びていない商品は0。これは欠測ではなく実測の0');
  clearSnapshots();
});

test('速度の差が総合点と順位へ反映される', function () {
  clearSnapshots();
  const items = fixtures.candidates(12);
  const deltas = items.map(function (_, n) { return n === 11 ? 40 : 0; });
  writeSnapshots(items, deltas);
  const v = velocity.buildVelocityIndex(strategy);

  /* 冷開始では velocity で順位差を作らない仕様なので、
     観測位相へ入る条件（既知率60%以上・スナップショット2日以上）を満たして比べる */
  const opts = { lexicon: copyLexicon, trend: { rising: [], decaying: [] } };
  const before = score.scoreAll(items, strategy, opts);
  const after = score.scoreAll(items, strategy,
    Object.assign({ velocityIndex: v.index, snapshotCount: v.snapshotCount }, opts));

  assert.strictEqual(before.phase.phase, 'cold_start', '速度が無ければ冷開始');
  assert.strictEqual(after.phase.phase, 'observed', '2日分そろえば観測位相');

  const code = items[11].itemCode;
  const b = before.find(function (i) { return i.itemCode === code; });
  const a = after.find(function (i) { return i.itemCode === code; });

  assert.ok(a.scores.velocity > b.scores.velocity,
    '伸びた商品の速度スコアが未計測時より上がる: ' + b.scores.velocity + ' → ' + a.scores.velocity);
  assert.ok(a.total > b.total, '総合点も上がる: ' + b.total.toFixed(4) + ' → ' + a.total.toFixed(4));

  const rankBefore = before.findIndex(function (i) { return i.itemCode === code; });
  const rankAfter = after.findIndex(function (i) { return i.itemCode === code; });
  assert.ok(rankAfter < rankBefore,
    '順位が上がる: ' + (rankBefore + 1) + '位 → ' + (rankAfter + 1) + '位');
  clearSnapshots();
});

test('全商品が伸びていなくても異常にならない', function () {
  clearSnapshots();
  const items = fixtures.candidates(8);
  writeSnapshots(items, items.map(function () { return 0; }));

  const v = velocity.buildVelocityIndex(strategy);
  assert.strictEqual(v.index.size, 8);
  [...v.index.values()].forEach(function (x) {
    assert.strictEqual(x.reviewsPerDay, 0);
  });

  const scored = score.scoreAll(items, strategy, {
    lexicon: copyLexicon, trend: { rising: [], decaying: [] }, velocityIndex: v.index
  });
  scored.forEach(function (i) {
    assert.ok(Number.isFinite(i.total), '総合点が数値のままである');
    assert.ok(i.scores.velocity >= 0 && i.scores.velocity <= 1);
  });
  clearSnapshots();
});

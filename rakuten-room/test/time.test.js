'use strict';
require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const time = require('../src/util/time');

test('JSTの日付境界がUTCに引きずられない', function () {
  /* UTC 2026-08-25 16:00 は JST 2026-08-26 01:00 */
  const d = new Date('2026-08-25T16:00:00Z');
  assert.strictEqual(time.dateKey(d), '2026-08-26');
  assert.strictEqual(time.timeLabel(d), '01:00');
});

test('JSTの指定時刻が正しいUTC瞬間になる', function () {
  const d = time.jstAt('2026-08-26', '20:00');
  assert.strictEqual(d.toISOString(), '2026-08-26T11:00:00.000Z');
  assert.strictEqual(time.timeLabel(d), '20:00');
});

test('日付の加算と差分', function () {
  assert.strictEqual(time.addDaysToKey('2026-08-30', 3), '2026-09-02');
  assert.strictEqual(time.daysBetweenKeys('2026-08-30', '2026-09-02'), 3);
});

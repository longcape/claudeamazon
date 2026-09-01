'use strict';
require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const store = require('../src/util/store');
const copy = require('../src/copy/generate');
const fixtures = require('./fixtures');

const strategy = store.loadStrategy();
const lexicon = store.readJson(store.configPath('copy-lexicon.json'), null);
const trend = store.loadTrendWords();

function withRole(i, role) {
  const item = fixtures.makeItem(i);
  item.primarySubTheme = 'kitchen-storage';
  item.role = role;
  return item;
}

test('紹介文に 誰の/悩み/どう変わる が必ず入る', function () {
  ['bait', 'cv', 'traffic'].forEach(function (role) {
    const c = copy.compose(withRole(3, role), strategy, lexicon, trend);
    assert.ok(c.parts.who, role + ': 誰の が無い');
    assert.ok(c.parts.problem, role + ': 悩み が無い');
    assert.ok(c.parts.change, role + ': 変化 が無い');
    assert.ok(c.body.indexOf(c.parts.problem) >= 0);
    assert.ok(c.body.indexOf(c.parts.change) >= 0);
  });
});

test('禁止表現と文字数の検査が効く', function () {
  const c = copy.compose(withRole(4, 'cv'), strategy, lexicon, trend);
  const check = copy.validateCopy(copy.fit(c, strategy), strategy);
  assert.strictEqual(check.ok, true, JSON.stringify(check.issues));

  const bad = JSON.parse(JSON.stringify(c));
  bad.body = 'これは便利です';
  const badCheck = copy.validateCopy(bad, strategy);
  assert.strictEqual(badCheck.ok, false);
  assert.ok(badCheck.issues.some(function (i) { return i.indexOf('便利です') >= 0; }));
});

test('同じ商品なら毎回同じ文になる（再現性）', function () {
  const a = copy.compose(withRole(7, 'bait'), strategy, lexicon, trend);
  const b = copy.compose(withRole(7, 'bait'), strategy, lexicon, trend);
  assert.strictEqual(a.body, b.body);
});

test('売上投稿には根拠（★とレビュー数）が入る', function () {
  const c = copy.compose(withRole(2, 'cv'), strategy, lexicon, trend);
  assert.ok(/★\d/.test(c.body), 'cv に評価が無い: ' + c.body);
});

test('送客投稿は楽天市場のページへ誘導する', function () {
  const c = copy.compose(withRole(2, 'traffic'), strategy, lexicon, trend);
  assert.ok(/楽天市場|商品ページ|レビューの写真/.test(c.body), c.body);
});

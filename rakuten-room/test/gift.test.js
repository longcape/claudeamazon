/* ソーシャルギフト方針（2026-09-01確定）の仕様を固定するテスト。
   旧「キッチンと収納」方針の検査（ジャンル散乱）は廃止され、
   ここでは「ギフト用途として成立するか」を見る。 */
'use strict';
require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const store = require('../src/util/store');
const score = require('../src/pipeline/score');
const gift = require('../src/pipeline/gift');
const portfolio = require('../src/pipeline/portfolio');
const facets = require('../src/pipeline/facets');
const ngcheck = require('../src/guard/ngcheck');
const fixtures = require('./fixtures');

const strategy = store.loadStrategy();
const lexicon = require('../config/gift-lexicon.json');
const copyLexicon = require('../config/copy-lexicon.json');

function scored(items) {
  return score.scoreAll(items, strategy, {
    lexicon: copyLexicon,
    trend: { rising: [], decaying: [] }
  });
}

/* ---------- ギフト適性の判定 ---------- */

test('ギフト用途の商品はギフト適性を満たす', function () {
  const items = scored(fixtures.candidates(30));
  const threshold = strategy.gift.minGiftReadyForPost;
  const passing = items.filter(function (i) { return i.giftScores.giftReady >= threshold; });
  assert.strictEqual(passing.length, items.length,
    'ギフト表記のある商品は全件が閾値 ' + threshold + ' を超える');
});

test('そのまま渡せるギフト仕立てが最も高く評価される', function () {
  /* 2026-09-04に階層を入れ替えた。棚の中核は「予算で選べて、そのまま渡せる」なので、
     のし・化粧箱などギフト仕立てを最上位に置く。住所なし（ソーシャルギフト）は
     棚の中の1コレクションへ降ろしたので次点。 */
  const strong = gift.giftReady({ cleanName: 'スイーツ のし対応 化粧箱', catchcopy: '', caption: '' }, lexicon);
  const medium = gift.giftReady({ cleanName: 'ソーシャルギフト スイーツ', catchcopy: '', caption: '' }, lexicon);
  const weak = gift.giftReady({ cleanName: 'スイーツ プレゼント', catchcopy: '', caption: '' }, lexicon);
  const none = gift.giftReady({ cleanName: '業務用 洗剤 5L', catchcopy: '', caption: '' }, lexicon);

  assert.ok(strong.score > medium.score, 'ギフト仕立て > 住所なしのみ');
  assert.ok(medium.score > weak.score, '住所なしのみ > ギフト語のみ');
  assert.ok(weak.score > none.score, 'ギフト語のみ > 該当なし');
  assert.strictEqual(none.score, 0);
  assert.strictEqual(strong.source, 'inferred', '推測値であることを明示する');
});

test('のし付き商品に住所なしの棚札を付けない', function () {
  /* 階層を入れ替えたとき、giftReady が満点になっただけの商品へ
     「住所を知らなくても贈れる」が付く誤りが実データで起きた（100件中65件）。 */
  const noshi = gift.collectionsFor({ cleanName: 'スイーツ 詰め合わせ のし対応 化粧箱', catchcopy: '', caption: '', price: 3000 }, lexicon, 1.0, [], (strategy.gift || {}).priceBands);
  assert.ok(noshi.indexOf('住所を知らなくても贈れる') < 0, 'のしだけでは住所なしにしない');

  const social = gift.collectionsFor({ cleanName: 'ソーシャルギフト スイーツ 詰め合わせ', catchcopy: '', caption: '', price: 3000 }, lexicon, 0.6, [], (strategy.gift || {}).priceBands);
  assert.ok(social.indexOf('住所を知らなくても贈れる') >= 0, '住所不要の明示があれば付ける');
});

test('ギフト用途から逸脱した商品はNG検査で止まる', function () {
  const items = scored(fixtures.nonGiftCandidates(20)).map(function (i, n) {
    return Object.assign({}, i, { order: n + 1, copyCheck: { ok: true }, scheduledAt: new Date().toISOString() });
  });
  const report = ngcheck.check(items, strategy, {});
  const hit = report.blockers.concat(report.warnings).some(function (m) { return m.indexOf('NG1 ギフト適性') >= 0; });
  assert.ok(hit, 'ギフト適性のない商品群はNG1で指摘される');
  assert.ok(report.sections.gift.offThemeCount > 0);
});

test('コレクションが分かれてもジャンル散乱とは判定しない', function () {
  /* 価格帯も用途も違う商品を並べる。旧仕様ではサブテーマ数の上限で止まっていた */
  const items = scored(fixtures.candidates(24)).map(function (i, n) {
    return Object.assign({}, i, { order: n + 1, copyCheck: { ok: true } });
  });
  const collections = new Set();
  items.forEach(function (i) { (i.giftCollections || []).forEach(function (c) { collections.add(c); }); });

  assert.ok(collections.size >= 3, '複数のコレクションにまたがっている: ' + collections.size);
  const report = ngcheck.check(items, strategy, {});
  const scatter = report.blockers.some(function (m) { return m.indexOf('ジャンル散乱') >= 0; });
  assert.strictEqual(scatter, false, 'コレクションの違いを散乱として止めない');
});

/* ---------- 評価軸 ---------- */

test('評価軸は客観値と推測値を区別して持つ', function () {
  const items = scored(fixtures.candidates(5));
  const sources = items[0].giftSources;
  assert.strictEqual(sources.affiliate, 'api', '料率はAPIから客観取得できる');
  assert.strictEqual(sources.giftReady, 'inferred', 'ソーシャルギフト対応は推測');
  assert.strictEqual(sources.giftLook, 'mixed', 'ギフト映えは画像枚数と語の混合');
  assert.strictEqual(sources.videoFit, 'mixed');
  assert.strictEqual(sources.versatility, 'mixed');
});

test('8項目がすべてスコアに含まれ、重みの合計が1になる', function () {
  const items = scored(fixtures.candidates(3));
  ['giftReady', 'affiliate', 'velocity', 'trust', 'priceFit', 'giftLook', 'videoFit', 'versatility']
    .forEach(function (k) {
      assert.ok(typeof items[0].scores[k] === 'number', k + ' がスコアに含まれる');
    });
  const sum = Object.keys(strategy.weights)
    .filter(function (k) { return !k.startsWith('$'); })
    .reduce(function (a, k) { return a + strategy.weights[k]; }, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, '重みの合計が1: ' + sum);
});

test('画が持たない商材は動画化しやすさが抑えられる', function () {
  const normal = gift.videoFit({ cleanName: 'スイーツ 詰め合わせ', catchcopy: '', caption: 'x'.repeat(900), imageCount: 4, captionLength: 900 }, lexicon);
  const hard = gift.videoFit({ cleanName: 'カタログギフト 選べる', catchcopy: '', caption: 'x'.repeat(900), imageCount: 4, captionLength: 900 }, lexicon);
  assert.ok(hard.score <= 0.3, 'カタログギフトは動画向きではない');
  assert.ok(normal.score > hard.score);
});

/* ---------- ポートフォリオ ---------- */

test('主力・準主力・ロングテールに分類される', function () {
  const items = scored(fixtures.candidates(140));
  const pf = portfolio.build(items, strategy);
  const cfg = strategy.portfolio;

  assert.strictEqual(pf.flagship.length, cfg.flagship, '主力は ' + cfg.flagship + ' 件');
  assert.strictEqual(pf.secondary.length, cfg.secondary, '準主力は ' + cfg.secondary + ' 件');
  assert.strictEqual(pf.longtail.length, cfg.longtail, 'ロングテールは ' + cfg.longtail + ' 件');
  assert.strictEqual(pf.all.length, cfg.flagship + cfg.secondary + cfg.longtail);

  const codes = new Set(pf.all.map(function (i) { return i.itemCode; }));
  assert.strictEqual(codes.size, pf.all.length, '同じ商品が2つの層に入らない');
});

test('ポートフォリオの各商品が後工程へ渡す項目を持つ', function () {
  const pf = portfolio.build(scored(fixtures.candidates(140)), strategy);
  const rows = portfolio.toRows(pf);
  const r = rows[0];
  ['itemCode', 'name', 'price', 'tier', 'total', 'scores', 'sources', 'collections', 'angle', 'videoPriority']
    .forEach(function (k) { assert.ok(r[k] !== undefined, k + ' が出力される'); });
  assert.ok(['主力', '準主力', 'ロングテール'].indexOf(r.tier) >= 0);
  assert.ok(['A', 'B', 'C'].indexOf(r.videoPriority) >= 0);
  assert.ok(r.angle.hook && r.angle.who, '訴求角度に冒頭フックと対象が入る');
});

test('ギフト適性の無い商品はポートフォリオに入らない', function () {
  const mixed = scored(fixtures.candidates(60).concat(fixtures.nonGiftCandidates(40)));
  const pf = portfolio.build(mixed, strategy);
  assert.ok(pf.summary.rejectedByGiftReady >= 40, '適性不足が除外される');
  pf.all.forEach(function (i) {
    assert.ok(i.giftScores.giftReady >= strategy.portfolio.minGiftReady);
  });
});

test('1ショップへの集中を避ける', function () {
  const pf = portfolio.build(scored(fixtures.candidates(140)), strategy);
  const counts = {};
  pf.all.forEach(function (i) { counts[i.shopCode] = (counts[i.shopCode] || 0) + 1; });
  Object.keys(counts).forEach(function (k) {
    assert.ok(counts[k] <= strategy.portfolio.maxPerShop,
      k + ' が上限 ' + strategy.portfolio.maxPerShop + ' を超えている: ' + counts[k]);
  });
});

/* ---------- 欠損とAPI変更への耐性 ---------- */

test('項目が欠けた商品でも例外にならない', function () {
  const broken = [
    { itemCode: 'a:1', name: '', cleanName: '', core: '', catchcopy: '', price: 0, imageCount: 0, captionLength: 0, caption: '', reviewCount: 0, reviewAverage: 0, affiliateRate: 0, pointRate: 1, shopCode: 's1', shopName: '', genreId: '', occurrences: [] },
    { itemCode: 'a:2', name: 'ギフト', cleanName: 'ギフト', core: 'ギフト', shopCode: 's2', occurrences: [] }
  ];
  const out = scored(broken);
  assert.strictEqual(out.length, 2);
  out.forEach(function (i) {
    assert.ok(Number.isFinite(i.total), '総合スコアが数値になる');
    assert.ok(i.total >= 0 && i.total <= 1);
    assert.ok(Array.isArray(i.giftCollections));
  });
});

test('APIの応答が想定と違っても異常終了しない', function () {
  const ichiba = require('../src/rakuten/ichiba');
  /* 新旧どちらのキーでも、未知の形でも落ちないこと */
  assert.deepStrictEqual(ichiba.normalizeItem({}).itemCode, '');
  const legacy = ichiba.normalizeItem({ itemName: 'a', tagIds: [1, 2] });
  const current = ichiba.normalizeItem({ itemName: 'a', attributeIds: [3] });
  assert.deepStrictEqual(legacy.tagIds, [1, 2], '旧キー tagIds を拾える');
  assert.deepStrictEqual(current.tagIds, [3], '新キー attributeIds を拾える');
});

/* ---------- 秘密情報 ---------- */

test('秘密情報がGit管理対象にも出力にも含まれない', function () {
  const root = store.ROOT;
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.ok(/^\.env$/m.test(ignore), '.env が .gitignore に入っている');
  assert.ok(/^data\/\*\.json$/m.test(ignore), 'data のJSONが .gitignore に入っている');

  /* 追跡されている設定ファイルに実キーが書かれていないこと */
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  example.split('\n').filter(function (l) { return l.indexOf('=') > 0 && !l.startsWith('#'); })
    .forEach(function (l) {
      assert.strictEqual(l.split('=').slice(1).join('=').trim(), '',
        '.env.example に値が書かれていない: ' + l);
    });

  /* ポートフォリオ出力に認証情報が混ざらないこと */
  const rows = portfolio.toRows(portfolio.build(scored(fixtures.candidates(60)), strategy));
  const dumped = JSON.stringify(rows);
  ['RAKUTEN_APP_ID', 'RAKUTEN_ACCESS_KEY', 'accessKey', 'applicationId'].forEach(function (k) {
    assert.strictEqual(dumped.indexOf(k), -1, '出力に ' + k + ' が含まれない');
  });
});

test('固定カテゴリ上限で関連商品のまとまりを切らない', function () {
  /* 一律の占有率上限は撤廃した。上限で機械的に切ると、
     買い物目的でまとまった関連商品の束まで壊れる */
  assert.strictEqual(strategy.portfolio.maxCollectionShare, undefined);
  assert.strictEqual(strategy.portfolio.dominanceWarningShare, undefined);
  /* 代わりに、商品カテゴリだけへ警告を当てる */
  assert.ok(strategy.portfolio.dominance.productCategoryWarn > 0.5);
});

test('利用場面が78%を占めても商品カテゴリの偏り警告は出ない', function () {
  /* 誕生日タグは候補の78%が持つ。場面が広いだけで棚の偏りではない。
     旧実装は giftCollections へ一律の上限を当てていたため、
     これを食品の偏りと同じ扱いで警告していた */
  const items = [];
  for (let i = 0; i < 100; i += 1) {
    items.push({
      facets: {
        productCategory: i < 30 ? 'sweets' : (i < 60 ? 'towel' : 'cosmetic'),
        occasion: i < 78 ? ['birthday'] : ['thanks'],
        recipient: [], priceBand: '3000', deliveryMode: 'address_free'
      }
    });
  }
  const warns = facets.categoryDominance(items, strategy);
  assert.strictEqual(warns.length, 0, '商品カテゴリはどれも70%を超えていない');

  const cov = facets.coverage(items, strategy);
  assert.ok(cov.occasion, '場面はカバレッジとして別に集計される');
  assert.strictEqual(cov.occasion.counts.birthday, 78);
});

test('商品カテゴリが71%を占めると警告が出る。ただし自動除外はしない', function () {
  const items = [];
  for (let i = 0; i < 100; i += 1) {
    items.push({
      facets: {
        productCategory: i < 71 ? 'sweets' : 'towel',
        occasion: ['birthday'], recipient: [], priceBand: '3000', deliveryMode: 'unknown'
      }
    });
  }
  const warns = facets.categoryDominance(items, strategy);
  assert.strictEqual(warns.length, 1);
  assert.strictEqual(warns[0].productCategory, 'sweets');
  assert.ok(warns[0].share > 0.70);
  /* 警告であって除外ではない。件数はそのまま残る */
  assert.strictEqual(items.length, 100);
});

test('紹介文が検証できない断定と誇張を含まない', function () {
  const copy = require('../src/copy/generate');
  const trend = { rising: [], decaying: [] };
  const items = scored(fixtures.candidates(40)).map(function (i, n) {
    return Object.assign({}, i, { order: n + 1, role: ['bait', 'cv', 'traffic'][n % 3] });
  });
  const withCopy = copy.generateAll(items, strategy, copyLexicon, trend);

  withCopy.forEach(function (p) {
    strategy.copy.banPhrases.forEach(function (w) {
      assert.strictEqual(p.copy.text.indexOf(w), -1,
        '禁止語「' + w + '」が紛れている: ' + p.copy.text.slice(0, 40));
    });
    assert.ok(p.copy.text.length >= strategy.copy.minLength, '短すぎない');
    assert.ok(p.copy.text.length <= strategy.copy.maxLength * 2, '長すぎない');
  });

  /* 同じ文の使い回しが支配的になっていないこと */
  const bodies = withCopy.map(function (p) {
    return (p.copy.text.split('\n').find(function (l) { return l.indexOf('へ。') >= 0; }) || '');
  }).filter(Boolean);
  const uniq = new Set(bodies).size;
  assert.ok(uniq >= Math.ceil(bodies.length * 0.3),
    '悩み→変化の文が使い回しすぎ: ' + uniq + '種 / ' + bodies.length + '件');
});

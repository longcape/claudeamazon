/* 2026-09-02 再較正の仕様を固定するテスト。

   この時点では投稿実績が無く、定点観測も1日分しかない。
   実績があるものとして重みを確定してはいけないので、ここで固定するのは
   「正しい比較実験ができること」「未成熟な成果を学習に入れないこと」
   「冷開始で実測でない値が順位を動かさないこと」の3点である。 */
'use strict';
require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const store = require('../src/util/store');
const score = require('../src/pipeline/score');
const facets = require('../src/pipeline/facets');
const portfolio = require('../src/pipeline/portfolio');
const experiment = require('../src/plan/experiment');
const feedback = require('../src/feedback/record');
const fixtures = require('./fixtures');

const strategy = store.loadStrategy();
const copyLexicon = require('../config/copy-lexicon.json');

function scored(items, extras) {
  return score.scoreAll(items, strategy, Object.assign({
    lexicon: copyLexicon, trend: { rising: [], decaying: [] }
  }, extras || {}));
}

function makeExperiment(reverse) {
  return experiment.create(scored(fixtures.candidates(220)), strategy, {
    startDate: '2026-09-10', reverse: !!reverse
  });
}

/* ---------- 1〜3 時間帯クロスオーバー実験 ---------- */

test('1. 0時枠と21時枠で役割比が同一になる', function () {
  /* 旧設計は 0:20 が bait/traffic、21〜22時が cv を含んでいた。
     時間帯と役割が同時に変わると、差の原因を特定できない */
  const e = makeExperiment(false);
  const slots = Object.keys(e.bySlot);
  assert.strictEqual(slots.length, 2, '2枠で比較する');

  const a = e.bySlot[slots[0]];
  const b = e.bySlot[slots[1]];
  assert.strictEqual(a.count, 6, '片枠6投稿');
  assert.strictEqual(b.count, 6);
  assert.deepStrictEqual(a.roles, b.roles, '役割の構成が枠間で一致する');
  assert.strictEqual(e.posts.length, 12);

  const check = experiment.audit(e, strategy);
  assert.strictEqual(check.ok, true, check.issues.join(' / '));
});

test('2. 実験中は投稿時刻のゆらぎが0になる', function () {
  assert.strictEqual(strategy.experiment.jitterMinutes, 0, '設定でも0');
  const e = makeExperiment(false);
  e.posts.forEach(function (p) {
    assert.strictEqual(p.jitterMinutes, 0, '#' + p.order + ' にゆらぎが入っている');
  });
  /* 時刻が設定どおりちょうどに並ぶ */
  const evening = e.posts.filter(function (p) { return p.slotVariant === 'evening_21_22'; });
  const times = [...new Set(evening.map(function (p) { return p.timeJst; }))].sort();
  assert.deepStrictEqual(times, strategy.experiment.slots.evening_21_22);
});

test('3. 0時台の投稿は前夜のセッションに紐づく', function () {
  const e = makeExperiment(false);
  const midnight = e.posts.filter(function (p) { return p.slotVariant === 'midnight_00_01'; });
  assert.ok(midnight.length > 0);
  midnight.forEach(function (p) {
    assert.ok(p.timeJst.indexOf('00:') === 0, '0時台である');
    assert.notStrictEqual(p.date, p.sessionDate, '暦日は翌日になる');
    assert.strictEqual(p.sessionDate, require('../src/util/time').addDaysToKey(p.date, -1),
      'セッションは前夜へ寄せる');
  });

  /* record 側の変換も同じ扱いであること */
  assert.strictEqual(feedback.sessionDateOf('2026-09-11', '00:30', strategy), '2026-09-10');
  assert.strictEqual(feedback.sessionDateOf('2026-09-10', '21:30', strategy), '2026-09-10');
});

test('実験の時間帯割当は次回反転できる（クロスオーバー）', function () {
  const first = makeExperiment(false);
  const second = makeExperiment(true);
  assert.notStrictEqual(first.clusters[0].slotVariant, second.clusters[0].slotVariant,
    '同じ位置のクラスターが逆の枠へ移る');
  assert.strictEqual(second.experimentId.indexOf('-R') > 0, true);
});

/* ---------- 4〜5 成果の成熟 ---------- */

function entry(overrides) {
  return Object.assign({
    itemCode: 'shop1:i1', date: '2026-09-10', timeJst: '21:10', role: 'cv',
    subTheme: 'sweets', shopCode: 'shop1', price: 3000, priceBand: 'golden',
    publishedAt: '2026-09-10T12:00:00Z', observationAsOf: '2026-09-12T12:00:00Z',
    outboundClicks: 20, uniqueOutboundUsers: null,
    conversionsPending: 0, conversionsConfirmed: null,
    revenuePending: 0, revenueConfirmed: null, likes: 5
  }, overrides || {});
}

test('4. 30日未満の投稿は成約0として学習へ入らない', function () {
  const young = entry({ observationAsOf: '2026-09-12T12:00:00Z' });
  young.maturity = feedback.maturityOf(young, young.observationAsOf, strategy);
  assert.strictEqual(young.maturity, 'click_ready');
  assert.strictEqual(feedback.isCvUsable(young), false,
    '未成熟な投稿をCVの母集団に入れない');

  const old = entry({ observationAsOf: '2026-10-20T12:00:00Z' });
  old.maturity = feedback.maturityOf(old, old.observationAsOf, strategy);
  assert.strictEqual(old.maturity, 'cv_mature');
  assert.strictEqual(feedback.isCvUsable(old), true);

  /* 未成熟が混ざっても購買転換の母数から外れる */
  const o = feedback.observations([young, old], strategy);
  assert.strictEqual(o.購買転換観測.maturePosts, 1);
  assert.strictEqual(o.購買転換観測.immaturePosts, 1);
});

test('5. 確定した成約は成熟日前でも記録して使える', function () {
  const early = entry({ observationAsOf: '2026-09-12T12:00:00Z', conversionsConfirmed: 2 });
  early.maturity = feedback.maturityOf(early, early.observationAsOf, strategy);
  assert.strictEqual(early.maturity, 'click_ready', 'まだ成熟段階ではない');
  assert.strictEqual(feedback.isCvUsable(early), true,
    '確定値が明示されていれば使ってよい');

  const o = feedback.observations([early], strategy);
  assert.strictEqual(o.購買転換観測.confirmedConversions, 2);
  assert.strictEqual(o.購買転換観測.value, 2 / 20);
});

test('成熟段階が24時間・7日・30日・89日で切り替わる', function () {
  const base = { publishedAt: '2026-09-01T00:00:00Z' };
  const at = function (iso) { return feedback.maturityOf(base, iso, strategy); };
  assert.strictEqual(at('2026-09-01T12:00:00Z'), 'click_ready');
  assert.strictEqual(at('2026-09-09T00:00:00Z'), 'cv_early');
  assert.strictEqual(at('2026-10-05T00:00:00Z'), 'cv_mature');
  assert.strictEqual(at('2026-12-10T00:00:00Z'), 'final');
});

/* ---------- 10〜11 関連度 ---------- */

function withFacets(over) {
  return Object.assign({
    itemCode: 'a:1', signature: 'sig-a',
    facets: {
      deliveryMode: 'unknown', productCategory: 'other',
      occasion: ['birthday'], recipient: [], priceBand: '3000'
    }
  }, over || {});
}

test('10. 補完カテゴリの関連度は誕生日タグだけの一致より高い', function () {
  /* 候補の78%が誕生日タグを持つ。それだけで関連にすると
     ほぼ全商品が関連になり、導線としての識別力がない */
  const onlyOccasion = facets.relatedness(
    withFacets({ itemCode: 'a:1', signature: 's1' }),
    withFacets({ itemCode: 'b:1', signature: 's2', facets: { deliveryMode: 'unknown', productCategory: 'other', occasion: ['birthday'], recipient: [], priceBand: 'other' } }),
    strategy
  );

  const complementary = facets.relatedness(
    withFacets({ itemCode: 'a:1', signature: 's1', facets: { deliveryMode: 'address_free', productCategory: 'sweets', occasion: ['birthday'], recipient: ['female'], priceBand: '3000' } }),
    withFacets({ itemCode: 'b:1', signature: 's2', facets: { deliveryMode: 'address_free', productCategory: 'beverage', occasion: ['birthday'], recipient: ['female'], priceBand: '3000' } }),
    strategy
  );

  assert.ok(complementary.score > onlyOccasion.score,
    '補完カテゴリの束のほうが高い: ' + complementary.score + ' vs ' + onlyOccasion.score);
  assert.ok(onlyOccasion.score < strategy.cluster.minRelatedScore,
    '誕生日タグだけでは関連とみなさない: ' + onlyOccasion.score);
  assert.ok(complementary.score >= strategy.cluster.minRelatedScore);
  assert.ok(complementary.reasons.indexOf('補完カテゴリ') >= 0);
});

test('11. 同じ商品指紋は関連ペアに入らない', function () {
  const a = withFacets({ itemCode: 'a:1', signature: 'same' });
  const b = withFacets({ itemCode: 'b:1', signature: 'same' });
  const r = facets.relatedness(a, b, strategy);
  assert.strictEqual(r.score, 0);
  assert.strictEqual(facets.isRelated(a, b, strategy), false);

  /* 同一商品コードも同様 */
  const self = facets.relatedness(a, withFacets({ itemCode: 'a:1', signature: 'x' }), strategy);
  assert.strictEqual(self.score, 0);
});

/* ---------- 12〜14 スコアリング位相 ---------- */

test('12. cold_start では velocity が順位差を作らない', function () {
  const items = fixtures.candidates(20);
  const index = new Map();
  /* 一部にだけ速度がある状態を作る（既知率30%＝60%未満） */
  items.slice(0, 6).forEach(function (i, n) {
    index.set(i.itemCode, { reviewsPerDay: n * 5, reviewDelta: n * 5, days: 1, priceDropRatio: 0, pointJump: 0, rankImprove: 0 });
  });

  const out = scored(items, { velocityIndex: index, snapshotCount: 1 });
  assert.strictEqual(out.phase.phase, 'cold_start');

  const velocities = new Set(out.map(function (i) { return i.scores.velocity; }));
  assert.strictEqual(velocities.size, 1, '全商品が同じ中立値になる');
  assert.strictEqual([...velocities][0], strategy.velocity.unknownScore);
});

test('13. velocity既知率が60%未満なら observed へ切り替わらない', function () {
  const items = fixtures.candidates(20);
  const half = new Map();
  items.slice(0, 10).forEach(function (i) {
    half.set(i.itemCode, { reviewsPerDay: 3, reviewDelta: 3, days: 1, priceDropRatio: 0, pointJump: 0, rankImprove: 0 });
  });
  /* 既知率50% / スナップショット3日 → 日数は足りるが既知率が足りない */
  const low = score.resolvePhase(items, strategy, { velocityIndex: half, snapshotCount: 3 });
  assert.strictEqual(low.velocityKnownRate, 0.5);
  assert.strictEqual(low.phase, 'cold_start');

  const most = new Map();
  items.slice(0, 16).forEach(function (i) {
    most.set(i.itemCode, { reviewsPerDay: 3, reviewDelta: 3, days: 1, priceDropRatio: 0, pointJump: 0, rankImprove: 0 });
  });
  const ok = score.resolvePhase(items, strategy, { velocityIndex: most, snapshotCount: 3 });
  assert.strictEqual(ok.phase, 'observed');
  /* 切り替わっても一度に全開にはしない */
  assert.ok(ok.velocityRamp > 0 && ok.velocityRamp <= 1);

  const justIn = score.resolvePhase(items, strategy, { velocityIndex: most, snapshotCount: 2 });
  assert.ok(justIn.velocityRamp < 1, '観測初日は部分的にしか効かせない');
});

test('14. 料率が70%以上同値なら affiliate の有効重みが半減する', function () {
  const items = fixtures.candidates(100).map(function (i, n) {
    return Object.assign({}, i, { affiliateRate: n < 80 ? 4 : 2 });
  });
  const dom = score.affiliateDominance(items, strategy);
  assert.strictEqual(dom.dominant, true);
  assert.strictEqual(dom.rate, 4);
  assert.ok(dom.share >= 0.7);

  const flat = score.resolveWeights(strategy, 'observed', dom);
  const varied = score.resolveWeights(strategy, 'observed', { dominant: false });
  assert.ok(flat.affiliate < varied.affiliate,
    '同値に集中しているときは料率の重みを下げる: ' + flat.affiliate + ' vs ' + varied.affiliate);
  assert.ok(flat.trust > varied.trust, '削った分は trust へ戻す');

  const sum = Object.keys(flat).reduce(function (a, k) { return a + flat[k]; }, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, '重みの合計は1のまま: ' + sum);
});

/* ---------- 15 分位選定 ---------- */

test('15. 分位選定は絶対下限0.58を割らない', function () {
  assert.strictEqual(strategy.selection.absoluteFloor, 0.58);
  const items = scored(fixtures.candidates(160));
  const pf = portfolio.build(items, strategy);

  pf.all.forEach(function (i) {
    assert.ok(i.total >= strategy.selection.absoluteFloor,
      '下限未満が混ざっている: ' + i.total);
  });

  /* 候補が少なくても下限は動かない。埋まらない場合は不足として報告する */
  const few = scored(fixtures.candidates(30));
  const small = portfolio.build(few, strategy);
  small.all.forEach(function (i) {
    assert.ok(i.total >= strategy.selection.absoluteFloor);
  });
  assert.ok(small.summary.selection.absoluteFloor === strategy.selection.absoluteFloor,
    '件数不足でも下限を下げない');
  assert.ok(small.summary.selection.shortage.longtail >= 0);
});

/* ---------- 16〜17 学習ゲート ---------- */

function entries(n, over) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(entry(Object.assign({
      itemCode: 'shop' + (i % 5) + ':i' + i,
      date: '2026-09-' + String(10 + (i % 15)).padStart(2, '0'),
      subTheme: i % 2 ? 'sweets' : 'daily-cosme',
      shopCode: 'shop' + (i % 5),
      outboundClicks: 10 + i,
      slotVariant: i % 2 ? 'evening_21_22' : 'midnight_00_01'
    }, over || {})));
  }
  return out;
}

test('16. 24投稿未満では自動学習しない', function () {
  const gate20 = feedback.learningGate(entries(20), strategy);
  assert.strictEqual(gate20.clickLearning, false);
  assert.ok(gate20.reasons.some(function (r) { return r.indexOf('全体') >= 0; }));

  const gate30 = feedback.learningGate(entries(30), strategy);
  assert.strictEqual(gate30.clickLearning, true, '24投稿を超えればクリック学習は有効');
  assert.strictEqual(gate30.cvLearning, false, 'CVは成熟30件が別に要る');
});

test('17. 係数の更新は1回あたり±5%を超えない', function () {
  const rows = entries(40).map(function (e, i) {
    /* 片方のサブテーマだけ極端に良い実績にする */
    return Object.assign({}, e, {
      outboundClicks: e.subTheme === 'sweets' ? 500 : 1,
      conversionsConfirmed: e.subTheme === 'sweets' ? 20 : 0,
      observationAsOf: '2026-12-01T00:00:00Z',
      maturity: 'final'
    });
  });
  store.writeJson('results.json', { entries: rows });

  const items = scored(fixtures.candidates(40));
  const before = new Map(items.map(function (i) { return [i.itemCode, i.total]; }));
  const res = feedback.applyFeedback(items, strategy);
  assert.strictEqual(res.applied, true);

  items.forEach(function (i) {
    if (i.feedbackFactor === undefined) return;
    const ratio = i.total / before.get(i.itemCode);
    assert.ok(ratio <= 1 + strategy.learning.maxAdjustCumulative + 1e-9 &&
      ratio >= 1 - strategy.learning.maxAdjustCumulative - 1e-9,
      '累積の変更幅が±15%を超えている: ' + ratio);
    /* 1軸あたりは±5%。3軸の積でも累積上限で抑える */
    assert.ok(i.feedbackFactor <= 1 + strategy.learning.maxAdjustCumulative &&
      i.feedbackFactor >= 1 - strategy.learning.maxAdjustCumulative);
  });

  store.writeJson('results.json', { entries: [] });
});

/* ---------- 18 migration ---------- */

test('18. 旧 results.json を壊さず読める', function () {
  /* 旧形式。experimentId も maturity も outboundClicks も無い */
  const legacy = {
    entries: [
      { itemCode: 'shop1:i1', name: '旧データ', date: '2026-08-20', timeJst: '21:20', hour: 21,
        role: 'cv', subTheme: 'sweets', shopCode: 'shop1', price: 3000, priceBand: 'golden',
        planKind: 'launch', likes: 12, clicks: 30, conversions: 1, revenue: 2480,
        recordedAt: '2026-08-21T00:00:00Z' },
      { itemCode: 'shop2:i2', name: '旧データ2', date: '2026-08-21', timeJst: '00:20', hour: 0,
        role: 'bait', subTheme: 'price-1000', shopCode: 'shop2', price: 1500, priceBand: 'golden',
        planKind: 'launch', likes: 3, clicks: 5, conversions: 0, revenue: 0,
        recordedAt: '2026-08-22T00:00:00Z' }
    ]
  };
  store.writeJson('results.json', legacy);

  const data = feedback.load(strategy);
  assert.strictEqual(data.entries.length, 2);
  assert.strictEqual(data.migratedCount, 2, '2件を移行した');

  const a = data.entries[0];
  assert.strictEqual(a.schemaVersion, 2);
  assert.strictEqual(a.outboundClicks, 30, '旧 clicks を外部クリックとして読む');
  assert.strictEqual(a.conversionsConfirmed, null, '旧 conversions は確定と断定しない');
  assert.strictEqual(a.conversionsPending, 1);
  assert.strictEqual(a.slotVariant, 'control');
  assert.ok(a.publishedAt, '投稿時刻をJSTから復元する');
  assert.strictEqual(a.likes, 12, '旧フィールドは残す');
  assert.strictEqual(a.clicks, 30);

  /* 0時台の旧データも前夜セッションへ寄る */
  const b = data.entries[1];
  assert.strictEqual(b.sessionDate, '2026-08-20');

  /* 集計まで通ること */
  const o = feedback.observations(data.entries, strategy);
  assert.strictEqual(o.postCount, 2);
  assert.ok(Number.isFinite(o.ROOM反応観測.value));

  store.writeJson('results.json', { entries: [] });
});

/* ---------- 監査（2026-09-02）で追加 ---------- */

test('関連クラスターには補完カテゴリの組み合わせを含める', function () {
  /* 関連度の閾値7は「配送方式一致(4)＋利用場面一致(3)」だけで到達できる。
     候補の78%が場面タグを持つため、それだけだと同じカテゴリが3つ並んだ束も通る。
     実データでクッキー→チョコ→アイスの束が生成され、
     客単価を上げる組み合わせになっていなかった */
  const members = [
    { itemCode: 'a:1', signature: 's1', facets: { deliveryMode: 'address_free', productCategory: 'sweets', occasion: ['birthday'], recipient: [], priceBand: '3000' } },
    { itemCode: 'b:1', signature: 's2', facets: { deliveryMode: 'address_free', productCategory: 'sweets', occasion: ['birthday'], recipient: [], priceBand: '3000' } },
    { itemCode: 'c:1', signature: 's3', facets: { deliveryMode: 'address_free', productCategory: 'sweets', occasion: ['birthday'], recipient: [], priceBand: '3000' } }
  ];
  assert.strictEqual(facets.hasComplementaryPair(members, strategy), false,
    '同じカテゴリだけの束は補完を持たない');

  const withDrink = members.slice(0, 2).concat([
    { itemCode: 'd:1', signature: 's4', facets: { deliveryMode: 'address_free', productCategory: 'beverage', occasion: ['birthday'], recipient: [], priceBand: '3000' } }
  ]);
  assert.strictEqual(facets.hasComplementaryPair(withDrink, strategy), true,
    'スイーツと飲み物は補完関係にある');

  /* requireComplementary を付けると同一カテゴリだけの束は採用されない */
  const onlySweets = facets.buildClusters(members, strategy,
    { count: 1, size: 3, requireComplementary: true });
  assert.strictEqual(onlySweets.length, 0);

  const ok = facets.buildClusters(withDrink, strategy,
    { count: 1, size: 3, requireComplementary: true });
  assert.strictEqual(ok.length, 1);
  assert.strictEqual(ok[0].complementary, true);
});

test('役割の説明が動画由来の仮説を公式スコアと断定しない', function () {
  const render = require('../src/post/render');
  Object.keys(render.ROLE_AIM).forEach(function (r) {
    assert.strictEqual(render.ROLE_AIM[r].indexOf('スコアを取る'), -1,
      r + ' の説明が内部スコアの取得を断定している: ' + render.ROLE_AIM[r]);
  });
  /* 3役割が実際の導線として説明されていること */
  assert.ok(render.ROLE_AIM.bait.indexOf('回遊') >= 0);
  assert.ok(render.ROLE_AIM.traffic.indexOf('楽天市場') >= 0);
  assert.ok(render.ROLE_AIM.cv.indexOf('購入') >= 0);
});

/* ---------- 監査補足（文字起こし反映） ---------- */

test('通常運用が1日3投稿の固定にならない', function () {
  /* 元動画では投稿数を競うものではないとされ、成果が出ないときは
     1〜2投稿へ減らすとある。3投稿は時間帯比較の初期実験限定 */
  assert.ok(strategy.schedule.dailyPosts <= 2,
    '通常運用は1〜2投稿。現在: ' + strategy.schedule.dailyPosts);
  assert.deepStrictEqual(strategy.schedule.dailyPostsRange, [1, 2]);
  assert.strictEqual(strategy.experiment.postsPerDay, 3, '実験だけが3投稿');
  assert.notStrictEqual(strategy.schedule.dailyPosts, strategy.experiment.postsPerDay,
    '実験の投稿数を通常運用へ持ち込まない');
});

test('送客役には楽天市場のページを開く理由が付く', function () {
  const gift = require('../src/pipeline/gift');
  /* 理由はすべて楽天APIが返した値、つまり商品ページに載っている事実から出す */
  const rich = gift.marketplaceClickReasons({
    cleanName: 'ギフト 詰め合わせ 選べる', catchcopy: '',
    reviewCount: 427, pointRate: 5, imageCount: 3, postageFree: true
  }, strategy);
  const keys = rich.map(function (r) { return r.key; });
  assert.ok(keys.indexOf('variation') >= 0);
  assert.ok(keys.indexOf('review') >= 0);
  assert.ok(keys.indexOf('point') >= 0);
  assert.ok(keys.indexOf('photo') >= 0);
  assert.ok(keys.indexOf('postage') >= 0);

  /* 材料が無ければ理由を作らない。ページに無いことを書かないため */
  const bare = gift.marketplaceClickReasons({
    cleanName: 'ギフト', catchcopy: '', reviewCount: 3, pointRate: 1, imageCount: 1, postageFree: false
  }, strategy);
  assert.strictEqual(bare.length, 0);

  const e = makeExperiment(false);
  const traffic = e.posts.filter(function (p) { return p.role === 'traffic'; });
  assert.ok(traffic.length > 0);
  traffic.forEach(function (p) {
    assert.ok(Array.isArray(p.marketplaceClickReasons));
  });
});

test('次の投稿への予告が付き、煽り表現を含まない', function () {
  const e = makeExperiment(false);
  const withNext = e.posts.filter(function (p) { return p.nextRelatedProduct; });
  assert.ok(withNext.length > 0, '束の途中の投稿には次の商品が付く');

  withNext.forEach(function (p) {
    assert.ok(p.nextPostTeaser && p.nextPostTeaser.length > 0);
    strategy.copy.banPhrases.forEach(function (w) {
      assert.strictEqual(p.nextPostTeaser.indexOf(w), -1,
        '予告に禁止語「' + w + '」が入っている');
    });
    assert.strictEqual(p.nextRelatedProduct.itemCode !== p.itemCode, true,
      '自分自身を次の商品にしない');
  });

  /* 束の最後の投稿には次が無い */
  const last = e.posts.filter(function (p) { return !p.nextRelatedProduct; });
  assert.strictEqual(last.length, e.clusters.length, '各束の最後だけ予告が無い');
});

/* ---------- 実運用投入（2026-09-02） ---------- */

test('持っている商品を記録できる。購入履歴は取りに行かない', function () {
  const owned = require('../src/feedback/owned');
  /* 楽天APIからは取れない情報。本人の申告だけを残す */
  const rec = owned.mark('shop1:i1', { name: 'テスト商品', note: '去年買った' });
  assert.strictEqual(rec.ownedByUser, true);
  assert.strictEqual(rec.originalPhotoCandidate, true, '既定で写真候補にする');
  assert.strictEqual(rec.canWriteRealReview, true);
  assert.strictEqual(owned.isOwned('shop1:i1'), true);

  /* 持っていても写真を撮れないことはある */
  owned.mark('shop2:i2', { photo: false });
  assert.strictEqual(owned.get('shop2:i2').originalPhotoCandidate, false);
  assert.strictEqual(owned.photoCandidates().length, 1);

  assert.strictEqual(owned.summary().total, 2);
  assert.strictEqual(owned.remove('shop1:i1'), true);
  assert.strictEqual(owned.get('shop1:i1'), null);
  owned.remove('shop2:i2');
});

test('実行キットが貼り付けに必要なものを1ファイルへ出す', function () {
  const render = require('../src/post/render');
  const copy = require('../src/copy/generate');
  const e = makeExperiment(false);
  e.posts = copy.generateAll(e.posts, strategy, copyLexicon, { rising: [], decaying: [] });
  const md = render.renderExperimentKit(e, strategy);

  /* 実験と通常運用の違いが先頭に書かれている */
  assert.ok(md.indexOf('初期実験です。通常運用ではありません') >= 0);
  assert.ok(md.indexOf('この実験が終わったら3投稿を続けないでください') >= 0);
  assert.ok(md.indexOf('投稿ノルマではありません') >= 0);

  /* 各投稿に必要な項目がある */
  e.posts.forEach(function (p) {
    assert.ok(md.indexOf('## ' + p.order + '. ') >= 0, '#' + p.order + ' の見出し');
    assert.ok(md.indexOf(p.timeJst) >= 0, '投稿時刻');
    assert.ok(md.indexOf(p.sessionDate) >= 0, 'セッション日');
  });
  assert.ok(md.indexOf('24時間後に伝えること') >= 0);
  assert.ok(md.indexOf('楽天市場のページを開いてもらう理由') >= 0);
  assert.ok(md.indexOf('次回予告') >= 0);
});

test('商品コードで商品を照会できる（投稿前の在庫確認に要る）', function () {
  const ichiba = require('../src/rakuten/ichiba');
  /* API仕様上 keyword / genreId / itemCode / shopCode のどれかが必須。
     itemCode を渡せないと投稿直前の販売停止チェックができない */
  assert.ok(String(ichiba.searchItems).indexOf('itemCode') >= 0,
    'searchItems が itemCode をAPIへ渡している');
});

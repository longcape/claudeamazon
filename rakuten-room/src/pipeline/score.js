/* =========================================================
   SCORE — 候補のスコアリング
   ---------------------------------------------------------
   現行方針（ソーシャルギフト特化）の評価軸は11本。
   ユーザー指定の8項目を、既存6軸と統合したもの。

     客観値（楽天APIから取れる）
       velocity  売上速度（レビュー増加の実測）      … 売れ筋
       trust     信頼度（レビュー・ショップ規模）    … レビュー
       priceFit  ギフト価格帯への適合                … 価格
       affiliate アフィリ報酬率                      … 料率
       adHeat    広告加熱度（販促投資の痕跡）
       craft     商品ページ・画像の作り込み度

     推測値（商品テキストからの推定。src/pipeline/gift.js）
       giftReady   ソーシャルギフト対応
       giftLook    ギフト映え（画像枚数との混合）
       videoFit    短尺動画化しやすさ（画像・説明文との混合）
       versatility 用途の広さ（価格帯との混合）

     aiFit 楽天のAI検索が見る6項目への適合

   推測値に重みを寄せすぎると、説明文の書き方が上手いだけの商品が上位に来る。
   重みは config/strategy.json の weights で調整する。
   さらに、同じ商品でも「評価取り／売上／送客」で
   良し悪しが変わるため、役割別スコアを別途出す。
   ========================================================= */
'use strict';

const T = require('../util/text');
const velocityLib = require('./velocity');
const giftLib = require('./gift');
const facetsLib = require('./facets');
const selectLib = require('./select');
/* 語彙は extras で差し替えられる。未指定なら同梱の定義を使う（テストが素で通るように） */
const DEFAULT_GIFT_LEXICON = require('../../config/gift-lexicon.json');

/* ---------- スコアリング位相 ----------
   velocity が未観測のまま順位差を作ると、実測でない値で棚が決まる。
   観測率が十分になるまでは velocity を全商品同じ中立値にし、
   その分の配点を識別力のある軸へ回す。 */
function resolvePhase(candidates, strategy, extras) {
  const cfg = strategy.scoring || {};
  const vIndex = (extras && extras.velocityIndex) || new Map();
  const snapshotDays = (extras && extras.snapshotCount) || 0;
  const known = candidates.filter(function (i) { return vIndex.has(i.itemCode); }).length;
  const knownRate = candidates.length ? known / candidates.length : 0;

  const enough = knownRate >= (cfg.velocityKnownRateThreshold || 0.6) &&
    snapshotDays >= (cfg.minSnapshotDays || 2);

  /* 観測へ切り替わっても一度に全開にしない。collect を重ねるほど効かせる。
     スナップショットの日数から導くので、追加の状態を持たずに済む */
  const rampCollects = cfg.rampCollects || 3;
  const step = snapshotDays - (cfg.minSnapshotDays || 2) + 1;
  const ramp = enough ? Math.max(0, Math.min(1, step / rampCollects)) : 0;

  return {
    phase: enough ? 'observed' : 'cold_start',
    velocityKnownRate: Number(knownRate.toFixed(4)),
    snapshotDays: snapshotDays,
    velocityRamp: Number(ramp.toFixed(4))
  };
}

/* 料率が候補のほとんどで同値なら、その軸は順位付けに効いていない。
   実データでは1,510件中1,162件（77%）が4%だった。 */
function affiliateDominance(candidates, strategy) {
  const threshold = (strategy.scoring || {}).affiliateDominanceThreshold || 0.7;
  if (!candidates.length) return { dominant: false, share: 0, rate: null };
  const counts = {};
  candidates.forEach(function (i) {
    const r = Number(i.affiliateRate) || 0;
    counts[r] = (counts[r] || 0) + 1;
  });
  const top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
  const share = counts[top] / candidates.length;
  return { dominant: share >= threshold, share: Number(share.toFixed(4)), rate: Number(top) };
}

function resolveWeights(strategy, phase, dominance) {
  const w = {};
  Object.keys(strategy.weights).forEach(function (k) {
    if (k.charAt(0) !== '$') w[k] = strategy.weights[k];
  });

  if (phase === 'cold_start') {
    const cold = (strategy.scoring || {}).coldStartWeights || {};
    Object.keys(cold).forEach(function (k) { w[k] = cold[k]; });
  }

  if (dominance && dominance.dominant && w.affiliate) {
    const cut = w.affiliate / 2;
    w.affiliate -= cut;
    w.trust = (w.trust || 0) + cut / 2;
    w.velocity = (w.velocity || 0) + cut / 2;
  }

  const sum = Object.keys(w).reduce(function (a, k) { return a + w[k]; }, 0);
  if (sum > 0 && Math.abs(sum - 1) > 1e-9) {
    Object.keys(w).forEach(function (k) { w[k] = w[k] / sum; });
  }
  return w;
}

const ROLES = ['bait', 'cv', 'traffic'];
const VARIATION_WORDS = ['カラー', '色違い', 'サイズ', '選べる', '種類', 'バリエーション', '全', 'タイプ'];

/* ---------- 個別スコア ---------- */

/* 広告加熱度。楽天は広告出稿量を公開しないので、投資の痕跡を積み上げる。
   内訳の比重は設定で変えられる。ジャンルによっては特定のシグナルが死ぬ
   （インテリア・寝具・収納では報酬率が全商品3%で横並びだった）。
   死んだシグナルに比重を置いたままだと配点がまるごと無駄になるので、
   strategy.json の adHeat.partWeights で生きている側へ寄せられるようにする。
   未設定なら従来どおりの比重で動く */
const AD_HEAT_DEFAULT_WEIGHTS = {
  affiliateRate: 0.30, pointRate: 0.20, pointCampaign: 0.08,
  coupon: 0.12, campaign: 0.06, rerank: 0.24
};

function adHeatScore(item, ctx) {
  const cfg = ctx.strategy.adHeat;
  const w = Object.assign({}, AD_HEAT_DEFAULT_WEIGHTS, cfg.partWeights || {});
  const parts = [];

  /* アフィリ報酬率の引き上げは、店舗が販促費を積んでいる直接的な証拠 */
  parts.push({ w: w.affiliateRate, v: T.scale(item.affiliateRate, cfg.affiliateRateBase, cfg.affiliateRateHot), why: 'アフィリ報酬率 ' + item.affiliateRate + '%' });
  parts.push({ w: w.pointRate, v: T.scale(item.pointRate, cfg.pointRateBase, cfg.pointRateHot), why: 'ポイント ' + item.pointRate + '倍' });
  parts.push({ w: w.pointCampaign, v: item.pointCampaign ? 1 : 0, why: 'ポイント期間設定あり' });
  parts.push({ w: w.coupon, v: T.countMatches(item.name + item.catchcopy, cfg.couponWords) > 0 ? 1 : 0, why: 'クーポン表記' });
  parts.push({ w: w.campaign, v: T.clamp01(T.countMatches(item.name + item.catchcopy, cfg.campaignWords) / 2), why: 'セール文言' });

  /* 別キーワードでも上位に出続ける＝露出が買われている、が本命のシグナル */
  const topKeywords = new Set();
  (item.occurrences || []).forEach(function (o) {
    if (o.source === 'search' && o.position && o.position <= 10) topKeywords.add(o.keyword);
  });
  const rerank = Math.min(cfg.rerankBonusMax, topKeywords.size * cfg.rerankBonus);
  parts.push({ w: w.rerank, v: rerank / cfg.rerankBonusMax, why: '別キーワード上位 ' + topKeywords.size + '語' });

  const onRanking = (item.occurrences || []).some(function (o) { return o.source === 'ranking'; });
  const raw = parts.reduce(function (a, p) { return a + p.w * p.v; }, 0) + (onRanking ? cfg.rankingBonus : 0);

  return {
    score: T.clamp01(raw),
    topKeywordCount: topKeywords.size,
    onRanking: onRanking,
    reasons: parts.filter(function (p) { return p.v > 0.15; }).map(function (p) { return p.why; })
      .concat(onRanking ? ['ジャンルランキング掲載'] : [])
  };
}

function trustScore(item, ctx) {
  const shopCount = ctx.shopItemCount.get(item.shopCode) || 1;
  const parts = [
    { w: 0.34, v: T.scale(item.reviewAverage, 4.0, 4.8) },
    { w: 0.34, v: T.scale(Math.log10(Math.max(1, item.reviewCount)), 2, 4) },
    { w: 0.12, v: item.shopOfTheYear ? 1 : 0 },
    { w: 0.10, v: T.scale(shopCount, 1, 8) },
    { w: 0.06, v: item.postageFree ? 1 : 0 },
    { w: 0.04, v: item.asuraku ? 1 : 0 }
  ];
  return {
    score: T.clamp01(parts.reduce(function (a, p) { return a + p.w * p.v; }, 0)),
    /* レビュー情報が欠けた応答でも落とさない（APIの項目名変更や部分取得への保険） */
    reasons: ['★' + (Number(item.reviewAverage) || 0).toFixed(2) + ' / ' + (Number(item.reviewCount) || 0) + '件']
      .concat(item.shopOfTheYear ? ['ショップ・オブ・ザ・イヤー受賞店'] : [])
      .concat(shopCount >= 4 ? ['候補内に同一ショップ ' + shopCount + '商品（品揃えの厚い店）'] : [])
  };
}

/* ギフトの中心価格帯（config の goldenPrice）。外れるほど台形に落ちるが0にはしない。
   送客用に高額品も使うため、帯の外を切り捨てない */
function priceFitScore(price, cfg) {
  if (price >= cfg.peakMin && price <= cfg.peakMax) return 1;
  if (price >= cfg.min && price <= cfg.max) return 0.86;
  const dist = price < cfg.min ? cfg.min - price : price - cfg.max;
  return T.clamp01(1 - dist / cfg.decayYen) * 0.7;
}

/* 商品画像・商品ページの作り込み度合。作り込まれた店ほど売る気がある */
function craftScore(item) {
  const hasSpec = /\d+\s*(cm|センチ|mm|段|枚|個|L|ml|kg|台|人用|畳)/i.test(item.name);
  const nameLen = item.cleanName.length;
  const parts = [
    { w: 0.24, v: T.scale(item.imageCount, 1, 3) },
    { w: 0.34, v: T.scale(item.captionLength, 150, 1600) },
    { w: 0.14, v: item.catchcopy ? 1 : 0 },
    { w: 0.16, v: hasSpec ? 1 : 0 },
    { w: 0.12, v: nameLen >= 12 && nameLen <= 60 ? 1 : 0.3 }
  ];
  return {
    score: T.clamp01(parts.reduce(function (a, p) { return a + p.w * p.v; }, 0)),
    reasons: (item.imageCount >= 3 ? ['画像' + item.imageCount + '枚'] : [])
      .concat(item.captionLength >= 800 ? ['商品説明が作り込まれている'] : [])
  };
}

/* 楽天のAIが見る6項目。ユーザー指定の6つをそのまま実装している */
function aiFitScore(item, ctx, velocity) {
  const lex = ctx.lexicon;
  const name = item.cleanName + ' ' + item.catchcopy;

  const verbHits = lex.actionVerbs.filter(function (v) { return name.indexOf(v) >= 0; });
  const verb = T.clamp01(verbHits.length / 2);

  const rising = (ctx.trend.rising || []).filter(function (w) { return name.indexOf(w) >= 0; });
  const decaying = (ctx.trend.decaying || []).filter(function (w) { return name.indexOf(w) >= 0; });
  const trendWord = T.clamp01(rising.length / 2 - decaying.length * 0.5);

  /* 類似商品の購買データ = 同サブテーマ内でのレビュー数の相対位置 */
  const peers = ctx.subThemeReviewCounts.get(item.primarySubTheme || '_none') || [];
  const peerRank = peers.length ? peers.filter(function (n) { return n < item.reviewCount; }).length / peers.length : 0.5;

  /* カテゴリ相関性 */
  const rootId = ctx.strategy.genre.rootGenreId;
  const related = ctx.strategy.genre.relatedGenreIds || [];
  const categoryFit = item.genreId === rootId ? 1
    : ctx.genreDescendants.has(item.genreId) ? 0.9
      : related.indexOf(item.genreId) >= 0 ? 0.6
        : 0.25;

  /* 過去30日の売上速度 */
  const speed = velocity.score;

  /* トレンド商品の隣接効果 = ランキング掲載商品と同じショップ / 同じサブテーマ */
  const adjacency = item.occurrences.some(function (o) { return o.source === 'ranking'; }) ? 1
    : ctx.rankingShops.has(item.shopCode) ? 0.7
      : ctx.rankingSubThemes.has(item.primarySubTheme) ? 0.45
        : 0.1;

  const six = [verb, trendWord, peerRank, categoryFit, speed, adjacency];
  return {
    score: six.reduce(function (a, b) { return a + b; }, 0) / six.length,
    breakdown: { 動詞: verb, 上昇ワード: trendWord, 類似購買: peerRank, カテゴリ相関: categoryFit, 売上速度: speed, トレンド隣接: adjacency },
    reasons: (verbHits.length ? ['商品名に動詞「' + verbHits.slice(0, 2).join('・') + '」'] : [])
      .concat(rising.length ? ['上昇ワード「' + rising.join('・') + '」'] : [])
      .concat(adjacency >= 0.7 ? ['ランキング商品と同じ売れ筋帯'] : [])
  };
}

/* ---------- 合成 ---------- */

function weightedSum(scores, weights) {
  let total = 0;
  let sum = 0;
  Object.keys(weights).forEach(function (k) {
    if (typeof scores[k] !== 'number') return;
    total += weights[k];
    sum += weights[k] * scores[k];
  });
  return total > 0 ? sum / total : 0;
}

function roleScores(scores, item, strategy) {
  const out = {};
  ROLES.forEach(function (role) {
    const bias = strategy.roleBias[role] || {};
    const weights = {};
    Object.keys(strategy.weights).forEach(function (k) {
      if (k.startsWith('$')) return;
      weights[k] = strategy.weights[k] * (bias[k] === undefined ? 1 : bias[k]);
    });
    let s = weightedSum(scores, weights);

    if (role === 'bait') {
      /* 評価取りは「安くてつい見る」が仕事。高いと成立しない */
      if (bias.priceCeil && item.price > bias.priceCeil) {
        s *= T.clamp01(1 - (item.price - bias.priceCeil) / (bias.priceCeil * 1.5));
      }
    }
    if (role === 'cv') {
      /* 売上投稿は星が低いと事故る。4.2未満は明確に落とす */
      if (item.reviewAverage < 4.2) s *= 0.72;
      if (item.price < strategy.goldenPrice.min || item.price > strategy.goldenPrice.max) s *= 0.80;
    }
    if (role === 'traffic' && bias.preferVariations) {
      /* 送客は「ページで選ばせる」ほど滞在が伸びる */
      const varHits = T.countMatches((item.name || '') + ' ' + (item.caption || '').slice(0, 400), VARIATION_WORDS);
      s *= 1 + Math.min(0.18, varHits * 0.05);
    }
    out[role] = T.clamp01(s);
  });
  return out;
}

/* 候補配列全体にスコアを付ける。全体統計が要るので配列単位で処理する */
function scoreAll(candidates, strategy, extras) {
  const ctx = buildContext(candidates, strategy, extras);
  const vIndex = extras.velocityIndex || new Map();
  const phaseInfo = resolvePhase(candidates, strategy, extras);
  const dominance = affiliateDominance(candidates, strategy);
  const weights = resolveWeights(strategy, phaseInfo.phase, dominance);
  const cold = phaseInfo.phase === 'cold_start';

  const scored = candidates.map(function (item) {
    const measured = velocityLib.velocityScore(vIndex.get(item.itemCode), strategy.velocity);
    /* 冷開始では velocity で順位差を作らない。観測直後もランプで徐々に効かせる */
    const neutral = strategy.velocity.unknownScore;
    const velocity = cold
      ? Object.assign({}, measured, { score: neutral, applied: false })
      : Object.assign({}, measured, {
        score: neutral + (measured.score - neutral) * phaseInfo.velocityRamp,
        applied: true
      });
    const ad = adHeatScore(item, ctx);
    const trust = trustScore(item, ctx);
    const craft = craftScore(item);
    const priceFit = priceFitScore(item.price, strategy.goldenPrice);
    const ai = aiFitScore(item, ctx, velocity);
    /* ソーシャルギフト特化の5軸。既存6軸を置き換えるのではなく足す。
       既存軸は「売れるか」を、ギフト軸は「贈り物として成立し、動画にできるか」を見る */
    const gift = giftLib.evaluate(item, strategy, ctx.giftLexicon);

    const scores = {
      adHeat: ad.score,
      trust: trust.score,
      velocity: velocity.score,
      priceFit: priceFit,
      aiFit: ai.score,
      craft: craft.score,
      giftReady: gift.scores.giftReady,
      affiliate: gift.scores.affiliate,
      giftLook: gift.scores.giftLook,
      videoFit: gift.scores.videoFit,
      versatility: gift.scores.versatility
    };

    const roles = roleScores(scores, item, strategy);
    const bestRole = ROLES.reduce(function (a, b) { return roles[b] > roles[a] ? b : a; }, ROLES[0]);

    return Object.assign({}, item, {
      scores: scores,
      total: T.clamp01(weightedSum(scores, weights)),
      roles: roles,
      bestRole: bestRole,
      velocityInfo: velocity,
      aiBreakdown: ai.breakdown,
      adHeatInfo: { topKeywordCount: ad.topKeywordCount, onRanking: ad.onRanking },
      facets: facetsLib.derive(item, strategy, gift.occasionLabels || []),
      signature: selectLib.productSignature(item),
      scoringPhase: phaseInfo.phase,
      giftScores: gift.scores,
      giftSources: gift.sources,
      giftCollections: gift.collections,
      giftOccasions: gift.occasions,
      giftAngle: gift.angle,
      marketplaceClickReasons: gift.marketplaceClickReasons,
      reasons: gift.reasons.concat(ad.reasons, trust.reasons, craft.reasons, ai.reasons,
        velocity.known ? ['レビュー増 ' + velocity.reviewsPerDay + '件/日（' + velocity.label + '）'] : [])
    });
  });

  scored.sort(function (a, b) { return b.total - a.total; });
  /* 呼び出し側が doctor / レポートで出せるよう、配列に情報を添える */
  scored.phase = phaseInfo;
  scored.affiliateDominance = dominance;
  scored.weights = weights;
  return scored;
}

function buildContext(candidates, strategy, extras) {
  const giftLexicon = (extras && extras.giftLexicon) || DEFAULT_GIFT_LEXICON;
  const shopItemCount = new Map();
  const subThemeReviewCounts = new Map();
  const rankingShops = new Set();
  const rankingSubThemes = new Set();

  candidates.forEach(function (item) {
    shopItemCount.set(item.shopCode, (shopItemCount.get(item.shopCode) || 0) + 1);
    /* その商品を最も多く連れてきたサブテーマを主テーマとする */
    const tally = {};
    (item.occurrences || []).forEach(function (o) {
      if (o.subTheme) tally[o.subTheme] = (tally[o.subTheme] || 0) + 1;
    });
    const keys = Object.keys(tally);
    item.primarySubTheme = keys.length
      ? keys.reduce(function (a, b) { return tally[b] > tally[a] ? b : a; })
      : null;

    const bucketKey = item.primarySubTheme || '_none';
    if (!subThemeReviewCounts.has(bucketKey)) subThemeReviewCounts.set(bucketKey, []);
    subThemeReviewCounts.get(bucketKey).push(item.reviewCount);

    if ((item.occurrences || []).some(function (o) { return o.source === 'ranking'; })) {
      rankingShops.add(item.shopCode);
      if (item.primarySubTheme) rankingSubThemes.add(item.primarySubTheme);
    }
  });

  return {
    strategy: strategy,
    lexicon: extras.lexicon,
    trend: extras.trend || { rising: [], decaying: [] },
    genreDescendants: extras.genreDescendants || new Set(),
    shopItemCount: shopItemCount,
    subThemeReviewCounts: subThemeReviewCounts,
    rankingShops: rankingShops,
    rankingSubThemes: rankingSubThemes,
    giftLexicon: giftLexicon
  };
}

module.exports = { scoreAll, resolvePhase, affiliateDominance, resolveWeights, adHeatScore, trustScore, craftScore, priceFitScore, aiFitScore, roleScores, buildContext, ROLES };

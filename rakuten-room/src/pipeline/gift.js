/* =========================================================
   GIFT — ソーシャルギフト特化の評価軸
   ---------------------------------------------------------
   棚のテーマは「ソーシャルギフト」ひとつ。価格帯や用途の違いは
   別ジャンルではなく、同じ棚の中のコレクションとして扱う。

   重要: 各軸は必ず source を持つ。
     'api'      … 楽天APIから客観的に取れる値だけで決まる
     'inferred' … 商品テキストからの推測。語彙を足すほど精度が上がるが、外れる
     'mixed'    … 客観値と推測値の加重和

   推測値に強い重みを置くと、書き方が上手いだけの商品が上位に来る。
   客観値を土台にし、推測値は上乗せと足切りに使う。
   ========================================================= */
'use strict';

const T = require('../util/text');

/* 判定対象のテキスト。説明文は宣伝文句が多く誤検出の温床なので、
   商品名とキャッチコピーを主、説明文は補助（先頭のみ）とする */
function fields(item) {
  return {
    head: T.normalize((item.cleanName || item.name || '') + ' ' + (item.catchcopy || '')),
    body: T.normalize((item.caption || '').slice(0, 800))
  };
}

function hasAny(text, words) {
  if (!words || !words.length) return null;
  for (const w of words) { if (text.indexOf(w) >= 0) return w; }
  return null;
}

/* ---------- 1. ソーシャルギフト対応（推測） ---------- */
/* ブランドの中核が「住所を知らない相手に贈れる」なので、
   住所不要を明示している商品を最も高く評価する。
   楽天APIはソーシャルギフト対応フラグを返さないため、ここは必ず推測になる。 */
function giftReady(item, lex) {
  const f = fields(item);
  const g = lex.giftReady;
  const evidence = [];
  let score = 0;

  const strong = hasAny(f.head, g.strong) || hasAny(f.body, g.strong);
  const medium = hasAny(f.head, g.medium) || hasAny(f.body, g.medium);
  const weak = hasAny(f.head, g.weak) || hasAny(f.body, g.weak);

  if (strong) { score = 1.0; evidence.push('住所不要ギフト対応の表記「' + strong + '」'); }
  else if (medium) { score = 0.6; evidence.push('ギフト包装対応「' + medium + '」'); }
  else if (weak) { score = 0.3; evidence.push('ギフト用途の表記「' + weak + '」'); }

  /* 商品名に出ていれば説明文の片隅より確度が高い */
  if (score > 0 && hasAny(f.head, g.strong.concat(g.medium))) score = Math.min(1, score + 0.1);

  return { score: score, source: 'inferred', evidence: evidence };
}

/* ---------- 2. 料率（客観） ---------- */
function affiliate(item, cfg) {
  const rate = Number(item.affiliateRate) || 0;
  return {
    score: T.scale(rate, cfg.affiliateRateBase, cfg.affiliateRateHot),
    source: 'api',
    evidence: rate ? ['アフィリ報酬率 ' + rate + '%'] : []
  };
}

/* ---------- 6. ギフト映え（混合） ---------- */
/* 客観: 画像枚数。推測: 化粧箱・詰め合わせなど開けたときの見栄えを示す語 */
function giftLook(item, lex) {
  const f = fields(item);
  const g = lex.giftLook;
  const images = T.scale(item.imageCount, 1, 4);
  const strong = hasAny(f.head, g.strong) || hasAny(f.body, g.strong);
  const weak = hasAny(f.head, g.weak);
  const textScore = strong ? 1 : (weak ? 0.45 : 0);
  const evidence = [];
  if (item.imageCount >= 3) evidence.push('商品画像' + item.imageCount + '枚');
  if (strong) evidence.push('ギフト映えの表記「' + strong + '」');

  return {
    score: T.clamp01(images * 0.45 + textScore * 0.55),
    source: 'mixed',
    evidence: evidence
  };
}

/* ---------- 7. 短尺動画化しやすさ（混合） ---------- */
/* 客観: 画像枚数と説明文の厚み（素材として使える情報量）
   推測: 開封・食べ比べなど画が動く語
   カタログギフトや商品券は、贈り物としては優秀でも画が持たないので減点する */
function videoFit(item, lex) {
  const f = fields(item);
  const g = lex.videoFit;
  const images = T.scale(item.imageCount, 1, 5);
  const caption = T.scale(item.captionLength, 200, 1200);
  const strong = hasAny(f.head, g.strong) || hasAny(f.body, g.strong);
  const weak = hasAny(f.head, g.weak);
  const hard = hasAny(f.head, g.hard);

  let score = T.clamp01(images * 0.34 + caption * 0.16 + (strong ? 0.4 : (weak ? 0.18 : 0)) + (item.catchcopy ? 0.1 : 0));
  const evidence = [];
  if (strong) evidence.push('動画にしやすい構成「' + strong + '」');
  if (hard) { score = Math.min(score, 0.3); evidence.push('画が持ちにくい商材「' + hard + '」'); }

  return { score: T.clamp01(score), source: 'mixed', evidence: evidence };
}

/* ---------- 8. 用途の広さ（混合） ---------- */
/* 推測: 当てはまる用途の種類数。多いほど同じ商品を複数の切り口で動画化できる
   客観: 価格。1000〜5000円は相手を選ばず使える */
function versatility(item, lex, priceCfg) {
  const f = fields(item);
  const text = f.head + ' ' + f.body;
  const hits = occasionsIn(text, lex);

  const occasionScore = T.clamp01(hits.length / 3);
  const p = Number(item.price) || 0;
  const priceBreadth = (p >= priceCfg.broadMin && p <= priceCfg.broadMax) ? 1 : 0.4;

  /* 性別を限定していないほど贈れる相手が広い */
  const female = hasAny(text, lex.audience.female);
  const male = hasAny(text, lex.audience.male);
  const unisex = (!female && !male) || (female && male) ? 1 : 0.55;

  return {
    score: T.clamp01(occasionScore * 0.5 + priceBreadth * 0.28 + unisex * 0.22),
    source: 'mixed',
    evidence: hits.length ? ['用途 ' + hits.length + '種（' + hits.slice(0, 3).join('・') + '）'] : [],
    occasions: hits
  };
}

/* ---------- 価格コレクションの割り当て（客観） ---------- */
function priceBand(price, bands) {
  for (const b of bands) {
    if (price >= b.min && price <= b.max) return b;
  }
  return null;
}

/* 指定したテキストに現れる用途だけを返す */
function occasionsIn(text, lex) {
  const hits = [];
  Object.keys(lex.occasions).forEach(function (key) {
    if (key.startsWith('$')) return;
    if (hasAny(text, lex.occasions[key])) hits.push(key);
  });
  return hits;
}

/* ---------- 推奨コレクション ---------- */
/* 同一ギフト棚の中でどの棚札に置くか。複数当たってよい */
function collectionsFor(item, lex, giftReadyScore, occasions, bands) {
  /* 説明文は使わない。プリザーブドフラワーの説明文に載っていた他商品の案内から
     「お菓子」を拾い、食べもの・スイーツの棚札が付く誤りが実データで起きた。
     棚札は商品名とキャッチコピーに書いてあることだけで決める */
  const f = fields(item);
  const text = f.head;
  const out = [];

  if (giftReadyScore >= 0.9) out.push('住所を知らなくても贈れる');
  const band = priceBand(Number(item.price) || 0, bands);
  if (band) out.push(band.label);
  if (hasAny(text, lex.food.words)) out.push('食べもの・スイーツ');

  const female = hasAny(text, lex.audience.female);
  const male = hasAny(text, lex.audience.male);
  if (female && !male) out.push('女性向け');
  if (male && !female) out.push('男性向け');

  if (occasions.indexOf('誕生日') >= 0) out.push('誕生日');
  if (occasions.indexOf('お礼') >= 0) out.push('お礼');
  if (occasions.indexOf('ちょっとしたお礼') >= 0) out.push('ちょっとしたプレゼント');

  return [...new Set(out)];
}

/* ---------- 推奨訴求角度 ---------- */
function angleFor(occasions, lex) {
  const key = occasions.find(function (o) { return lex.angles[o]; }) || '_default';
  const a = lex.angles[key];
  return { occasion: key === '_default' ? null : key, who: a.who, hook: a.hook };
}

/* ---------- 動画化優先度 ---------- */
/* 総合スコアが高くても画が持たなければ動画は作れない。
   逆に画が持っても売れなければ意味がない。両方を見る。

   ここでは素点だけを出す。A/B/C の割り当ては固定の閾値ではなく、
   ポートフォリオ内の相対順位で決める（portfolio.js）。
   絶対値で切ると、戦略やジャンルが変わって分布がずれた瞬間に
   「100件中85件がA」のような、優先度として機能しない結果になる */
function videoPriorityValue(total, videoFitScore) {
  return (Number(total) || 0) * 0.45 + (Number(videoFitScore) || 0) * 0.55;
}

const VIDEO_RANKS = {
  A: '最優先で動画化',
  B: '余力があれば動画化',
  C: '動画化しない（ROOM掲載のみ）'
};

function videoPriority(total, videoFitScore, rank) {
  const r = rank || 'C';
  return { rank: r, label: VIDEO_RANKS[r], value: videoPriorityValue(total, videoFitScore) };
}

/* ---------- まとめ ---------- */
function evaluate(item, strategy, lex) {
  const cfg = strategy.gift;
  const ready = giftReady(item, lex);
  const aff = affiliate(item, strategy.adHeat);
  const look = giftLook(item, lex);
  const video = videoFit(item, lex);
  const versat = versatility(item, lex, cfg.priceBreadth);

  return {
    scores: {
      giftReady: ready.score,
      affiliate: aff.score,
      giftLook: look.score,
      videoFit: video.score,
      versatility: versat.score
    },
    sources: {
      giftReady: ready.source,
      affiliate: aff.source,
      giftLook: look.source,
      videoFit: video.source,
      versatility: versat.source
    },
    occasions: versat.occasions,
    /* 用途の広さ（スコア）は説明文も見るが、棚札と型付きfacetは商品名だけで決める */
    occasionLabels: occasionsIn(fields(item).head, lex),
    collections: collectionsFor(item, lex, ready.score, occasionsIn(fields(item).head, lex), cfg.priceBands),
    angle: angleFor(versat.occasions, lex),
    reasons: ready.evidence.concat(aff.evidence, look.evidence, video.evidence, versat.evidence)
  };
}

module.exports = {
  evaluate, giftReady, affiliate, giftLook, videoFit, versatility,
  collectionsFor, angleFor, videoPriority, videoPriorityValue, VIDEO_RANKS, priceBand
};

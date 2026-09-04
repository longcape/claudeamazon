/* =========================================================
   FACETS — 商品の属性を型ごとに分ける
   ---------------------------------------------------------
   giftCollections は「食べもの・スイーツ」「誕生日」「3,000円前後」
   「女性向け」「住所を知らなくても贈れる」を1本の配列に混ぜていた。
   これらは意味の違う軸である。

     食品が56%   … 商材が偏っている。棚として問題になる
     誕生日が78% … 利用場面が広い。むしろ望ましい

   同じ「占有率」で警告すると後者まで異常扱いになるため、型で分ける。

     deliveryMode    address_free / physical_address / unknown
     productCategory sweets / beverage / flower / cosmetic / bath /
                     towel / tableware / message / food / other
     occasion        birthday / thanks / farewell / birth / return_gift / casual
     recipient       female / male / coworker / friend / family / unknown
     priceBand       1000 / 3000 / 5000 / other

   判定は商品名とキャッチコピーだけを見る。商品説明文には他商品の
   案内や配送の注意書きが混ざり、プリザーブドフラワーが「お菓子」と
   判定される類の誤りが実データで起きた。
   ========================================================= */
'use strict';

const T = require('../util/text');

const OCCASION_MAP = {
  '誕生日': 'birthday',
  'お礼': 'thanks',
  '退職・異動': 'farewell',
  '内祝い': 'return_gift',
  '季節行事': 'casual',
  'ちょっとしたお礼': 'casual',
  '自分へのご褒美': 'casual'
};

const BIRTH_WORDS = ['出産祝', '出産内祝', 'ベビー', '赤ちゃん'];

function headText(item) {
  return T.normalize((item.cleanName || item.name || '') + ' ' + (item.catchcopy || ''));
}

function firstMatch(text, table) {
  const keys = Object.keys(table || {});
  for (const key of keys) {
    if (key.charAt(0) === '$') continue;
    const words = table[key] || [];
    for (const w of words) {
      if (text.indexOf(w) >= 0) return key;
    }
  }
  return null;
}

function allMatches(text, table) {
  const out = [];
  Object.keys(table || {}).forEach(function (key) {
    if (key.charAt(0) === '$') return;
    if ((table[key] || []).some(function (w) { return text.indexOf(w) >= 0; })) out.push(key);
  });
  return out;
}

function priceBandOf(price, bands) {
  const p = Number(price) || 0;
  const hit = (bands || []).find(function (b) { return p >= b.min && p <= b.max; });
  if (!hit) return 'other';
  /* ラベルから代表額を拾う。1,000〜2,000円 → 1000 */
  const m = String(hit.label).replace(/,/g, '').match(/(\d+)/);
  return m ? m[1] : 'other';
}

/* occasions は gift.js が商品名から拾った日本語ラベルの配列 */
function occasionsOf(item, occasionLabels) {
  const text = headText(item);
  const out = [];
  (occasionLabels || []).forEach(function (label) {
    const key = OCCASION_MAP[label];
    if (key && out.indexOf(key) < 0) out.push(key);
  });
  if (BIRTH_WORDS.some(function (w) { return text.indexOf(w) >= 0; }) && out.indexOf('birth') < 0) {
    out.push('birth');
  }
  return out;
}

function derive(item, strategy, occasionLabels) {
  const cfg = strategy.facets || {};
  const text = headText(item);

  return {
    deliveryMode: firstMatch(text, cfg.deliveryMode) || 'unknown',
    productCategory: firstMatch(text, cfg.productCategory) || 'other',
    occasion: occasionsOf(item, occasionLabels),
    recipient: allMatches(text, cfg.recipient),
    priceBand: priceBandOf(item.price, (strategy.gift || {}).priceBands)
  };
}

/* ---------- 関連度 ---------- */

function complementaryPairs(cfg) {
  const set = new Set();
  (cfg.complementary || []).forEach(function (pair) {
    set.add(pair[0] + '|' + pair[1]);
    set.add(pair[1] + '|' + pair[0]);
  });
  return set;
}

function shareAny(a, b) {
  if (!a || !b || !a.length || !b.length) return false;
  return a.some(function (x) { return b.indexOf(x) >= 0; });
}

/* 2商品の関連度。買い物目的が揃うほど高い。
   同じタグを1つ共有しただけでは導線にならないので、
   重みの合計が minRelatedScore を超えて初めて関連とみなす。 */
function relatedness(a, b, strategy) {
  const cfg = strategy.cluster || {};
  const w = cfg.weights || {};
  const fa = a.facets;
  const fb = b.facets;
  if (!fa || !fb) return { score: 0, reasons: [] };

  /* 同一商品は導線にならない */
  if (a.itemCode && a.itemCode === b.itemCode) return { score: 0, reasons: ['同一商品'] };
  if (a.signature && b.signature && a.signature === b.signature) {
    return { score: 0, reasons: ['商品指紋が同一'] };
  }

  let score = 0;
  const reasons = [];

  if (fa.deliveryMode !== 'unknown' && fa.deliveryMode === fb.deliveryMode) {
    score += w.deliveryMode || 0; reasons.push('配送方式一致');
  }
  if (shareAny(fa.occasion, fb.occasion)) { score += w.occasion || 0; reasons.push('利用場面一致'); }
  if (shareAny(fa.recipient, fb.recipient)) { score += w.recipient || 0; reasons.push('相手一致'); }
  if (fa.priceBand !== 'other' && fa.priceBand === fb.priceBand) {
    score += w.priceBand || 0; reasons.push('価格帯一致');
  }

  const comp = complementaryPairs(cfg);
  if (fa.productCategory !== fb.productCategory &&
      comp.has(fa.productCategory + '|' + fb.productCategory)) {
    score += w.complementaryCategory || 0; reasons.push('補完カテゴリ');
  } else if (fa.productCategory === fb.productCategory && fa.productCategory !== 'other') {
    score += w.sameCategory || 0; reasons.push('同一カテゴリ');
  }

  return { score: score, reasons: reasons };
}

function isRelated(a, b, strategy) {
  const min = (strategy.cluster || {}).minRelatedScore || 0;
  return relatedness(a, b, strategy).score >= min;
}

/* ---------- クラスター構築 ----------
   買い物目的でまとまった小さな束を作る。
   1束の中は役割（bait / cv / traffic）で埋める。 */
function buildClusters(pool, strategy, opts) {
  const options = opts || {};
  const cfg = strategy.cluster || {};
  const size = options.size || cfg.clusterSize || 3;
  const want = options.count || 1;
  const roles = options.roles || null;
  const maxPerShop = options.maxPerShop || 0;

  const used = new Set();
  const shopCount = {};
  const clusters = [];

  const canTake = function (item) {
    if (used.has(item.itemCode)) return false;
    if (maxPerShop && (shopCount[item.shopCode] || 0) >= maxPerShop) return false;
    return true;
  };

  for (const seed of pool) {
    if (clusters.length >= want) break;
    if (!canTake(seed)) continue;

    /* 役割を指定された場合、seed は先頭役割を担う */
    const members = [seed];
    const takenRoles = roles ? [roles[0]] : [];

    for (let slot = 1; slot < size; slot += 1) {
      const wantRole = roles ? roles[slot] : null;
      let best = null;
      let bestScore = -1;
      for (const cand of pool) {
        if (!canTake(cand) || members.indexOf(cand) >= 0) continue;
        if (wantRole && cand.bestRole !== wantRole && !options.looseRole) continue;
        /* 束の全メンバーと関連していること */
        const scores = members.map(function (m) { return relatedness(m, cand, strategy).score; });
        const min = Math.min.apply(null, scores);
        if (min < (cfg.minRelatedScore || 0)) continue;
        /* 動画「3品セットなどで1回の買い物単価を上げるのが重要」。
           ただし単価を関連度より優先させない。加点は1,000円で0.4点にとどめ、
           関連度が同点のときだけ高いほうが勝つようにしている。 */
        const basketBonus = (Number(cand.price) || 0) * ((cfg.basket || {}).weight || 0);
        const total = scores.reduce(function (x, y) { return x + y; }, 0) + basketBonus;
        if (total > bestScore) { bestScore = total; best = cand; }
      }
      if (!best) break;
      members.push(best);
      if (wantRole) takenRoles.push(wantRole);
    }

    if (members.length < size) continue;
    /* 補完カテゴリを含まない束は、同じ棚を横に見せているだけで導線にならない */
    if (options.requireComplementary && !hasComplementaryPair(members, strategy)) continue;
    members.forEach(function (m) {
      used.add(m.itemCode);
      shopCount[m.shopCode] = (shopCount[m.shopCode] || 0) + 1;
    });
    clusters.push({
      id: 'C' + (clusters.length + 1),
      members: members.map(function (m, i) {
        return Object.assign({}, m, { clusterRole: roles ? roles[i] : m.bestRole });
      }),
      facets: members[0].facets,
      complementary: hasComplementaryPair(members, strategy),
      /* 束は「1回の買い物」。合計が目標に届かない束は、同じ棚を安い順に
         並べているだけで買い物単価が上がらない。 */
      basketTotal: members.reduce(function (a, m) { return a + (Number(m.price) || 0); }, 0),
      basketOk: members.reduce(function (a, m) { return a + (Number(m.price) || 0); }, 0)
        >= ((cfg.basket || {}).targetMin || 0),
      cohesion: members.length > 1
        ? Number((members.slice(1).reduce(function (a, m) {
          return a + relatedness(members[0], m, strategy).score;
        }, 0) / (members.length - 1)).toFixed(2))
        : 0
    });
  }

  return clusters;
}

/* 束の中に「別カテゴリだが一緒に贈ると成立する」組み合わせがあるか。
   関連度の閾値7は、配送方式一致(4)＋利用場面一致(3)だけで到達できる。
   候補の78%が場面タグを持つため、それだけだと同じカテゴリが3つ並んだ束も通り、
   客単価を上げる組み合わせにならない。実データのC1がクッキー→チョコ→アイスだった。
   スイーツ→飲み物のような補完が1組でもあれば、次に何を欲しくなるかの導線になる。 */
function hasComplementaryPair(members, strategy) {
  const comp = complementaryPairs((strategy.cluster || {}));
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = members[i].facets;
      const b = members[j].facets;
      if (!a || !b) continue;
      if (a.productCategory !== b.productCategory &&
          comp.has(a.productCategory + '|' + b.productCategory)) return true;
    }
  }
  return false;
}

/* ---------- カバレッジ ---------- */
/* 場面・相手・価格帯・配送方式は「偏り」ではなく「不足」を見る */
function coverage(items, strategy) {
  const cfg = (strategy.portfolio || {}).dominance || {};
  const facets = cfg.coverageFacets || [];
  const min = cfg.minCoveragePerValue || 1;
  const out = {};

  facets.forEach(function (facet) {
    const counts = {};
    items.forEach(function (i) {
      const v = i.facets ? i.facets[facet] : null;
      (Array.isArray(v) ? v : [v]).forEach(function (k) {
        if (k && k !== 'unknown' && k !== 'other') counts[k] = (counts[k] || 0) + 1;
      });
    });
    const thin = Object.keys(counts).filter(function (k) { return counts[k] < min; });
    out[facet] = { counts: counts, thin: thin, distinct: Object.keys(counts).length };
  });

  return out;
}

/* 商品カテゴリだけは占有率で警告する */
function categoryDominance(items, strategy) {
  const cfg = (strategy.portfolio || {}).dominance || {};
  const threshold = cfg.productCategoryWarn;
  if (!threshold || !items.length) return [];
  const counts = {};
  items.forEach(function (i) {
    const c = i.facets ? i.facets.productCategory : null;
    if (c && c !== 'other') counts[c] = (counts[c] || 0) + 1;
  });
  return Object.keys(counts).filter(function (k) {
    return counts[k] / items.length > threshold;
  }).map(function (k) {
    return { productCategory: k, count: counts[k], share: counts[k] / items.length };
  });
}

module.exports = {
  derive, relatedness, isRelated, buildClusters, coverage, categoryDominance, hasComplementaryPair,
  priceBandOf, occasionsOf, headText, OCCASION_MAP
};

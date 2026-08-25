/* =========================================================
   CROSSCHECK — 別キーワードでの再検索
   ---------------------------------------------------------
   ユーザー指定の判断材料そのもの。
   「同じ商品を別のキーワードで再検索して、また上位に出るか」
   一発の検索で上位なのは偶然もあるが、語を変えても上位に
   居座る商品は、楽天側が押している（＝広告と評価が乗っている）。
   上位候補にだけ追加でAPIを使う（全件に使うと時間が足りない）。
   ========================================================= */
'use strict';

const ichiba = require('../rakuten/ichiba');
const log = require('../util/log');
const T = require('../util/text');

const STOP_WORDS = new Set([
  'セット', '新品', '正規品', '公式', '日本製', '国産', 'ギフト', 'プレゼント',
  'おしゃれ', 'かわいい', 'シンプル', '人気', '大容量', '軽量', '便利'
]);

/* 候補群の中で「よく出てくる語」＝そのジャンルの一般名詞。
   これを組み合わせると、商品固有名ではない検索語になる。 */
function buildDocFrequency(candidates) {
  const df = new Map();
  candidates.forEach(function (item) {
    const seen = new Set(words(item.cleanName));
    seen.forEach(function (w) { df.set(w, (df.get(w) || 0) + 1); });
  });
  return df;
}

function words(name) {
  return T.normalize(name)
    .split(/[\s・,、\/｜|()（）]+/)
    .map(function (w) { return w.trim(); })
    .filter(function (w) {
      return w.length >= 2 && w.length <= 10 && !STOP_WORDS.has(w) && !/^\d+$/.test(w);
    });
}

/* その商品自身の名前から、元の検索語とは別の検索語を組み立てる */
function deriveKeywords(item, df, usedKeywords, count) {
  const ranked = words(item.cleanName)
    .map(function (w) { return { w: w, df: df.get(w) || 0 }; })
    .sort(function (a, b) { return b.df - a.df; });

  const generic = ranked.filter(function (r) { return r.df >= 2; }).map(function (r) { return r.w; });
  const specific = ranked.filter(function (r) { return r.df < 2; }).map(function (r) { return r.w; });

  const out = [];
  const push = function (kw) {
    const k = kw.trim();
    if (!k || usedKeywords.has(k) || out.indexOf(k) >= 0) return;
    out.push(k);
  };

  /* 一般名詞2語 → ジャンル内での居座りを見る */
  if (generic.length >= 2) push(generic[0] + ' ' + generic[1]);
  /* 一般名詞＋固有寄りの語 → 商品そのものの引きの強さを見る */
  if (generic.length >= 1 && specific.length >= 1) push(generic[0] + ' ' + specific[0]);
  if (generic.length >= 3) push(generic[1] + ' ' + generic[2]);
  if (generic.length >= 1) push(generic[0]);

  return out.slice(0, count || 2);
}

async function crosscheck(scored, strategy, opts) {
  const options = opts || {};
  const targets = scored.slice(0, options.limit || 60);
  const df = buildDocFrequency(scored);
  const usedKeywords = new Set();
  strategy.genre.subThemes.forEach(function (s) { s.keywords.forEach(function (k) { usedKeywords.add(k); }); });

  const perItem = options.keywordsPerItem || 2;
  log.step('再検索クロスチェック: ' + targets.length + ' 商品 × ' + perItem + ' 語（約' + Math.ceil(targets.length * perItem * 1.1) + '秒）');

  let n = 0;
  for (const item of targets) {
    const keywords = deriveKeywords(item, df, usedKeywords, perItem);
    const result = { queries: [], hits: 0, bestPosition: null, score: 0 };

    for (const kw of keywords) {
      let items;
      try {
        items = await ichiba.searchItems({
          keyword: kw,
          genreId: strategy.genre.rootGenreId,
          hits: 30,
          page: 1,
          sort: strategy.collect.crosscheckSorts[0] || 'standard',
          minPrice: strategy.filters.priceHardMin,
          maxPrice: strategy.filters.priceHardMax
        });
      } catch (e) {
        log.warn('再検索失敗 "' + kw + '": ' + e.message);
        continue;
      }
      const found = items.find(function (x) { return x.itemCode === item.itemCode; });
      /* 同一商品コードで無くても、同じショップの同じ商品名なら実質再出現とみなす */
      const sameProduct = found || items.find(function (x) {
        return x.shopCode === item.shopCode && T.coreName(x.name, 16) === T.coreName(item.name, 16);
      });
      result.queries.push({ keyword: kw, position: sameProduct ? sameProduct.position : null, exact: !!found });
      if (sameProduct) {
        result.hits += 1;
        if (result.bestPosition === null || sameProduct.position < result.bestPosition) result.bestPosition = sameProduct.position;
      }
    }

    /* 何語で再出現したか × どれだけ上位だったか */
    const hitRate = keywords.length ? result.hits / keywords.length : 0;
    const posBonus = result.bestPosition ? T.clamp01(1 - (result.bestPosition - 1) / 30) : 0;
    result.score = T.clamp01(hitRate * 0.6 + posBonus * 0.4);
    item.crosscheck = result;

    n += 1;
    if (n % 10 === 0) log.detail(n + '/' + targets.length + ' 再検索完了');
  }

  /* 再出現の強さを総合スコアへ反映する。ここは最大±12%程度に留める。
     クロスチェックはあくまで「判断材料」であって主軸ではない。 */
  scored.forEach(function (item) {
    if (!item.crosscheck) return;
    const adj = (item.crosscheck.score - 0.4) * 0.20;
    item.totalBeforeCrosscheck = item.total;
    item.total = T.clamp01(item.total + adj);
    Object.keys(item.roles).forEach(function (r) { item.roles[r] = T.clamp01(item.roles[r] + adj); });
    if (item.crosscheck.hits > 0) {
      item.reasons.push('別キーワード ' + item.crosscheck.hits + '/' + item.crosscheck.queries.length + ' 語で再出現（最高' + item.crosscheck.bestPosition + '位）');
    } else if (item.crosscheck.queries.length) {
      item.reasons.push('別キーワードでは上位に出ない（単発ヒットの疑い）');
    }
  });

  scored.sort(function (a, b) { return b.total - a.total; });
  return scored;
}

module.exports = { crosscheck, deriveKeywords, buildDocFrequency, words };

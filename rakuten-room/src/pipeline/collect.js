/* =========================================================
   COLLECT — 候補収集
   ---------------------------------------------------------
   楽天ROOMの中は見ない。楽天市場だけを見る。
   1ジャンルに紐づくサブテーマのキーワード群を、複数のソート
   軸で叩き、同じ商品が何回・どの位置で出てくるかを記録する。
   「何回もトップに出てくる」こと自体が優遇・広告加熱の証拠。
   ========================================================= */
'use strict';

const ichiba = require('../rakuten/ichiba');
const store = require('../util/store');
const time = require('../util/time');
const log = require('../util/log');
const T = require('../util/text');

function passesHardFilter(item, f) {
  if (item.reviewAverage < f.minReviewAverage) return 'レビュー平均' + f.minReviewAverage + '未満';
  if (item.reviewCount < f.minReviewCount) return 'レビュー' + f.minReviewCount + '件未満';
  if (item.price < f.priceHardMin || item.price > f.priceHardMax) return '価格レンジ外';
  if (f.requireAvailability && !item.availability) return '在庫なし';
  if (T.countMatches(item.name, f.excludeKeywords) > 0) return '除外ワード';
  return null;
}

function mergeOccurrence(bucket, item, ctx) {
  const existing = bucket.get(item.itemCode);
  const occ = {
    subTheme: ctx.subTheme,
    keyword: ctx.keyword,
    sort: ctx.sort,
    page: ctx.page,
    position: item.position || null,
    source: ctx.source
  };
  if (!existing) {
    item.occurrences = [occ];
    bucket.set(item.itemCode, item);
    return;
  }
  existing.occurrences.push(occ);
  /* 後から来たほうが新しい値を持っていることがあるので、動く指標だけ更新する */
  if (item.reviewCount > existing.reviewCount) existing.reviewCount = item.reviewCount;
  if (item.rank && (!existing.rank || item.rank < existing.rank)) existing.rank = item.rank;
  if (item.pointRate > existing.pointRate) existing.pointRate = item.pointRate;
}

async function collect(strategy, opts) {
  const options = opts || {};
  const cfg = strategy.collect;
  const bucket = new Map();
  const subThemes = strategy.genre.subThemes.filter(function (s) {
    return !options.subTheme || s.id === options.subTheme;
  });

  const queries = [];
  subThemes.forEach(function (sub) {
    sub.keywords.forEach(function (kw) {
      cfg.sorts.forEach(function (sort) {
        for (let page = 1; page <= cfg.pagesPerQuery; page += 1) {
          queries.push({ subTheme: sub.id, keyword: kw, sort: sort, page: page });
        }
      });
    });
  });

  log.step('候補収集: ' + queries.length + ' クエリ（約' + Math.ceil(queries.length * 1.1) + '秒）');

  let done = 0;
  for (const q of queries) {
    let items;
    try {
      items = await ichiba.searchItems({
        keyword: q.keyword,
        genreId: strategy.genre.rootGenreId,
        hits: cfg.hitsPerPage,
        page: q.page,
        sort: q.sort,
        minPrice: strategy.filters.priceHardMin,
        maxPrice: strategy.filters.priceHardMax
      });
    } catch (e) {
      log.warn(q.keyword + ' / ' + q.sort + ': ' + e.message);
      continue;
    }
    items.forEach(function (item) {
      mergeOccurrence(bucket, item, { subTheme: q.subTheme, keyword: q.keyword, sort: q.sort, page: q.page, source: 'search' });
    });
    done += 1;
    if (done % 10 === 0) log.detail(done + '/' + queries.length + ' 完了 / 累計 ' + bucket.size + ' 商品');
  }

  /* ランキングは「実際に売れている」外部確認。検索順位とは別の証拠になる */
  if (cfg.includeRanking) {
    const genreIds = [strategy.genre.rootGenreId].concat(strategy.genre.relatedGenreIds || []);
    for (const gid of genreIds) {
      /* period は realtime のみ。旧APIにあった daily は廃止され、
         wrong_parameter / set period from realtime で弾かれる */
      for (const period of ['realtime']) {
        try {
          const items = await ichiba.rankingItems({ genreId: gid, period: period });
          items.forEach(function (item) {
            mergeOccurrence(bucket, item, { subTheme: null, keyword: 'ranking:' + period, sort: 'ranking', page: 1, source: 'ranking' });
          });
        } catch (e) {
          log.warn('ランキング取得失敗 (' + gid + '/' + period + '): ' + e.message);
        }
      }
    }
  }

  const all = Array.from(bucket.values());
  const rejected = {};
  const candidates = all.filter(function (item) {
    const reason = passesHardFilter(item, strategy.filters);
    if (reason) {
      rejected[reason] = (rejected[reason] || 0) + 1;
      return false;
    }
    return true;
  });

  log.detail('取得 ' + all.length + ' 商品 → ハードフィルタ通過 ' + candidates.length + ' 商品');
  Object.keys(rejected).sort().forEach(function (k) { log.detail('  除外 ' + k + ': ' + rejected[k]); });

  const dateKey = time.dateKey();
  saveSnapshot(dateKey, all);
  store.writeJson('candidates-' + dateKey + '.json', {
    date: dateKey,
    genreId: strategy.genre.rootGenreId,
    queryCount: queries.length,
    fetched: all.length,
    rejected: rejected,
    items: candidates
  });

  return { date: dateKey, candidates: candidates, fetched: all.length, rejected: rejected };
}

/* スナップショット = レビュー件数の定点観測。翌日以降の差分が売上速度になる */
function saveSnapshot(dateKey, items) {
  const file = 'snapshot-' + dateKey + '.json';
  const prev = store.readJson(file, { date: dateKey, items: {} });
  items.forEach(function (item) {
    prev.items[item.itemCode] = {
      reviewCount: item.reviewCount,
      reviewAverage: item.reviewAverage,
      price: item.price,
      pointRate: item.pointRate,
      rank: item.rank || null
    };
  });
  prev.date = dateKey;
  prev.capturedAt = new Date().toISOString();
  store.writeJson(file, prev);
  return prev;
}

module.exports = { collect, saveSnapshot, passesHardFilter };

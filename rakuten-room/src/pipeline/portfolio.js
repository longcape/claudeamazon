/* =========================================================
   PORTFOLIO — 候補を 主力 / 準主力 / ロングテール に振り分ける
   ---------------------------------------------------------
   3つの層は「上位から順に切る」だけでは作れない。層ごとに仕事が違う。

     主力      SNSで繰り返し訴求する中心商品。
               売れる見込みだけでなく、短尺動画のネタとして成立することが要る。
     準主力    ROOM内での主要な選択肢。素直に総合スコア順。
     ロングテール
               用途・相手・予算の幅を埋める品ぞろえ。ここだけは
               スコア順ではなく「まだ埋まっていないコレクション」を優先する。
               上位から切ると価格帯と用途が偏り、棚として穴が開く。

   どの層も1ショップ集中を避ける。同じ店ばかりだと在庫・規約変更の
   巻き添えを一度に受ける。
   ========================================================= */
'use strict';

const giftLib = require('./gift');

function capOk(counts, key, max) {
  return !key || (counts[key] || 0) < max;
}
function bump(counts, key) {
  if (key) counts[key] = (counts[key] || 0) + 1;
}

/* 主力の並び。売れる見込みと動画適性の両方を見る */
function flagshipRank(item) {
  const v = (item.giftScores && item.giftScores.videoFit) || 0;
  return item.total * 0.6 + v * 0.4;
}

function pickTop(pool, size, opts) {
  /* 上限は層ごとではなくポートフォリオ全体で数える。
     層ごとに数えると同じ店が主力・準主力・ロングテールに重複して入り、
     在庫切れや規約変更の巻き添えを一度に受ける */
  const shopCounts = opts.shopCounts || {};
  const collCounts = {};
  const picked = [];
  const rest = [];

  pool.forEach(function (item) {
    if (picked.length >= size) { rest.push(item); return; }
    const primary = (item.giftCollections || [])[0] || null;
    if (!capOk(shopCounts, item.shopCode, opts.maxPerShop) ||
        !capOk(collCounts, primary, opts.maxPerCollection)) {
      rest.push(item);
      return;
    }
    bump(shopCounts, item.shopCode);
    bump(collCounts, primary);
    picked.push(item);
  });

  return { picked: picked, rest: rest };
}

/* ロングテールは穴埋め優先。まだ薄いコレクションを持つ商品から順に取る */
function pickCoverage(pool, size, covered, opts) {
  const shopCounts = opts.shopCounts || {};
  const picked = [];
  const remaining = pool.slice();
  const count = Object.assign({}, covered);

  while (picked.length < size && remaining.length) {
    let bestIdx = -1;
    let bestGain = -1;
    for (let i = 0; i < remaining.length; i += 1) {
      const item = remaining[i];
      if (!capOk(shopCounts, item.shopCode, opts.maxPerShop)) continue;
      /* まだ薄いコレクションをいくつ埋められるか。同点なら総合スコアで割る */
      const gain = (item.giftCollections || []).reduce(function (a, c) {
        return a + 1 / (1 + (count[c] || 0));
      }, 0) + item.total * 0.35;
      if (gain > bestGain) { bestGain = gain; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    const chosen = remaining.splice(bestIdx, 1)[0];
    bump(shopCounts, chosen.shopCode);
    (chosen.giftCollections || []).forEach(function (c) { count[c] = (count[c] || 0) + 1; });
    picked.push(chosen);
  }

  return { picked: picked, rest: remaining, coverage: count };
}

function tally(items, field) {
  const out = {};
  items.forEach(function (i) {
    const v = i[field];
    (Array.isArray(v) ? v : [v]).forEach(function (k) {
      if (k) out[k] = (out[k] || 0) + 1;
    });
  });
  return out;
}

/* scored は score.scoreAll の出力（total 降順）を想定する */
function build(scored, strategy) {
  const cfg = strategy.portfolio;
  const eligible = scored.filter(function (i) {
    return (i.giftScores ? i.giftScores.giftReady : 0) >= cfg.minGiftReady;
  });
  const rejected = scored.length - eligible.length;

  const shopCounts = {};

  const byFlagship = eligible.slice().sort(function (a, b) { return flagshipRank(b) - flagshipRank(a); });
  const flag = pickTop(byFlagship, cfg.flagship, {
    maxPerShop: cfg.maxPerShop, maxPerCollection: cfg.maxFlagshipPerCollection, shopCounts: shopCounts
  });

  const bySecondary = flag.rest.slice().sort(function (a, b) { return b.total - a.total; });
  const second = pickTop(bySecondary, cfg.secondary, {
    maxPerShop: cfg.maxPerShop, maxPerCollection: cfg.maxSecondaryPerCollection, shopCounts: shopCounts
  });

  const covered = tally(flag.picked.concat(second.picked), 'giftCollections');
  const tail = pickCoverage(second.rest, cfg.longtail, covered, { maxPerShop: cfg.maxPerShop, shopCounts: shopCounts });

  const label = function (list, tier) {
    return list.map(function (item) {
      const vp = giftLib.videoPriority(item.total, (item.giftScores || {}).videoFit || 0);
      return Object.assign({}, item, { tier: tier, videoPriority: vp });
    });
  };

  const flagship = label(flag.picked, '主力');
  const secondary = label(second.picked, '準主力');
  const longtail = label(tail.picked, 'ロングテール');
  const all = flagship.concat(secondary, longtail);

  return {
    flagship: flagship,
    secondary: secondary,
    longtail: longtail,
    all: all,
    summary: {
      target: { flagship: cfg.flagship, secondary: cfg.secondary, longtail: cfg.longtail },
      filled: { flagship: flagship.length, secondary: secondary.length, longtail: longtail.length },
      total: all.length,
      candidatePool: scored.length,
      eligible: eligible.length,
      rejectedByGiftReady: rejected,
      collections: tally(all, 'giftCollections'),
      videoPriority: tally(all.map(function (i) { return { r: i.videoPriority.rank }; }), 'r'),
      shops: Object.keys(tally(all, 'shopCode')).length
    }
  };
}

/* 後工程（短尺動画の制作）へ渡す形。1商品1行で読める */
function toRows(portfolio) {
  return portfolio.all.map(function (i) {
    return {
      itemCode: i.itemCode,
      name: i.cleanName || i.name || '',
      price: i.price,
      shopName: i.shopName,
      url: i.affiliateUrl || i.url,
      tier: i.tier,
      total: Number((Number(i.total) || 0).toFixed(4)),
      scores: i.scores,
      sources: i.giftSources,
      collections: i.giftCollections,
      occasions: i.giftOccasions,
      angle: i.giftAngle,
      videoPriority: i.videoPriority.rank,
      videoPriorityLabel: i.videoPriority.label
    };
  });
}

module.exports = { build, toRows, flagshipRank, pickTop, pickCoverage };

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
const selectLib = require('./select');
const facetsLib = require('./facets');

function capOk(counts, key, max) {
  return !key || (counts[key] || 0) < max;
}

/* かつては giftCollections へ一律の占有率上限をかけていたが、
   あの配列には商材カテゴリ（食品）と利用場面（誕生日）が混在していた。
   食品56%は棚の偏りだが、誕生日78%は場面が広いだけで問題ではない。
   同じ上限で切ると後者まで機械的に落ち、関連商品のまとまりを壊す。
   占有率の警告は商品カテゴリにだけ当て、場面・相手・価格帯・配送方式は
   カバレッジ不足として別に出す（src/pipeline/facets.js）。 */
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

/* 分位で選ぶ。固定閾値だけだとAPIや季節で分布が動いたときに効かなくなる。
   ただし絶対下限は割らない。件数が足りなくても緩めず、候補不足として報告する。 */
function quantileFloor(sortedTotals, ratio, absoluteFloor) {
  if (!sortedTotals.length) return absoluteFloor;
  const idx = Math.max(0, Math.min(sortedTotals.length - 1, Math.ceil(sortedTotals.length * ratio) - 1));
  return Math.max(absoluteFloor, sortedTotals[idx]);
}

/* scored は score.scoreAll の出力（total 降順）を想定する */
function build(scored, strategy) {
  const cfg = strategy.portfolio;
  /* 同じ商品の色違い・サイズ違いを畳む。投稿計画は select 側で畳んでいるが
     ポートフォリオはそこを通らないため、同一ショップの同一商品が
     主力に2件並ぶ事故が実データで起きた（リンツ、アンリ・シャルパンティエ等5組） */
  const deduped = selectLib.dedupe(scored);
  const sel = strategy.selection || {};
  const floor = sel.absoluteFloor !== undefined ? sel.absoluteFloor : 0;
  const quant = sel.quantile || {};

  const giftOk = deduped.filter(function (i) {
    return (i.giftScores ? i.giftScores.giftReady : 0) >= cfg.minGiftReady;
  });
  /* 絶対下限を割った候補は使わない。件数不足でもここは緩めない */
  const eligible = giftOk.filter(function (i) { return i.total >= floor; });
  const belowFloor = giftOk.length - eligible.length;
  const rejected = deduped.length - giftOk.length;
  const collapsed = scored.length - deduped.length;

  const totals = eligible.map(function (i) { return i.total; }).sort(function (a, b) { return b - a; });
  const flagshipFloor = quantileFloor(totals, quant.flagship || 0.2, floor);
  const secondaryFloor = quantileFloor(totals, quant.secondary || 0.5, floor);

  const shopCounts = {};

  /* 主力は上位分位の中から、売れる見込みと動画適性の両方で選ぶ。
     分位の中だけでショップ・コレクションの上限に当たって埋まらない場合は、
     分位の外へ順に降りて補う。ただし絶対下限より下へは決して降りない。
     「件数が足りないから閾値を下げる」ことと、
     「上位から順に見ていって埋まらなければ次を見る」ことは別である */
  const rankDesc = function (a, b) { return flagshipRank(b) - flagshipRank(a); };
  const inFlagQuantile = eligible.filter(function (i) { return i.total >= flagshipFloor; }).sort(rankDesc);
  const outFlagQuantile = eligible.filter(function (i) { return i.total < flagshipFloor; }).sort(rankDesc);
  const byFlagship = inFlagQuantile.concat(outFlagQuantile);
  const flag = pickTop(byFlagship, cfg.flagship, {
    maxPerShop: cfg.maxPerShop, maxPerCollection: cfg.maxFlagshipPerCollection,
    shopCounts: shopCounts
  });

  const pickedCodes = new Set(flag.picked.map(function (i) { return i.itemCode; }));
  const remain = eligible.filter(function (i) { return !pickedCodes.has(i.itemCode); });
  const totalDesc = function (a, b) { return b.total - a.total; };
  const bySecondary = remain.filter(function (i) { return i.total >= secondaryFloor; }).sort(totalDesc)
    .concat(remain.filter(function (i) { return i.total < secondaryFloor; }).sort(totalDesc));
  const second = pickTop(bySecondary, cfg.secondary, {
    maxPerShop: cfg.maxPerShop, maxPerCollection: cfg.maxSecondaryPerCollection,
    shopCounts: shopCounts
  });

  const taken = new Set(flag.picked.concat(second.picked).map(function (i) { return i.itemCode; }));
  const tailPool = eligible.filter(function (i) { return !taken.has(i.itemCode); });
  const covered = tally(flag.picked.concat(second.picked), 'giftCollections');
  const tail = pickCoverage(tailPool, cfg.longtail, covered, { maxPerShop: cfg.maxPerShop, shopCounts: shopCounts });

  const label = function (list, tier) {
    return list.map(function (item) {
      return Object.assign({}, item, {
        tier: tier,
        videoPriorityValue: giftLib.videoPriorityValue(item.total, (item.giftScores || {}).videoFit || 0)
      });
    });
  };

  const flagship = label(flag.picked, '主力');
  const secondary = label(second.picked, '準主力');
  const longtail = label(tail.picked, 'ロングテール');
  const all = flagship.concat(secondary, longtail);

  /* 動画化優先度はポートフォリオ内の相対順位で振る。
     制作できる本数は限られるので、Aは常に上位の一定割合に保つ */
  const vp = cfg.videoPriority || { aRatio: 0.2, bRatio: 0.3 };
  const ordered = all.slice().sort(function (a, b) { return b.videoPriorityValue - a.videoPriorityValue; });
  const aCount = Math.round(ordered.length * vp.aRatio);
  const bCount = Math.round(ordered.length * vp.bRatio);
  ordered.forEach(function (item, i) {
    const rank = i < aCount ? 'A' : (i < aCount + bCount ? 'B' : 'C');
    item.videoPriority = giftLib.videoPriority(item.total, (item.giftScores || {}).videoFit || 0, rank);
  });

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
      collapsedDuplicates: collapsed,
      eligible: eligible.length,
      rejectedByGiftReady: rejected,
      collections: tally(all, 'giftCollections'),
      selection: {
        absoluteFloor: floor,
        flagshipFloor: Number(flagshipFloor.toFixed(4)),
        secondaryFloor: Number(secondaryFloor.toFixed(4)),
        belowFloor: belowFloor,
        outsideFlagshipQuantile: flagship.filter(function (i) { return i.total < flagshipFloor; }).length,
        outsideSecondaryQuantile: secondary.filter(function (i) { return i.total < secondaryFloor; }).length,
        shortage: {
          flagship: Math.max(0, cfg.flagship - flagship.length),
          secondary: Math.max(0, cfg.secondary - secondary.length),
          longtail: Math.max(0, cfg.longtail - longtail.length)
        }
      },
      /* 占有率の警告は商品カテゴリにだけ当てる */
      categoryDominance: facetsLib.categoryDominance(all, strategy),
      /* 場面・相手・価格帯・配送方式は偏りではなく不足を見る */
      coverage: facetsLib.coverage(all, strategy),
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

module.exports = { build, toRows, flagshipRank, pickTop, pickCoverage, quantileFloor };

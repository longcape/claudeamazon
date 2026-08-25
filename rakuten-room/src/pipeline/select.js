/* =========================================================
   SELECT — 最終選定
   ---------------------------------------------------------
   スコアが高い順に並べるだけでは棚が壊れる。
   ・同じショップばかり  ・同じサブテーマばかり
   ・役割（評価取り/売上/送客）の比率が崩れる
   ・過去に投稿した商品の重複
   を制約として入れた上で、役割ごとに枠を埋めていく。
   ========================================================= */
'use strict';

const store = require('../util/store');
const T = require('../util/text');
const log = require('../util/log');

const ROLES = ['bait', 'cv', 'traffic'];

function loadHistory() {
  const h = store.readJson('history.json', { posted: {} });
  if (!h.posted) h.posted = {};
  return h;
}

/* 同一商品の別出品を畳むための指紋。
   名前の頭だけで畳むと「シンク下 収納ラック」系が全部1つに潰れるので、
   商品名に現れる数値（段数・本数・サイズ）も指紋に混ぜて別物を守る。 */
function productSignature(item) {
  const head = T.coreName(item.name, 24).replace(/\s/g, '');
  const numbers = (T.normalize(item.name).match(/\d+/g) || []).slice(0, 6).join(',');
  return T.hash(head + '|' + numbers);
}

/* 同一商品の別出品・色違いを1つに畳む */
function dedupe(scored) {
  const best = new Map();
  scored.forEach(function (item) {
    const sig = productSignature(item);
    const prev = best.get(sig);
    if (!prev || item.total > prev.total) best.set(sig, item);
  });
  return Array.from(best.values()).sort(function (a, b) { return b.total - a.total; });
}

/* 上位候補が集まっているサブテーマだけに絞る。散らかりの根を断つ */
function pickSubThemes(pool, strategy, spread) {
  const agg = new Map();
  pool.slice(0, 120).forEach(function (item) {
    const k = item.primarySubTheme || '_none';
    const cur = agg.get(k) || { sum: 0, n: 0 };
    cur.sum += item.total;
    cur.n += 1;
    agg.set(k, cur);
  });
  const ranked = Array.from(agg.entries())
    .filter(function (e) { return e[0] !== '_none' && e[1].n >= 3; })
    .map(function (e) { return { id: e[0], score: e[1].sum / e[1].n, n: e[1].n }; })
    .sort(function (a, b) { return b.score - a.score; });

  const max = (spread && spread.maxSubThemes) || 4;
  const min = (spread && spread.minSubThemes) || 2;
  const chosen = ranked.slice(0, max).map(function (r) { return r.id; });
  if (chosen.length < min) {
    /* 足りなければ件数が多い順に補う */
    ranked.slice(max).forEach(function (r) { if (chosen.length < min) chosen.push(r.id); });
  }
  return { chosen: chosen, ranked: ranked };
}

/* mix を size ぴったりに正規化したうえで、役割を交互に並べたスロット列にする。
   役割ごとにまとめて並べると、先頭の役割が良い商品とショップ枠を
   総取りしてしまい、後ろの役割に残りかすが回る。 */
function buildSlots(mix, size) {
  const total = ROLES.reduce(function (a, r) { return a + (mix[r] || 0); }, 0);
  const counts = {};
  let assigned = 0;
  ROLES.forEach(function (role, i) {
    if (i === ROLES.length - 1) { counts[role] = Math.max(0, size - assigned); return; }
    counts[role] = total > 0 ? Math.round(size * (mix[role] || 0) / total) : 0;
    assigned += counts[role];
  });

  const slots = [];
  const remaining = Object.assign({}, counts);
  while (slots.length < size) {
    /* 残り枠が最も多い役割から1つずつ取る */
    const role = ROLES.filter(function (r) { return remaining[r] > 0; })
      .sort(function (a, b) { return remaining[b] - remaining[a]; })[0];
    if (!role) break;
    slots.push(role);
    remaining[role] -= 1;
  }
  return slots;
}

function selectSet(scored, strategy, opts) {
  const options = opts || {};
  const size = options.size || strategy.launch.size;
  const mix = options.mix || strategy.launch.mix;
  const minScore = options.minScore !== undefined ? options.minScore : strategy.launch.minSelectionScore;
  const history = options.ignoreHistory ? { posted: {} } : loadHistory();

  const deduped = dedupe(scored).filter(function (item) {
    return !history.posted[item.itemCode];
  });

  /* 初日は売上速度が未計測で全体のスコアが低く出る。
     しきい値に届かないからといって枠を空けるのは本末転倒なので、
     枠が埋まらないときだけ基準を段階的に下げる（下げた事実は記録する）。 */
  const maxPerShop = strategy.filters.maxItemsPerShop;
  const shopsNeeded = Math.ceil(size / maxPerShop);
  const enough = function (list) {
    /* 件数だけ見てもダメで、1ショップ上限があるぶんショップ数も要る */
    const shops = new Set(list.map(function (i) { return i.shopCode; }));
    return list.length >= size && shops.size >= shopsNeeded;
  };

  let usedMinScore = minScore;
  let pool = deduped.filter(function (item) { return item.total >= usedMinScore; });
  while (!enough(pool) && usedMinScore > 0.2) {
    usedMinScore = Number((usedMinScore - 0.04).toFixed(2));
    pool = deduped.filter(function (item) { return item.total >= usedMinScore; });
  }
  if (usedMinScore < minScore) {
    log.warn('スコア基準を ' + minScore + ' → ' + usedMinScore + ' に緩めました（基準以上の候補が ' +
      deduped.filter(function (i) { return i.total >= minScore; }).length + ' 件しか無いため）');
  }

  const spread = pickSubThemes(pool, strategy, options.spread || strategy.launch.subThemeSpread);
  if (spread.chosen.length) {
    const allowed = new Set(spread.chosen);
    const filtered = pool.filter(function (item) { return allowed.has(item.primarySubTheme); });
    /* 絞りすぎて枠が埋まらないなら緩める */
    if (filtered.length >= size) pool = filtered;
  }

  const shopUsed = new Map();
  const subUsed = new Map();
  const takenCodes = new Set();
  const maxPerSub = Math.max(2, Math.floor(size * strategy.shelf.maxShareSingleSubTheme));

  const slots = buildSlots(mix, size);

  const picked = [];
  const shortage = {};
  const reasons = { shop: 0, subTheme: 0, pool: 0 };

  slots.forEach(function (role) {
    const blocked = { shop: 0, subTheme: 0 };
    const cand = pool.filter(function (item) {
      if (takenCodes.has(item.itemCode)) return false;
      if ((shopUsed.get(item.shopCode) || 0) >= maxPerShop) { blocked.shop += 1; return false; }
      if ((subUsed.get(item.primarySubTheme) || 0) >= maxPerSub) { blocked.subTheme += 1; return false; }
      return true;
    }).sort(function (a, b) { return b.roles[role] - a.roles[role]; });

    const chosen = cand[0];
    if (!chosen) {
      shortage[role] = (shortage[role] || 0) + 1;
      if (blocked.shop > blocked.subTheme) reasons.shop += 1;
      else if (blocked.subTheme > 0) reasons.subTheme += 1;
      else reasons.pool += 1;
      return;
    }
    takenCodes.add(chosen.itemCode);
    shopUsed.set(chosen.shopCode, (shopUsed.get(chosen.shopCode) || 0) + 1);
    subUsed.set(chosen.primarySubTheme, (subUsed.get(chosen.primarySubTheme) || 0) + 1);
    picked.push(Object.assign({}, chosen, { role: role, roleScore: chosen.roles[role] }));
  });

  Object.keys(shortage).forEach(function (r) {
    log.warn('役割 ' + r + ' の枠が ' + shortage[r] + ' 件埋まりませんでした');
  });
  /* 埋まらない原因は3つしかない。どれなのかを名指しする */
  if (reasons.shop) {
    log.warn('原因: 1ショップ ' + maxPerShop + ' 商品までの上限。' + size + ' 件出すには最低 ' +
      Math.ceil(size / maxPerShop) + ' ショップぶんの候補が要ります（filters.maxItemsPerShop で調整）');
  }
  if (reasons.subTheme) {
    log.warn('原因: 1サブテーマ ' + maxPerSub + ' 件までの上限。サブテーマを増やすか shelf.maxShareSingleSubTheme を上げてください');
  }
  if (reasons.pool) {
    log.warn('原因: 候補そのものが不足。config/strategy.json の genre.subThemes にキーワードを足して collect し直してください');
  }

  return {
    picked: picked,
    minScoreUsed: usedMinScore,
    subThemes: spread.chosen,
    subThemeRanking: spread.ranked,
    poolSize: pool.length,
    shortage: shortage,
    shortageReasons: reasons
  };
}

function recordPosted(items, dateKey) {
  const history = loadHistory();
  items.forEach(function (item) {
    history.posted[item.itemCode] = {
      date: dateKey,
      role: item.role,
      name: item.core,
      price: item.price,
      subTheme: item.primarySubTheme
    };
  });
  history.updatedAt = new Date().toISOString();
  store.writeJson('history.json', history);
  return history;
}

module.exports = { selectSet, dedupe, pickSubThemes, loadHistory, recordPosted, productSignature, buildSlots, ROLES };

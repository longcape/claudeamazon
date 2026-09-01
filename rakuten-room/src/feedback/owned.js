/* =========================================================
   OWNED — 運用者が実際に持っている商品
   ---------------------------------------------------------
   自分が買った物・持っている物には2つの強みがある。

     オリジナル写真を撮れる（ROOMランク上とくに重要とされている）
     実体験を書ける（借り物の説明より具体的に書ける）

   この情報は楽天APIからは取れない。運用者しか知らない。
   **楽天の購入履歴を勝手に取りに行かない。** 本人が申告したものだけを記録する。

   いまは投稿実績が0件なので、スコアへは反映しない。
   まず「どれを持っているか」を貯めるだけにする。使い道は
   最初の12投稿の結果を見てから決める。
   ========================================================= */
'use strict';

const store = require('../util/store');

const FILE = 'owned.json';

function load() {
  const data = store.readJson(FILE, { items: {} });
  if (!data.items) data.items = {};
  return data;
}

/* 1件を記録する。すでにあれば上書きする */
function mark(itemCode, opts) {
  const options = opts || {};
  const data = load();
  const prev = data.items[itemCode] || {};

  data.items[itemCode] = {
    ownedByUser: options.owned === undefined ? true : !!options.owned,
    /* 写真を撮れるかは、持っていることとは別。届く前や消耗済みのこともある */
    originalPhotoCandidate: options.photo === undefined
      ? (prev.originalPhotoCandidate === undefined ? true : prev.originalPhotoCandidate)
      : !!options.photo,
    canWriteRealReview: options.review === undefined
      ? (prev.canWriteRealReview === undefined ? true : prev.canWriteRealReview)
      : !!options.review,
    note: options.note === undefined ? (prev.note || '') : String(options.note),
    name: options.name || prev.name || '',
    recordedAt: new Date().toISOString()
  };

  data.updatedAt = new Date().toISOString();
  store.writeJson(FILE, data);
  return data.items[itemCode];
}

function remove(itemCode) {
  const data = load();
  if (!data.items[itemCode]) return false;
  delete data.items[itemCode];
  data.updatedAt = new Date().toISOString();
  store.writeJson(FILE, data);
  return true;
}

function get(itemCode) {
  return load().items[itemCode] || null;
}

function isOwned(itemCode) {
  const e = get(itemCode);
  return !!(e && e.ownedByUser);
}

/* オリジナル写真を撮れる候補。ROOMランクの条件に効くとされている */
function photoCandidates() {
  const items = load().items;
  return Object.keys(items)
    .filter(function (k) { return items[k].ownedByUser && items[k].originalPhotoCandidate; })
    .map(function (k) { return Object.assign({ itemCode: k }, items[k]); });
}

function summary() {
  const items = load().items;
  const codes = Object.keys(items);
  return {
    total: codes.length,
    photoCandidates: photoCandidates().length,
    reviewable: codes.filter(function (k) { return items[k].canWriteRealReview; }).length
  };
}

module.exports = { load, mark, remove, get, isOwned, photoCandidates, summary, FILE };

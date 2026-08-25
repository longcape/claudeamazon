/* =========================================================
   RAKUTEN ICHIBA — 商品検索 / ランキング / ジャンル
   APIの生レスポンスを、以降のパイプラインが扱う内部形へ
   正規化する。ここから先はもう楽天APIの都合を知らない。
   ========================================================= */
'use strict';

const client = require('./client');
const T = require('../util/text');

const EP_SEARCH = 'https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601';
const EP_RANKING = 'https://app.rakuten.co.jp/services/api/IchibaItem/Ranking/20220601';
const EP_GENRE = 'https://app.rakuten.co.jp/services/api/IchibaGenre/Search/20140222';

function imageList(raw) {
  const src = raw || [];
  return src.map(function (v) {
    const url = typeof v === 'string' ? v : (v && v.imageUrl) || '';
    /* 楽天の画像URLは末尾の _ex= でサイズが決まる。原寸判定のため素のまま持つ */
    return url;
  }).filter(Boolean);
}

function normalizeItem(raw) {
  const name = raw.itemName || '';
  const caption = T.stripHtml(raw.itemCaption || '');
  const images = imageList(raw.mediumImageUrls);
  return {
    itemCode: raw.itemCode || '',
    name: name,
    cleanName: T.cleanItemName(name),
    core: T.coreName(name),
    catchcopy: T.normalize(raw.catchcopy || ''),
    price: Number(raw.itemPrice) || 0,
    url: raw.itemUrl || '',
    affiliateUrl: raw.affiliateUrl || raw.itemUrl || '',
    images: images,
    imageCount: images.length,
    caption: caption,
    captionLength: caption.length,
    reviewCount: Number(raw.reviewCount) || 0,
    reviewAverage: Number(raw.reviewAverage) || 0,
    affiliateRate: Number(raw.affiliateRate) || 0,
    pointRate: Number(raw.pointRate) || 1,
    pointCampaign: !!(raw.pointRateStartTime || raw.pointRateEndTime),
    pointRateEndTime: raw.pointRateEndTime || '',
    shopCode: raw.shopCode || '',
    shopName: T.normalize(raw.shopName || ''),
    shopUrl: raw.shopUrl || '',
    shopOfTheYear: Number(raw.shopOfTheYearFlag) === 1,
    genreId: String(raw.genreId || ''),
    tagIds: raw.tagIds || [],
    availability: Number(raw.availability) === 1,
    asuraku: Number(raw.asurakuFlag) === 1,
    postageFree: Number(raw.postageFlag) === 0,
    rank: raw.rank ? Number(raw.rank) : null
  };
}

function itemsOf(json) {
  const list = (json && json.Items) || [];
  return list.map(function (row) {
    /* formatVersion=1 だと { Item: {...} } で包まれる */
    return normalizeItem(row && row.Item ? row.Item : row);
  });
}

/* 商品検索。position は検索結果内の順位（1始まり）で、広告・優遇の強さの手がかりになる */
async function searchItems(opts) {
  const json = await client.call(EP_SEARCH, {
    keyword: opts.keyword,
    genreId: opts.genreId,
    hits: opts.hits || 30,
    page: opts.page || 1,
    sort: opts.sort || 'standard',
    minPrice: opts.minPrice,
    maxPrice: opts.maxPrice,
    availability: opts.availability === false ? 0 : 1,
    imageFlag: 1,
    field: 1
  });
  const hits = opts.hits || 30;
  const base = ((opts.page || 1) - 1) * hits;
  return itemsOf(json).map(function (item, i) {
    item.position = base + i + 1;
    return item;
  });
}

/* ジャンル別ランキング。「いま実際に売れている商品」の外部確認に使う */
async function rankingItems(opts) {
  const json = await client.call(EP_RANKING, {
    genreId: opts.genreId,
    period: opts.period || 'realtime',
    page: opts.page || 1
  });
  return itemsOf(json);
}

/* ジャンルの親子関係。カテゴリ相関性の計算と、設定ジャンルの実在確認に使う */
async function genre(genreId) {
  const json = await client.call(EP_GENRE, { genreId: genreId || '0' });
  const cur = json.current || {};
  return {
    id: String(cur.genreId || genreId || '0'),
    name: cur.genreName || '',
    level: cur.genreLevel || 0,
    parents: (json.parents || []).map(function (p) { return { id: String(p.genreId), name: p.genreName }; }),
    children: (json.children || []).map(function (c) {
      const g = c.child || c;
      return { id: String(g.genreId), name: g.genreName, level: g.genreLevel };
    })
  };
}

module.exports = { searchItems, rankingItems, genre, normalizeItem, EP_SEARCH, EP_RANKING, EP_GENRE };

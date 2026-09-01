/* =========================================================
   RAKUTEN ICHIBA — 商品検索 / ランキング / ジャンル
   APIの生レスポンスを、以降のパイプラインが扱う内部形へ
   正規化する。ここから先はもう楽天APIの都合を知らない。
   ========================================================= */
'use strict';

const client = require('./client');
const T = require('../util/text');

/* 旧 app.rakuten.co.jp/services/api/... 系は 2026-02-09 に停止済み。
   現行は openapi.rakuten.co.jp 配下で、APIごとにパスの接頭辞が違う */
const EP_SEARCH = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701';
const EP_RANKING = 'https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601';
const EP_GENRE = 'https://openapi.rakuten.co.jp/ichibagt/api/IchibaGenre/Search/20260701';

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
    /* 2026-07-01版で tagIds は attributeIds に改名された。旧名も残して両対応にする */
    tagIds: raw.attributeIds || raw.tagIds || [],
    availability: Number(raw.availability) === 1,
    asuraku: Number(raw.asurakuFlag) === 1,
    postageFree: Number(raw.postageFlag) === 0,
    rank: raw.rank ? Number(raw.rank) : null
  };
}

function itemsOf(json) {
  /* 旧APIは Items、新APIのドキュメントは items 表記。どちらでも拾えるようにしておく */
  const list = (json && (json.Items || json.items)) || [];
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
    imageFlag: 1
    /* field は指定しない。2026-07-01版で意味が変わり、
       旧: 0=全情報取得 / 1=一部の情報のみ
       新: 0=広めに検索 / 1=絞って検索（既定1）
       返すフィールドの制御は elements に移り、未指定なら全項目返る。
       ここで 0 を渡すと検索が広がるだけで、候補の精度が下がる */
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
  /* 2026-07-01版で応答の形が変わった。
     旧: { current:{genreName,genreLevel}, parents:[], children:[{child:{...}}] }
     新: { genre:{nameJa,level}, ancestors:[], siblings:[], children:[{genreId,nameJa,level}] } */
  const cur = json.genre || json.current || {};
  const flat = function (g) {
    const src = g && g.child ? g.child : g;
    return {
      id: String(src.genreId),
      name: src.nameJa || src.genreName || '',
      level: src.level || src.genreLevel || 0
    };
  };
  return {
    id: String(cur.genreId || genreId || '0'),
    name: cur.nameJa || cur.genreName || '',
    level: cur.level || cur.genreLevel || 0,
    parents: (json.ancestors || json.parents || []).map(flat),
    children: (json.children || []).map(flat)
  };
}

module.exports = { searchItems, rankingItems, genre, normalizeItem, EP_SEARCH, EP_RANKING, EP_GENRE };

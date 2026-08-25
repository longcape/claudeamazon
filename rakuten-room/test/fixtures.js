/* テスト用の擬似候補。楽天APIを叩かずにパイプライン全体を通す */
'use strict';

const SUBS = ['kitchen-storage', 'fridge', 'closet', 'sink-bath'];
const NAMES = [
  'シンク下 収納ラック 伸縮 2段 スライド',
  '冷蔵庫 収納ケース 仕切り 透明 4個組',
  'クローゼット ハンガー 滑らない 20本',
  '歯ブラシ ホルダー 浮かせる 吸盤 5本',
  '調味料 ラック 2段 引き出し キッチン',
  '保存容器 密閉 食洗機対応 6個セット',
  '衣類 圧縮 袋 折りたたみ 10枚',
  '洗面台 収納 マグネット ラック',
  '水切りラック 伸縮 スライド ステンレス',
  '冷凍庫 仕切り スタンド 立てる 収納'
];

function makeItem(i, opts) {
  const o = opts || {};
  const name = NAMES[i % NAMES.length] + ' ' + (i + 1);
  const sub = SUBS[i % SUBS.length];
  const price = o.price !== undefined ? o.price : 1500 + ((i * 137) % 1400);
  return {
    itemCode: 'shop' + (i % 14) + ':item' + i,
    name: name,
    cleanName: name,
    core: name.slice(0, 20),
    catchcopy: '',
    price: price,
    url: 'https://item.rakuten.co.jp/shop' + (i % 14) + '/item' + i + '/',
    affiliateUrl: 'https://hb.afl.rakuten.co.jp/ichiba/xxxx/item' + i,
    images: ['https://thumbnail.image.rakuten.co.jp/a.jpg', 'https://thumbnail.image.rakuten.co.jp/b.jpg', 'https://thumbnail.image.rakuten.co.jp/c.jpg'],
    imageCount: 3,
    caption: 'この商品は伸縮して隙間にぴったり収まります。'.repeat(20),
    captionLength: 20 * 22,
    reviewCount: 120 + (i * 53) % 4000,
    reviewAverage: 4.05 + ((i * 7) % 9) / 10,
    affiliateRate: 2 + (i % 14),
    pointRate: 1 + (i % 6),
    pointCampaign: i % 3 === 0,
    pointRateEndTime: '',
    shopCode: 'shop' + (i % 14),
    shopName: 'テスト商店' + (i % 14),
    shopUrl: 'https://www.rakuten.co.jp/shop' + (i % 14) + '/',
    shopOfTheYear: i % 5 === 0,
    genreId: '100938',
    tagIds: [],
    availability: true,
    asuraku: i % 4 === 0,
    postageFree: i % 2 === 0,
    rank: i < 5 ? i + 1 : null,
    occurrences: [
      { subTheme: sub, keyword: 'テスト ' + sub, sort: 'standard', page: 1, position: 1 + (i % 12), source: 'search' },
      { subTheme: sub, keyword: '別ワード ' + sub, sort: '-reviewCount', page: 1, position: 2 + (i % 8), source: 'search' }
    ].concat(i < 5 ? [{ subTheme: null, keyword: 'ranking:daily', sort: 'ranking', page: 1, position: null, source: 'ranking' }] : [])
  };
}

function candidates(n) {
  const out = [];
  for (let i = 0; i < (n || 90); i += 1) out.push(makeItem(i));
  return out;
}

module.exports = { candidates, makeItem, SUBS, NAMES };

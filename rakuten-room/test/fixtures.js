/* テスト用の擬似候補。楽天APIを叩かずにパイプライン全体を通す */
'use strict';

/* コレクション。ソーシャルギフトという1つの棚の中の区分であり、別ジャンルではない */
/* ショップ周期は商品名の周期(10)と互いに素にする。
   同じ名前が同じ店に再登場すると dedupe が畳んでしまい、
   実データには無い衝突がテストだけで起きるため */
const SUBS = ['address-free', 'sweets', 'price-1000', 'price-3000', 'price-5000', 'occasion'];
const NAMES = [
  'ソーシャルギフト 焼き菓子 詰め合わせ 化粧箱 誕生日',
  'eギフト ハンドクリーム セット 個包装 お礼 化粧箱',
  '住所不要 ギフト コーヒー ドリップ 詰め合わせ',
  'プチギフト 入浴剤 アソート 退職 送別 メッセージカード',
  '内祝い スイーツ ギフトボックス のし対応 詰め合わせ',
  'LINE ギフト タオル セット 化粧箱 母の日',
  '誕生日 プレゼント スキンケア ギフト セット ラッピング無料',
  'お礼 プチギフト 焼き菓子 個包装 ギフト包装',
  '出産内祝い タオル ギフト 化粧箱 のし',
  '選べる eギフト ソープ 住所不要 詰め合わせ'
];

/* ギフト用途として成立しない商品。NG検査が弾けることを確かめるために使う */
const NON_GIFT_NAMES = [
  '業務用 洗剤 詰め替え 5L',
  '交換用 フィルター 10枚 汎用',
  '延長コード 3m 電源タップ',
  '園芸用 培養土 20L',
  '自動車用 ワイパーブレード 650mm'
];

function makeItem(i, opts) {
  const o = opts || {};
  const name = NAMES[i % NAMES.length] + ' ' + (i + 1);
  const sub = SUBS[i % SUBS.length];
  /* ギフトの価格帯は1,000〜2,000 / 3,000前後 / 5,000前後の3コレクションにまたがる */
  const price = o.price !== undefined ? o.price : 1200 + ((i * 371) % 4200);
  return {
    itemCode: 'shop' + (i % 41) + ':item' + i,
    name: name,
    cleanName: name,
    core: name.slice(0, 20),
    catchcopy: '',
    price: price,
    url: 'https://item.rakuten.co.jp/shop' + (i % 41) + '/item' + i + '/',
    affiliateUrl: 'https://hb.afl.rakuten.co.jp/ichiba/xxxx/item' + i,
    images: ['https://thumbnail.image.rakuten.co.jp/a.jpg', 'https://thumbnail.image.rakuten.co.jp/b.jpg', 'https://thumbnail.image.rakuten.co.jp/c.jpg'],
    imageCount: 3,
    caption: 'ギフト用の化粧箱入りで、のし・メッセージカードに対応しています。'.repeat(20),
    captionLength: 20 * 22,
    reviewCount: 120 + (i * 53) % 4000,
    reviewAverage: 4.05 + ((i * 7) % 9) / 10,
    affiliateRate: 2 + (i % 41),
    pointRate: 1 + (i % 6),
    pointCampaign: i % 3 === 0,
    pointRateEndTime: '',
    shopCode: 'shop' + (i % 41),
    shopName: 'テスト商店' + (i % 41),
    shopUrl: 'https://www.rakuten.co.jp/shop' + (i % 41) + '/',
    shopOfTheYear: i % 5 === 0,
    genreId: '551167',
    tagIds: [],
    availability: true,
    asuraku: i % 4 === 0,
    postageFree: i % 2 === 0,
    rank: i < 5 ? i + 1 : null,
    occurrences: [
      { subTheme: sub, keyword: 'テスト ' + sub, sort: 'standard', page: 1, position: 1 + (i % 12), source: 'search' },
      { subTheme: sub, keyword: '別ワード ' + sub, sort: '-reviewCount', page: 1, position: 2 + (i % 8), source: 'search' }
    ].concat(i < 5 ? [{ subTheme: null, keyword: 'ranking:realtime', sort: 'ranking', page: 1, position: null, source: 'ranking' }] : [])
  };
}

function candidates(n) {
  const out = [];
  for (let i = 0; i < (n || 90); i += 1) out.push(makeItem(i));
  return out;
}

/* ギフト適性ゼロの候補。NG検査とポートフォリオの足切りの検証に使う */
function nonGiftCandidates(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const item = makeItem(i);
    const name = NON_GIFT_NAMES[i % NON_GIFT_NAMES.length] + " " + (i + 1);
    item.name = name;
    item.cleanName = name;
    item.core = name.slice(0, 20);
    item.caption = "用途に合わせてお使いください。".repeat(20);
    out.push(item);
  }
  return out;
}

module.exports = { candidates, makeItem, SUBS, NAMES, nonGiftCandidates };

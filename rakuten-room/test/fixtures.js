/* テスト用の擬似候補。楽天APIを叩かずにパイプライン全体を通す */
'use strict';

/* コレクション。ソーシャルギフトという1つの棚の中の区分であり、別ジャンルではない */
/* ショップ周期は商品名の周期(10)と互いに素にする。
   同じ名前が同じ店に再登場すると dedupe が畳んでしまい、
   実データには無い衝突がテストだけで起きるため */
const SUBS = ['address-free', 'sweets', 'price-1000', 'price-3000', 'price-5000', 'occasion'];
/* 2026-09-04、動画の「1ジャンル＋関連商品以外は出さない」に合わせ、
   食品（スイーツ・食べもの・飲みもの）を中心にした構成へ変えた。
   単一ジャンル制約が働くことを確かめるため、圏外のカテゴリも2件だけ混ぜてある。
   主力はコレクション単位で上限があるため、価格帯以外の棚札（住所なし等）が
   付く商品も混ぜておかないと主力20件が埋まらない。 */
const NAMES = [
  '焼き菓子 詰め合わせ 化粧箱 誕生日 ギフト 個包装',
  'クッキー 詰め合わせ ギフトボックス お礼 のし対応',
  'コーヒー ドリップ 詰め合わせ ギフト 化粧箱',
  'ソーシャルギフト スイーツ 焼き菓子 化粧箱 誕生日',
  '内祝い スイーツ ギフトボックス のし対応 詰め合わせ',
  '紅茶 ティーバッグ セット 化粧箱 母の日 ギフト',
  'eギフト バウムクーヘン セット ラッピング無料 個包装',
  'ゼリー 詰め合わせ ギフト 化粧箱 のし 夏ギフト',
  'ジュース 飲み比べ セット ギフト 化粧箱 内祝い',
  'ハンドクリーム セット 個包装 お礼 化粧箱',
  '入浴剤 アソート 退職 送別 メッセージカード'
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
  /* 2026-09-04、動画の指定に合わせてゴールデン価格帯を1,500〜2,980円へ変更した。
     コレクションは 1,500〜2,000 / 2,000〜2,500 / 2,500〜2,980 の3つ。 */
  const price = o.price !== undefined ? o.price : 1500 + ((i * 371) % 1480);
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

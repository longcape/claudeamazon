/* =========================================================
   RENDER — 人が読む投稿台本の生成
   投稿はここに出た本文をそのまま貼れば終わるようにする。
   ========================================================= */
'use strict';

const time = require('../util/time');

const ROLE_LABEL = { bait: '評価取り', cv: '売上', traffic: '送客' };
const ROLE_AIM = {
  bait: 'まず見てもらう。ROOM内の回遊を作る。売り込まない',
  cv: '購入まで運ぶ。直前の入口投稿で作った関心をそのまま流す',
  traffic: '楽天市場へ送って選んでもらう。送客の量を観測する'
};

function yen(n) { return Number(n).toLocaleString('ja-JP') + '円'; }

function renderPost(post) {
  const lines = [];
  lines.push('### ' + post.order + '. ' + post.timeJst + '　[' + ROLE_LABEL[post.role] + ']　' + yen(post.price));
  lines.push('');
  lines.push('> ' + ROLE_AIM[post.role]);
  lines.push('');
  lines.push('**商品**: ' + post.cleanName);
  lines.push('**ショップ**: ' + post.shopName + '　**評価**: ★' + post.reviewAverage.toFixed(2) + '（' + post.reviewCount + '件）');
  lines.push('**リンク**: ' + post.affiliateUrl);
  if (post.role === 'traffic' && (post.marketplaceClickReasons || []).length) {
    lines.push('**商品ページを開く理由**: ' +
      post.marketplaceClickReasons.map(function (r) { return r.label; }).join(' / '));
  }
  if (post.nextPostTeaser) {
    lines.push('**次の投稿の予告**: ' + post.nextPostTeaser +
      (post.nextRelatedProduct ? '（' + String(post.nextRelatedProduct.name).slice(0, 24) + '）' : ''));
  }
  if (post.images && post.images[0]) lines.push('**画像**: ' + post.images[0]);
  lines.push('');
  lines.push('**投稿文（このまま貼る）**');
  lines.push('```');
  lines.push(post.copy.text);
  lines.push('```');
  lines.push('');
  const s = post.scores || {};
  lines.push('選定根拠 — 総合 ' + post.total.toFixed(3) +
    '（広告加熱 ' + (s.adHeat || 0).toFixed(2) +
    ' / 信頼 ' + (s.trust || 0).toFixed(2) +
    ' / 売上速度 ' + (s.velocity || 0).toFixed(2) +
    ' / 価格帯 ' + (s.priceFit || 0).toFixed(2) +
    ' / AI適合 ' + (s.aiFit || 0).toFixed(2) +
    ' / 作り込み ' + (s.craft || 0).toFixed(2) + '）');
  (post.reasons || []).slice(0, 6).forEach(function (r) { lines.push('- ' + r); });
  if (post.linkPrev) lines.push('- 導線: 直前の「' + post.linkPrev + '」と同じ棚');
  lines.push('');
  return lines.join('\n');
}

/* ---------- 実験の実行キット ----------
   運用者はターミナルを使わない。貼り付けるものと、後で伝える数字だけが
   1ファイルで完結するようにする。ROOMへの自動投稿は実装しない。 */
const ROLE_STEP = { bait: '入口', cv: '本命', traffic: '送客' };

function reasonFor(post, cluster) {
  const f = post.facets || {};
  const bits = [];
  if (post.role === 'bait') bits.push('まず見てもらう入口。安い側から入って、次の本命へつなぐ');
  if (post.role === 'cv') bits.push('この束の本命。直前の入口で作った関心をそのまま購入へ運ぶ');
  if (post.role === 'traffic') bits.push('楽天市場のページで選んでもらう。ROOMだけでは分からないことがある');
  if (f.occasion && f.occasion.length) {
    const ja = { birthday: '誕生日', thanks: 'お礼', farewell: '送別', birth: '出産祝い', return_gift: '内祝い', casual: 'ちょっとした贈り物' };
    bits.push('想定する場面: ' + f.occasion.map(function (o) { return ja[o] || o; }).join('・'));
  }
  if (f.deliveryMode === 'address_free') bits.push('住所を知らない相手にも贈れる');
  if (cluster) bits.push('束 ' + cluster.id + '（' + (cluster.complementary ? '補完カテゴリあり' : '補完なし') + '）の' + ROLE_STEP[post.role]);
  return bits;
}

function renderExperimentKit(experiment, strategy) {
  const L = [];
  const cfg = strategy.experiment || {};
  const sch = strategy.schedule || {};

  L.push('# 12投稿実験 実行キット — ' + experiment.experimentId);
  L.push('');
  L.push('## これは初期実験です。通常運用ではありません');
  L.push('');
  L.push('| | この実験 | 実験のあとの通常運用 |');
  L.push('| --- | --- | --- |');
  L.push('| 1日の投稿数 | **' + (cfg.postsPerDay || 3) + '投稿** | **' + (sch.dailyPostsRange || [1, 2]).join('〜') + '投稿** |');
  L.push('| 期間 | 4日間で終わり | 継続 |');
  L.push('| 目的 | 21時台と0時台のどちらが良いかを比べる | 反応を見ながら次を選ぶ |');
  L.push('');
  L.push('**3投稿なのは、両方の時間帯へ同じ役割構成（入口・本命・送客）を置くために必要だからです。**');
  L.push('投稿数を競うものではありません。**この実験が終わったら3投稿を続けないでください。**');
  L.push('');
  L.push('100商品のポートフォリオは候補の一覧であって、投稿ノルマではありません。');
  L.push('');
  L.push('**時刻をずらさないでください。** 時間帯を比べる実験なので、時刻が動くと何が効いたのか分からなくなります。');
  L.push('');
  L.push('---');

  experiment.posts.forEach(function (p) {
    const cluster = (experiment.clusters || []).find(function (c) { return c.id === p.clusterId; });
    L.push('');
    L.push('## ' + p.order + '. ' + p.date + '（' + p.timeJst + '）　' + ROLE_STEP[p.role] + '　' + yen(p.price));
    L.push('');
    L.push('- 束: **' + p.clusterId + '** / 時間帯: **' + p.slotVariant + '**');
    L.push('- セッション（この投稿が属する晩）: **' + p.sessionDate + '**');
    L.push('- コレクション: ' + ((p.giftCollections || []).join(' / ') || '—'));
    L.push('');
    L.push('**商品**: ' + p.cleanName);
    L.push('');
    L.push('**リンク（これを貼る）**:');
    L.push('');
    L.push('```');
    L.push(p.affiliateUrl || p.url);
    L.push('```');
    L.push('');
    L.push('**紹介文（これをコピー）**:');
    L.push('');
    L.push('```');
    L.push(p.copy ? p.copy.text : '（未生成）');
    L.push('```');
    if (p.copy && p.copy.hashtags && p.copy.hashtags.length) {
      L.push('');
      L.push('**ハッシュタグ**: ' + p.copy.hashtags.join(' '));
    }
    L.push('');
    L.push('**この投稿を出す理由**:');
    reasonFor(p, cluster).forEach(function (r) { L.push('- ' + r); });
    if (p.role === 'traffic' && (p.marketplaceClickReasons || []).length) {
      L.push('');
      L.push('**楽天市場のページを開いてもらう理由**（すべて商品ページに載っています）:');
      p.marketplaceClickReasons.forEach(function (r) { L.push('- ' + r.label); });
    }
    if (p.nextPostTeaser) {
      L.push('');
      L.push('**次回予告**: ' + p.nextPostTeaser);
      if (p.nextRelatedProduct) L.push('（次に出すのは「' + String(p.nextRelatedProduct.name).slice(0, 30) + '」）');
    }
    L.push('');
    L.push('**24時間後に伝える数字**: `#' + p.order + '` いいね / 外部クリック / （分かれば）クリックした人数');
  });

  L.push('');
  L.push('---');
  L.push('');
  L.push('## 24時間後に伝えること');
  L.push('');
  L.push('投稿番号ごとに、この3つだけで足ります。**取れない数字は空欄で構いません。**');
  L.push('');
  L.push('```');
  experiment.posts.forEach(function (p) {
    L.push('#' + p.order + '  いいね=   外部クリック=   ユニーク=');
  });
  L.push('```');
  L.push('');
  L.push('**成約は発生したときだけ**伝えてください。0のままでも失敗ではありません。');
  L.push('楽天アフィリエイトの成果はクリックから最大89日後まで発生します。');
  L.push('');
  L.push('## 持っている商品があれば');
  L.push('');
  L.push('上の12件のうち**すでに買ったことがある物**があれば、番号を教えてください。');
  L.push('自分で撮った写真を付けられます（オリジナル写真はROOMランク上とくに重要とされています）。');
  return L.join('\n') + '\n';
}
function renderPlan(plan, report) {
  const lines = [];
  lines.push('# 楽天ROOM 投稿台本 — ' + (plan.kind === 'launch' ? '初動検証' : '通常運用') + '（' + plan.startDate + '〜）');
  lines.push('');
  lines.push('生成: ' + time.stamp(new Date()) + ' JST　/　投稿数: ' + plan.posts.length + '　/　日数: ' + plan.days);
  lines.push('');

  if (report) {
    lines.push('## 検査結果');
    lines.push('');
    lines.push('- 判定: ' + (report.ok ? '**合格**' : '**不合格**') + '（' + report.score + '点）');
    lines.push('- ゴールデン価格帯: ' + Math.round(report.sections.price.goldenRate * 100) + '%');
    lines.push('- ゴールデンタイム率: ' + Math.round(report.sections.schedule.hotTimeRate * 100) + '%');
    lines.push('- 売上投稿が評価取りの直後: ' + Math.round(report.sections.sequence.cvAfterBaitRate * 100) + '%');
    lines.push('- サブテーマ: ' + Object.keys(report.sections.genre.breakdown).join(' / '));
    report.blockers.forEach(function (b) { lines.push('- **停止** ' + b); });
    report.warnings.forEach(function (w) { lines.push('- 注意 ' + w); });
    lines.push('');
  }

  const byDay = {};
  plan.posts.forEach(function (p) { (byDay[p.date] = byDay[p.date] || []).push(p); });

  Object.keys(byDay).sort().forEach(function (date) {
    const posts = byDay[date];
    lines.push('---');
    lines.push('');
    lines.push('## ' + date + '（' + posts.length + '件）　' + posts[0].timeJst + '〜' + posts[posts.length - 1].timeJst);
    lines.push('');
    lines.push('| # | 時刻 | 役割 | 価格 | 商品 |');
    lines.push('| --- | --- | --- | --- | --- |');
    posts.forEach(function (p) {
      lines.push('| ' + p.order + ' | ' + p.timeJst + ' | ' + ROLE_LABEL[p.role] + ' | ' + yen(p.price) + ' | ' + p.core + ' |');
    });
    lines.push('');
    posts.forEach(function (p) { lines.push(renderPost(p)); });
  });

  return lines.join('\n');
}

/* 通知1件ぶんの短いテキスト */
function renderNotification(post) {
  return [
    '⏰ ' + post.timeJst + ' [' + ROLE_LABEL[post.role] + '] ' + yen(post.price),
    post.cleanName,
    '',
    post.copy.text,
    '',
    post.affiliateUrl
  ].join('\n');
}

module.exports = { renderPlan, renderPost, renderNotification, renderExperimentKit, reasonFor, ROLE_LABEL, ROLE_AIM, ROLE_STEP };

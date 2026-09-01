/* =========================================================
   RENDER — 人が読む投稿台本の生成
   投稿はここに出た本文をそのまま貼れば終わるようにする。
   ========================================================= */
'use strict';

const time = require('../util/time');

const ROLE_LABEL = { bait: '評価取り', cv: '売上', traffic: '送客' };
const ROLE_AIM = {
  bait: 'クリックと回遊を取る。売り込まない',
  cv: '成約を取る。直前の評価取りの熱をそのまま流す',
  traffic: '楽天市場へ送る。外部送客スコアを取る'
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

module.exports = { renderPlan, renderPost, renderNotification, ROLE_LABEL, ROLE_AIM };

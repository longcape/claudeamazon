/* =========================================================
   NG CHECK — 出す前の最終検査
   ---------------------------------------------------------
   ユーザー指定のNG行動6項目を、計画に対してそのまま当てる。
   blocker が1つでも出たら、その計画は出さない。
     1 ジャンルがバラバラの無差別投稿
     2 買い理由0の自己満日記投稿
     3 売れない価格帯ばかりの利益破壊サイクル
     4 投稿順によるルーム全体のブランド破壊
     5 売れる時間外の投稿
     6 楽天のAI検索最適化に非対応
   ========================================================= */
'use strict';

const shelf = require('../plan/shelf');
const sequence = require('../plan/sequence');
const schedule = require('../plan/schedule');

function pct(n) { return Math.round(n * 100) + '%'; }

function check(posts, strategy, opts) {
  const options = opts || {};
  const blockers = [];
  const warnings = [];
  const sections = {};

  /* --- 1 ジャンルの散らかり --- */
  const subs = {};
  posts.forEach(function (p) { subs[p.primarySubTheme || '_none'] = (subs[p.primarySubTheme || '_none'] || 0) + 1; });
  const distinct = Object.keys(subs).length;
  const rootId = strategy.genre.rootGenreId;
  const related = strategy.genre.relatedGenreIds || [];
  const offGenre = posts.filter(function (p) {
    return p.genreId && p.genreId !== rootId && related.indexOf(p.genreId) < 0 && !(options.genreDescendants && options.genreDescendants.has(p.genreId));
  });
  sections.genre = { distinctSubThemes: distinct, breakdown: subs, offGenreCount: offGenre.length };
  if (distinct > (strategy.launch.subThemeSpread.maxSubThemes + 1)) {
    blockers.push('NG1 ジャンル散乱: サブテーマが ' + distinct + ' 種類（上限 ' + strategy.launch.subThemeSpread.maxSubThemes + '）');
  }
  if (offGenre.length > posts.length * 0.25) {
    warnings.push('NG1 設定ジャンルの外の商品が ' + offGenre.length + ' 件（' + pct(offGenre.length / posts.length) + '）');
  }

  /* --- 2 買い理由0の投稿 --- */
  const badCopy = posts.filter(function (p) { return p.copyCheck && !p.copyCheck.ok; });
  sections.copy = { total: posts.length, invalid: badCopy.length, samples: badCopy.slice(0, 5).map(function (p) { return { order: p.order, issues: p.copyCheck.issues }; }) };
  if (badCopy.length > 0) {
    blockers.push('NG2 買い理由の無い投稿が ' + badCopy.length + ' 件（' + badCopy.slice(0, 3).map(function (p) { return '#' + p.order; }).join(',') + ' ほか）');
  }

  /* --- 3 価格帯 --- */
  const shelfReport = shelf.auditShelf(posts, strategy);
  sections.price = { goldenRate: shelfReport.goldenRate, range: shelfReport.priceRange };
  if (shelfReport.goldenRate < 0.55) {
    blockers.push('NG3 ゴールデン価格帯(' + strategy.goldenPrice.min + '-' + strategy.goldenPrice.max + '円)が ' + pct(shelfReport.goldenRate) + ' しかない');
  } else if (shelfReport.goldenRate < 0.7) {
    warnings.push('NG3 ゴールデン価格帯が ' + pct(shelfReport.goldenRate) + '（7割以上が望ましい）');
  }

  /* --- 4 棚の並び --- */
  sections.shelf = shelfReport;
  if (shelfReport.violations.length > Math.max(2, posts.length * 0.15)) {
    blockers.push('NG4 価格段差が ' + shelfReport.violations.length + ' 箇所（棚として破綻）');
  } else if (shelfReport.violations.length) {
    warnings.push('NG4 価格段差が ' + shelfReport.violations.length + ' 箇所');
  }

  /* --- 5 投稿時間 --- */
  const scheduleReport = schedule.auditSchedule(posts, strategy);
  sections.schedule = scheduleReport;
  scheduleReport.issues.forEach(function (i) {
    (i.level === 'error' ? blockers : warnings).push('NG5/リズム ' + i.message);
  });
  if (scheduleReport.hotTimeRate < 0.5) {
    warnings.push('NG5 ゴールデンタイム(20-23時)の投稿が ' + pct(scheduleReport.hotTimeRate) + ' しかない');
  }

  /* --- 6 AI最適化 --- */
  const aiScores = posts.map(function (p) { return (p.scores && p.scores.aiFit) || 0; });
  const aiAvg = aiScores.length ? aiScores.reduce(function (a, b) { return a + b; }, 0) / aiScores.length : 0;
  const noVerb = posts.filter(function (p) { return p.aiBreakdown && p.aiBreakdown['動詞'] === 0; });
  sections.ai = { average: aiAvg, noVerbCount: noVerb.length };
  if (aiAvg < 0.42) {
    warnings.push('NG6 AI適合の平均が ' + aiAvg.toFixed(2) + '（0.5以上が目標）');
  }
  if (noVerb.length > posts.length * 0.5) {
    warnings.push('NG6 商品名に動詞が無い投稿が ' + noVerb.length + ' 件');
  }

  /* --- 役割リズム --- */
  const seqReport = sequence.auditSequence(posts, strategy);
  sections.sequence = seqReport;
  seqReport.issues.forEach(function (i) {
    (i.level === 'error' ? blockers : warnings).push('リズム ' + i.message);
  });
  if (seqReport.cvAfterBaitRate < 1) {
    blockers.push('リズム 売上投稿の ' + pct(1 - seqReport.cvAfterBaitRate) + ' が評価取りの直後にない');
  }

  /* --- 総合点 --- */
  const score = Math.max(0, Math.round(100
    - blockers.length * 18
    - warnings.length * 4
    + (shelfReport.goldenRate - 0.7) * 20
    + (scheduleReport.hotTimeRate - 0.7) * 15));

  return {
    ok: blockers.length === 0,
    score: Math.min(100, score),
    blockers: blockers,
    warnings: warnings,
    sections: sections
  };
}

function format(report) {
  const lines = [];
  lines.push(report.ok ? '検査: 合格（' + report.score + '点）' : '検査: 不合格（' + report.score + '点）');
  report.blockers.forEach(function (b) { lines.push('  [停止] ' + b); });
  report.warnings.forEach(function (w) { lines.push('  [注意] ' + w); });
  if (!report.blockers.length && !report.warnings.length) lines.push('  指摘なし');
  return lines.join('\n');
}

module.exports = { check, format };

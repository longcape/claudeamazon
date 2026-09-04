/* =========================================================
   PIPELINE — 全体の組み立て
   ---------------------------------------------------------
   楽天市場で拾う → スコアを付ける → 再検索で裏を取る →
   実績で補正する → 枠に選ぶ → 導線順に並べる → 棚を均す →
   紹介文を作る → 時間割に落とす → NG検査 → 台本を出す
   ========================================================= */
'use strict';

const ichiba = require('./rakuten/ichiba');
const collectLib = require('./pipeline/collect');
const velocityLib = require('./pipeline/velocity');
const scoreLib = require('./pipeline/score');
const crosscheckLib = require('./pipeline/crosscheck');
const portfolioLib = require('./pipeline/portfolio');
const trendLib = require('./pipeline/trend');
const selectLib = require('./pipeline/select');
const sequenceLib = require('./plan/sequence');
const shelfLib = require('./plan/shelf');
const scheduleLib = require('./plan/schedule');
const copyLib = require('./copy/generate');
const llmLib = require('./copy/llm');
const ngcheck = require('./guard/ngcheck');
const feedback = require('./feedback/record');
const queue = require('./post/queue');
const render = require('./post/render');
const store = require('./util/store');
const time = require('./util/time');
const log = require('./util/log');

/* ジャンル木は滅多に変わらないのでキャッシュする。
   商品に付くジャンルIDは3〜4階層目（100804 > 200166:収納家具 > 215685:キッチン収納 > 406384:キッチン隙間収納）で、
   直下の子だけを見ると自ジャンルの商品がまるごと「圏外」になり、
   カテゴリ相関(aiFit)とNG1の判定が同時に壊れる。
   候補に実際に出てきたジャンルIDを祖先まで辿って所属を判定し、結果をキャッシュする */
async function genreDescendants(strategy, candidateGenreIds) {
  const cacheKey = 'genre-tree.json';
  const rootId = String(strategy.genre.rootGenreId);
  const cache = store.readJson(cacheKey, null);
  const valid = cache && cache.rootId === rootId;
  const members = valid && cache.members ? cache.members : {};
  const tree = (valid && cache.tree) || { id: rootId, children: [] };

  if (!valid || !tree.children.length) {
    try {
      const root = await ichiba.genre(rootId);
      tree.id = rootId;
      tree.name = root.name;
      tree.children = root.children.map(function (c) { return { id: c.id, name: c.name }; });
      root.children.forEach(function (c) { members[c.id] = true; });
    } catch (e) {
      log.warn('ジャンル情報の取得に失敗しました（カテゴリ相関の精度が落ちます）: ' + e.message);
      return { set: new Set(), tree: tree };
    }
  }

  members[rootId] = true;

  /* rootGenreId が 0 のときは全ジャンル横断。棚の同一性はジャンルではなく
     ギフト適性で担保するため、候補は全てカテゴリ圏内として扱う */
  if (rootId === '0') {
    (candidateGenreIds || []).forEach(function (id) { if (id) members[String(id)] = true; });
    store.writeJson(cacheKey, { rootId: rootId, members: members, tree: tree, cachedAt: new Date().toISOString() });
    return { set: new Set(Object.keys(members)), tree: tree };
  }
  (strategy.genre.relatedGenreIds || []).forEach(function (id) { members[String(id)] = true; });

  const unknown = [...new Set((candidateGenreIds || []).map(String))]
    .filter(function (id) { return id && members[id] === undefined; });

  if (unknown.length) {
    log.detail('ジャンル所属を照会: ' + unknown.length + ' 種類（結果はキャッシュされ、次回以降は不要です）');
    for (const id of unknown) {
      try {
        const g = await ichiba.genre(id);
        members[id] = g.parents.some(function (p) { return p.id === rootId; }) || id === rootId;
      } catch (e) { /* 失敗は記録しない。次回もう一度引く */ }
    }
  }

  store.writeJson(cacheKey, { rootId: rootId, members: members, tree: tree, cachedAt: new Date().toISOString() });
  return { set: new Set(Object.keys(members).filter(function (id) { return members[id]; })), tree: tree };
}

function loadLatestCandidates() {
  const files = store.listData('candidates-');
  if (!files.length) return null;
  return store.readJson(files[files.length - 1], null);
}

/* 収集済みの候補にスコアを付けるところまで */
async function analyze(strategy, opts) {
  const options = opts || {};
  let bundle = options.freshCollect ? null : loadLatestCandidates();

  if (!bundle || options.freshCollect) {
    const result = await collectLib.collect(strategy, options);
    bundle = { date: result.date, items: result.candidates };
  } else {
    log.step('既存の候補を使用: ' + bundle.items.length + ' 商品（' + bundle.date + ' 収集）');
    log.detail('取り直す場合は --fresh を付けてください');
  }

  const lexicon = store.readJson(store.configPath('copy-lexicon.json'), null);
  const trend = store.loadTrendWords();
  const genre = await genreDescendants(strategy, bundle.items.map(function (i) { return i.genreId; }));
  const vel = velocityLib.buildVelocityIndex(strategy);

  log.step('スコアリング');
  if (vel.snapshotCount < 2) {
    log.detail('スナップショットが ' + vel.snapshotCount + ' 日分しかないため、売上速度は未計測扱いです（明日以降 collect すると効き始めます）');
  } else {
    log.detail('売上速度: ' + vel.from + ' → ' + vel.to + ' の ' + vel.index.size + ' 商品で計測');
  }

  let scored = scoreLib.scoreAll(bundle.items, strategy, {
    lexicon: lexicon,
    trend: trend,
    velocityIndex: vel.index,
    genreDescendants: genre.set
  });

  if (options.crosscheck !== false) {
    scored = await crosscheckLib.crosscheck(scored, strategy, { limit: options.crosscheckLimit || 60 });
  }

  const fb = feedback.applyFeedback(scored, strategy);
  log.detail(fb.applied ? '実績学習を適用（' + fb.entries + '件の実績）' : fb.reason);

  /* 上昇ワードの観測をここで進めておく */
  try {
    const rows = trendLib.observe(scored, strategy);
    trendLib.save(rows, 40);
  } catch (e) {
    log.warn('上昇ワードの記録に失敗: ' + e.message);
  }

  return { scored: scored, lexicon: lexicon, trend: trend, genre: genre, velocity: vel, collectedAt: bundle.date };
}

/* ---------- 100商品ポートフォリオ ----------
   投稿計画（launch/plan）とは別の成果物。
   計画が「今日この順で何を出すか」なのに対し、こちらは
   「この棚を支える商品群と、それぞれをどう売るか」を決める台帳で、
   短尺動画の制作など後工程へ渡すことを想定している。 */
async function buildPortfolio(strategy, opts) {
  const analysis = await analyze(strategy, opts || {});
  const result = portfolioLib.build(analysis.scored, strategy);
  return Object.assign({}, result, { collectedAt: analysis.collectedAt });
}

function savePortfolio(portfolio, dateKey) {
  const date = dateKey || time.dateKey();
  const rows = portfolioLib.toRows(portfolio);
  const jsonFile = store.writeJson('portfolio-' + date + '.json', {
    date: date,
    summary: portfolio.summary,
    items: rows
  });
  const mdFile = store.writeText('portfolio-' + date + '.md', renderPortfolio(portfolio, date));
  return { jsonFile: jsonFile, mdFile: mdFile };
}

function renderPortfolio(portfolio, date) {
  const s = portfolio.summary;
  const lines = [];
  lines.push('# 商品ポートフォリオ ' + date);
  lines.push('');
  const brand = ((require('../config/strategy.json').room) || {}).brand || '贈りもの迷子';
  lines.push('棚: ' + brand);
  lines.push('');
  lines.push('| 層 | 目標 | 確定 | 役割 |');
  lines.push('| --- | --- | --- | --- |');
  lines.push('| 主力 | ' + s.target.flagship + ' | ' + s.filled.flagship + ' | SNSで繰り返し訴求する中心商品 |');
  lines.push('| 準主力 | ' + s.target.secondary + ' | ' + s.filled.secondary + ' | ROOM内の主要な選択肢 |');
  lines.push('| ロングテール | ' + s.target.longtail + ' | ' + s.filled.longtail + ' | 用途・相手・予算の幅を埋める |');
  lines.push('');
  lines.push('候補 ' + s.candidatePool + ' 件中、ギフト適性を満たしたもの ' + s.eligible + ' 件');
  lines.push('（適性不足で除外 ' + s.rejectedByGiftReady + ' 件 / 採用ショップ ' + s.shops + ' 社）');
  lines.push('');

  [['主力', portfolio.flagship], ['準主力', portfolio.secondary], ['ロングテール', portfolio.longtail]]
    .forEach(function (pair) {
      lines.push('## ' + pair[0] + '（' + pair[1].length + '件）');
      lines.push('');
      lines.push('| 商品 | 価格 | 総合 | 動画 | コレクション | 訴求角度 |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      pair[1].forEach(function (i) {
        lines.push('| ' + i.cleanName.slice(0, 34) + ' | ' + i.price.toLocaleString('ja-JP') + '円 | ' +
          i.total.toFixed(2) + ' | ' + i.videoPriority.rank + ' | ' +
          (i.giftCollections || []).join(' / ') + ' | ' + (i.giftAngle ? i.giftAngle.hook : '') + ' |');
      });
      lines.push('');
    });

  return lines.join('\n') + '\n';
}

/* 分析結果から投稿計画を組む */
async function buildPlan(strategy, opts) {
  const options = opts || {};
  const kind = options.kind || 'daily';
  const analysis = options.analysis || await analyze(strategy, options);

  const isLaunch = kind === 'launch';
  const size = options.size || (isLaunch ? strategy.launch.size : strategy.schedule.dailyPosts * (options.days || 1));
  const mixSource = isLaunch ? strategy.launch.mix : null;
  const mix = options.mix || mixSource || scaleMix(strategy.launch.mix, size);

  log.step((isLaunch ? '初動検証' : '通常運用') + 'の選定: ' + size + ' 件');
  const selection = selectLib.selectSet(analysis.scored, strategy, {
    size: size,
    mix: mix,
    minScore: options.minScore !== undefined ? options.minScore
      : (isLaunch ? strategy.launch.minSelectionScore : strategy.launch.minSelectionScore - 0.08),
    spread: isLaunch ? strategy.launch.subThemeSpread : { minSubThemes: 2, maxSubThemes: 4 },
    ignoreHistory: options.ignoreHistory
  });
  log.detail('候補プール ' + selection.poolSize + ' → 選定 ' + selection.picked.length + ' 件');
  log.detail('サブテーマ: ' + selection.subThemes.join(' / '));

  log.step('並び替え（導線と棚）');
  let seq = sequenceLib.arrange(selection.picked, strategy);
  seq = shelfLib.smooth(seq, strategy);

  log.step('紹介文の生成');
  let withCopy = copyLib.generateAll(seq, strategy, analysis.lexicon, analysis.trend);
  const useLlm = options.llm !== undefined ? options.llm : (strategy.copy.useLlm !== 'off' && llmLib.available());
  if (useLlm) {
    log.detail('LLMで自然化しています…');
    withCopy = await llmLib.refine(withCopy, strategy);
    withCopy = withCopy.map(function (p) {
      return Object.assign({}, p, { copyCheck: copyLib.validateCopy(p.copy, strategy) });
    });
  } else {
    log.detail('ルールベースのみ（ANTHROPIC_API_KEY を入れると自然化されます）');
  }

  log.step('時間割');
  const posts = scheduleLib.assignTimes(withCopy, strategy, {
    startDate: options.startDate || time.dateKey(),
    postsPerDay: options.postsPerDay || (isLaunch ? strategy.launch.postsPerDay : strategy.schedule.dailyPosts),
    hotTimeOnly: options.hotTimeOnly !== undefined ? options.hotTimeOnly : (isLaunch && strategy.launch.hotTimeOnly)
  });

  log.step('NG検査');
  const report = ngcheck.check(posts, strategy, { genreDescendants: analysis.genre.set });
  log.info(ngcheck.format(report));

  const plan = {
    kind: kind,
    startDate: options.startDate || time.dateKey(),
    createdAt: new Date().toISOString(),
    collectedAt: analysis.collectedAt,
    days: Object.keys(posts.reduce(function (a, p) { a[p.date] = 1; return a; }, {})).length,
    subThemes: selection.subThemes,
    posts: posts,
    report: report
  };

  return plan;
}

function scaleMix(baseMix, size) {
  const total = Object.values(baseMix).reduce(function (a, b) { return a + b; }, 0);
  const out = {};
  let assigned = 0;
  Object.keys(baseMix).forEach(function (k, i, keys) {
    if (i === keys.length - 1) { out[k] = Math.max(0, size - assigned); return; }
    out[k] = Math.round(size * baseMix[k] / total);
    assigned += out[k];
  });
  return out;
}

function savePlanWithScript(plan) {
  const file = queue.savePlan(plan);
  const md = render.renderPlan(plan, plan.report);
  const mdFile = store.writeText('plan-' + plan.kind + '-' + plan.startDate + '.md', md);
  return { planFile: file, scriptFile: mdFile };
}

module.exports = { analyze, buildPlan, savePlanWithScript, buildPortfolio, savePortfolio, renderPortfolio, genreDescendants, loadLatestCandidates, scaleMix };

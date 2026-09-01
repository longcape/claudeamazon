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

/* ジャンル木は滅多に変わらないのでキャッシュする */
async function genreDescendants(strategy) {
  const cacheKey = 'genre-tree.json';
  const cache = store.readJson(cacheKey, null);
  const rootId = strategy.genre.rootGenreId;
  if (cache && cache.rootId === rootId && cache.ids) return { set: new Set(cache.ids), tree: cache.tree };

  const ids = [];
  const tree = { id: rootId, children: [] };
  try {
    const root = await ichiba.genre(rootId);
    tree.name = root.name;
    for (const child of root.children) {
      ids.push(child.id);
      tree.children.push({ id: child.id, name: child.name });
    }
  } catch (e) {
    log.warn('ジャンル情報の取得に失敗しました（カテゴリ相関の精度が落ちます）: ' + e.message);
    return { set: new Set(), tree: tree };
  }
  store.writeJson(cacheKey, { rootId: rootId, ids: ids, tree: tree, cachedAt: new Date().toISOString() });
  return { set: new Set(ids), tree: tree };
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
  const genre = await genreDescendants(strategy);
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

/* 分析結果から投稿計画を組む */
async function buildPlan(strategy, opts) {
  const options = opts || {};
  const kind = options.kind || 'daily';
  const analysis = options.analysis || await analyze(strategy, options);

  const isLaunch = kind === 'launch';
  const size = options.size || (isLaunch ? strategy.launch.size : strategy.schedule.dailyPosts * (options.days || 1));
  const mixSource = isLaunch ? strategy.launch.mix : null;
  const mix = options.mix || mixSource || scaleMix(strategy.launch.mix, size);

  log.step((isLaunch ? '初動30件' : '通常運用') + 'の選定: ' + size + ' 件');
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

module.exports = { analyze, buildPlan, savePlanWithScript, genreDescendants, loadLatestCandidates, scaleMix };

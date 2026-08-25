#!/usr/bin/env node
/* =========================================================
   楽天ROOM 運用エンジン — CLI
     collect  楽天市場から候補を収集し、定点観測を1日分残す
     launch   初動30件の計画を作る（最重要）
     plan     通常運用の計画を作る
     next     これから出す投稿を確認する
     now      投稿時刻が来たものを出す（アダプタ経由）
     done     投稿済みにする
     record   実績（いいね/クリック/成約）を記録する
     report   隠しスコアの代理指標と学習状況を見る
     trend    上昇ワードの候補を見る
     genre    ジャンルIDを調べる
     doctor   設定と接続を確認する
   ========================================================= */
'use strict';

const path = require('path');
const fs = require('fs');

/* .env を読む（依存パッケージを増やさないための最小実装） */
(function loadDotenv() {
  const file = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split('\n').forEach(function (line) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) return;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined && value !== '') process.env[m[1]] = value;
  });
})();

const pipeline = require('../src/index');
const collectLib = require('../src/pipeline/collect');
const velocityLib = require('../src/pipeline/velocity');
const trendLib = require('../src/pipeline/trend');
const selectLib = require('../src/pipeline/select');
const feedback = require('../src/feedback/record');
const queue = require('../src/post/queue');
const render = require('../src/post/render');
const adapters = require('../src/post/adapters');
const ichiba = require('../src/rakuten/ichiba');
const store = require('../src/util/store');
const time = require('../src/util/time');
const log = require('../src/util/log');

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  argv.forEach(function (a) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out.flags[k] = v === undefined ? true : v;
    } else {
      out._.push(a);
    }
  });
  return out;
}

function strategy() { return store.loadStrategy(); }

/* ---------- コマンド ---------- */

async function cmdCollect(args) {
  const s = strategy();
  const result = await collectLib.collect(s, { subTheme: args.flags.sub });
  const removed = velocityLib.pruneSnapshots(s);
  if (removed.length) log.detail('古いスナップショットを ' + removed.length + ' 件削除');
  log.step('完了');
  log.detail('候補 ' + result.candidates.length + ' 件を data/candidates-' + result.date + '.json に保存しました');
  log.detail('毎日これを回すほど売上速度の精度が上がります');
}

async function cmdPlan(args, kind) {
  const s = strategy();
  const plan = await pipeline.buildPlan(s, {
    kind: kind,
    freshCollect: !!args.flags.fresh,
    crosscheck: args.flags.nocheck ? false : true,
    days: args.flags.days ? Number(args.flags.days) : 1,
    startDate: args.flags.date || time.dateKey(),
    size: args.flags.size ? Number(args.flags.size) : undefined,
    llm: args.flags.nollm ? false : undefined,
    ignoreHistory: !!args.flags.again
  });

  const files = pipeline.savePlanWithScript(plan);
  log.step('保存');
  log.detail('計画: data/' + path.basename(files.planFile));
  log.detail('台本: out/' + path.basename(files.scriptFile));

  if (!plan.report.ok) {
    log.warn('検査に不合格です。上の [停止] を解消してから使ってください');
    log.detail('候補を増やす: node bin/room.js collect  /  基準を下げる: config/strategy.json');
  }

  const first = plan.posts.slice(0, 3);
  log.step('最初の3件');
  first.forEach(function (p) {
    log.info('');
    log.info('  ' + p.date + ' ' + p.timeJst + ' [' + render.ROLE_LABEL[p.role] + '] ' + p.price.toLocaleString('ja-JP') + '円');
    log.info('  ' + p.cleanName);
    p.copy.text.split('\n').forEach(function (l) { log.info('    ' + l); });
  });
}

function cmdNext(args) {
  const plan = queue.loadCurrentPlan();
  if (!plan) return log.fail('計画がありません。先に launch か plan を実行してください');
  const count = args.flags.count ? Number(args.flags.count) : 5;
  const upcoming = queue.upcomingPosts(plan, new Date(), count);
  const p = queue.progress(plan);

  log.step('進捗: ' + p.posted + '/' + p.total + ' 投稿済み');
  if (!upcoming.length) return log.detail('予定はすべて消化済みです。次の計画を作ってください');

  upcoming.forEach(function (post) {
    log.info('');
    log.info('  ' + time.stamp(new Date(post.scheduledAt)) + '  [' + render.ROLE_LABEL[post.role] + ']  #' + post.order);
    log.info('  ' + post.cleanName + '　' + post.price.toLocaleString('ja-JP') + '円');
    post.copy.text.split('\n').forEach(function (l) { log.info('    ' + l); });
    log.info('    ' + post.affiliateUrl);
  });
}

async function cmdNow(args) {
  const plan = queue.loadCurrentPlan();
  if (!plan) return log.fail('計画がありません。先に launch か plan を実行してください');
  const grace = args.flags.grace ? Number(args.flags.grace) : 90;
  const due = queue.duePosts(plan, new Date(), grace, { includeNotified: !!args.flags.again });
  const adapter = adapters.resolve(args.flags.adapter);
  const result = await adapter.post(due);

  if (result.presented && result.presented.length) {
    queue.markPresented(plan, result.presented);
  }
  if (result.posted && result.posted.length) {
    queue.markPosted(plan, result.posted, adapter.name);
    log.detail('投稿済みとして記録: ' + result.posted.join(','));
  }
}

/* cron 用: 収集して計画まで作る */
async function cmdDaily(args) {
  const s = strategy();
  await collectLib.collect(s, {});
  velocityLib.pruneSnapshots(s);
  await cmdPlan(args, args.flags.launch ? 'launch' : 'daily');
}

function cmdDone(args) {
  const plan = queue.loadCurrentPlan();
  if (!plan) return log.fail('計画がありません');
  const orders = String(args._[1] || '').split(/[,\s]+/).map(Number).filter(Boolean);
  if (!orders.length) return log.fail('使い方: node bin/room.js done 1,2,3');
  const n = queue.markPosted(plan, orders, 'manual');
  const posted = plan.posts.filter(function (p) { return orders.indexOf(p.order) >= 0; });
  selectLib.recordPosted(posted, time.dateKey());
  log.step(n + ' 件を投稿済みにしました');
  const p = queue.progress(plan);
  log.detail('進捗 ' + p.posted + '/' + p.total + (p.nextAt ? ' / 次は ' + time.stamp(new Date(p.nextAt)) : ''));
}

function cmdRecord(args) {
  const s = strategy();
  const plan = queue.loadCurrentPlan();
  if (!plan) return log.fail('計画がありません');
  const orders = String(args._[1] || '').split(/[,\s]+/).map(Number).filter(Boolean);
  if (!orders.length) {
    return log.fail('使い方: node bin/room.js record 1,2 --likes=12 --clicks=30 --cv=1 --revenue=2480');
  }
  const metrics = {
    likes: Number(args.flags.likes) || 0,
    clicks: Number(args.flags.clicks) || 0,
    conversions: Number(args.flags.cv) || 0,
    revenue: Number(args.flags.revenue) || 0
  };
  const added = feedback.record(plan, orders, metrics, s);
  log.step(added.length + ' 件の実績を記録しました');
  added.forEach(function (e) {
    log.detail('#' + e.date + ' ' + e.timeJst + ' [' + e.role + '] ' + e.name + ' → クリック' + e.clicks + ' 成約' + e.conversions);
  });
}

function cmdReport() {
  const s = strategy();
  const sum = feedback.summarize(s);
  if (!sum.entries) return log.info('実績がまだありません。record コマンドで入れてください');

  log.step('隠しスコアの代理指標（' + sum.entries + ' 件の実績から）');
  Object.keys(sum.hidden).forEach(function (k) {
    const v = sum.hidden[k];
    if (typeof v === 'number') { log.detail(k + ': ' + v.toLocaleString('ja-JP')); return; }
    log.detail(k + ': ' + (v.value * 100).toFixed(1) + '%　（' + v.label + '）');
  });

  const table = function (title, stats) {
    log.step(title);
    Object.keys(stats).sort(function (a, b) { return stats[b].cvIndex - stats[a].cvIndex; }).forEach(function (k) {
      const v = stats[k];
      log.detail(String(k).padEnd(18) + ' n=' + String(v.n).padStart(3) +
        '  クリック/件 ' + String(v.clicksPerPost).padStart(6) +
        '  成約/件 ' + String(v.cvPerPost).padStart(6) +
        '  指数 ' + v.clickIndex + '/' + v.cvIndex);
    });
  };
  table('サブテーマ別', sum.bySubTheme);
  table('役割別', sum.byRole);
  table('価格帯別', sum.byPriceBand);
  table('時間帯別', sum.byHour);
}

function cmdTrend() {
  const rows = trendLib.risingCandidates(15);
  if (!rows.length) {
    return log.info('観測データが足りません。collect を数日ぶん回してから見てください');
  }
  log.step('上昇ワードの昇格候補');
  log.detail('良さそうなものを config/trend-words.json の rising に手で移してください');
  rows.forEach(function (r) {
    log.detail(r.word.padEnd(14) + ' 出現増 ' + String(r.growth).padStart(3) + '　レビュー速度 ' + (r.speed || 0).toFixed(2) + '/日');
  });
}

async function cmdGenre(args) {
  const id = args._[1] || strategy().genre.rootGenreId;
  const g = await ichiba.genre(id);
  log.step('ジャンル ' + g.id + ' : ' + g.name + '（階層 ' + g.level + '）');
  if (g.parents.length) log.detail('親: ' + g.parents.map(function (p) { return p.name + '(' + p.id + ')'; }).join(' > '));
  log.step('子ジャンル');
  g.children.forEach(function (c) { log.detail(c.id.padEnd(10) + c.name); });
  log.info('');
  log.detail('使いたいIDを config/strategy.json の genre.rootGenreId に入れてください');
}

async function cmdDoctor() {
  const s = strategy();
  log.step('設定');
  log.detail('ジャンル: ' + s.genre.rootGenreId + '（' + s.genre.rootGenreLabel + '）');
  log.detail('サブテーマ: ' + s.genre.subThemes.map(function (x) { return x.id; }).join(', '));
  log.detail('ゴールデン価格帯: ' + s.goldenPrice.min + '-' + s.goldenPrice.max + '円');
  log.detail('ゴールデンタイム: ' + s.schedule.hotTime.start + '-' + s.schedule.hotTime.end + ' JST');
  log.detail('いまのJST: ' + time.stamp(new Date()));

  log.step('認証');
  log.detail('RAKUTEN_APP_ID: ' + (process.env.RAKUTEN_APP_ID ? '設定済み' : '未設定 ← 必須'));
  log.detail('RAKUTEN_AFFILIATE_ID: ' + (process.env.RAKUTEN_AFFILIATE_ID ? '設定済み' : '未設定（リンクが非アフィリになります）'));
  log.detail('ANTHROPIC_API_KEY: ' + (process.env.ANTHROPIC_API_KEY ? '設定済み（紹介文を自然化します）' : '未設定（ルールベースのみ）'));
  log.detail('投稿アダプタ: ' + (process.env.ROOM_POST_ADAPTER || 'manual'));

  log.step('データ');
  const snaps = store.listData('snapshot-');
  const cands = store.listData('candidates-');
  log.detail('スナップショット: ' + snaps.length + ' 日分' + (snaps.length < 2 ? '（2日分たまると売上速度が効きます）' : ''));
  log.detail('候補データ: ' + cands.length + ' 件');
  const history = selectLib.loadHistory();
  log.detail('投稿済み商品: ' + Object.keys(history.posted).length + ' 件');

  if (process.env.RAKUTEN_APP_ID) {
    log.step('接続テスト');
    try {
      const g = await ichiba.genre(s.genre.rootGenreId);
      log.detail('楽天API 応答あり: ' + g.name + ' / 子ジャンル ' + g.children.length + ' 件');
      if (!g.name) log.warn('ジャンルIDが正しくない可能性があります。room genre 0 で探してください');
    } catch (e) {
      log.warn('楽天APIに繋がりません: ' + e.message);
    }
  }
}

function usage() {
  log.info([
    '楽天ROOM 運用エンジン',
    '',
    '  node bin/room.js doctor              設定と接続を確認する（最初にこれ）',
    '  node bin/room.js genre [id]          ジャンルIDを調べる',
    '  node bin/room.js collect             楽天市場から候補を収集（毎日回す）',
    '  node bin/room.js daily               収集から計画作成までを一気に（cron向け）',
    '  node bin/room.js launch              初動30件の計画を作る',
    '  node bin/room.js plan [--days=3]     通常運用の計画を作る',
    '  node bin/room.js next [--count=5]    これから出す投稿を見る',
    '  node bin/room.js now [--adapter=..]  投稿時刻が来たものを出す',
    '  node bin/room.js done 1,2,3          投稿済みにする',
    '  node bin/room.js record 1 --clicks=30 --cv=1 --likes=12 --revenue=2480',
    '  node bin/room.js report              隠しスコアの代理指標を見る',
    '  node bin/room.js trend               上昇ワードの候補を見る',
    '',
    '共通フラグ: --fresh（収集し直す） --nocheck（再検索を省く） --nollm（LLM整形を切る） --again（投稿済み商品も許す）'
  ].join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  try {
    switch (cmd) {
      case 'collect': return await cmdCollect(args);
      case 'launch': return await cmdPlan(args, 'launch');
      case 'plan': return await cmdPlan(args, 'daily');
      case 'next': return cmdNext(args);
      case 'now': return await cmdNow(args);
      case 'daily': return await cmdDaily(args);
      case 'done': return cmdDone(args);
      case 'record': return cmdRecord(args);
      case 'report': return cmdReport();
      case 'trend': return cmdTrend();
      case 'genre': return await cmdGenre(args);
      case 'doctor': return await cmdDoctor();
      default: return usage();
    }
  } catch (e) {
    log.fail(e.message);
    if (process.env.ROOM_DEBUG) console.error(e);
    process.exitCode = 1;
  }
}

main();

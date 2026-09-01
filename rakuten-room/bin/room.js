#!/usr/bin/env node
/* =========================================================
   楽天ROOM 運用エンジン — CLI
     collect  楽天市場から候補を収集し、定点観測を1日分残す
     launch   初動6件の検証計画を作る
     plan     通常運用の計画を作る
     next     これから出す投稿を確認する
     now      投稿時刻が来たものを出す（アダプタ経由）
     done     投稿済みにする
     record   実績（いいね/クリック/成約）を記録する
     report   動画由来の仮説指標と学習状況を見る
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
const experiment = require('../src/plan/experiment');
const scoreLib = require('../src/pipeline/score');
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
/* 100商品ポートフォリオ。投稿計画とは別に、棚を支える商品台帳を出す */
async function cmdPortfolio(args) {
  const s = strategy();
  const pf = await pipeline.buildPortfolio(s, {
    freshCollect: !!args.flags.fresh,
    crosscheck: args.flags.nocheck ? false : true
  });
  const files = pipeline.savePortfolio(pf);
  const sum = pf.summary;

  log.step("ポートフォリオ");
  log.detail("主力 " + sum.filled.flagship + "/" + sum.target.flagship +
    "  準主力 " + sum.filled.secondary + "/" + sum.target.secondary +
    "  ロングテール " + sum.filled.longtail + "/" + sum.target.longtail);
  log.detail("候補 " + sum.candidatePool + " 件 → ギフト適性あり " + sum.eligible +
    " 件（適性不足で除外 " + sum.rejectedByGiftReady + " 件）");
  log.detail("採用ショップ " + sum.shops + " 社");

  log.step("コレクション別の件数");
  Object.keys(sum.collections).sort(function (a, b) { return sum.collections[b] - sum.collections[a]; })
    .forEach(function (k) { log.detail(k + ": " + sum.collections[k] + " 件"); });
  /* 占有率の警告は商品カテゴリにだけ当てる。
     利用場面や価格帯が広いことは偏りではないので、不足として別に出す */
  (sum.categoryDominance || []).forEach(function (w) {
    log.warn('商品カテゴリ ' + w.productCategory + ' が ' + Math.round(w.share * 100) +
      '%。固定除外はせず、関連導線と実績を人が確認してください');
  });

  log.step('カバレッジ（不足を見る。占有率の警告対象ではない）');
  Object.keys(sum.coverage || {}).forEach(function (facet) {
    const c = sum.coverage[facet];
    const top = Object.keys(c.counts).sort(function (a, b) { return c.counts[b] - c.counts[a]; })
      .slice(0, 4).map(function (k) { return k + ' ' + c.counts[k]; }).join(' / ');
    log.detail(log.pad(facet, 16) + (top || '該当なし'));
    if (c.thin.length) log.detail(log.pad('', 16) + '手薄: ' + c.thin.join(', '));
  });

  const selInfo = sum.selection || {};
  log.step('選定');
  log.detail('絶対下限 ' + selInfo.absoluteFloor + ' / 主力の分位境界 ' + selInfo.flagshipFloor +
    ' / 準主力 ' + selInfo.secondaryFloor);
  if (selInfo.belowFloor) log.detail('下限未満で除外: ' + selInfo.belowFloor + ' 件（緩和はしません）');
  if (selInfo.outsideFlagshipQuantile) {
    log.detail('主力のうち分位の外から補った件数: ' + selInfo.outsideFlagshipQuantile + ' 件（下限は割っていません）');
  }

  log.step("動画化優先度");
  ["A", "B", "C"].forEach(function (r) {
    if (sum.videoPriority[r]) log.detail(r + ": " + sum.videoPriority[r] + " 件");
  });

  log.step("保存");
  log.detail("台帳: data/" + path.basename(files.jsonFile));
  log.detail("一覧: out/" + path.basename(files.mdFile));

  if (sum.filled.flagship < sum.target.flagship) {
    log.warn("主力が埋まっていません。collect のキーワードを増やすか、gift.minGiftReadyForPost を見直してください");
  }
}

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
    log.fail('使い方: node bin/room.js record 1,2 --outbound-clicks=30 --unique-users=18 --cv-pending=1');
    log.detail('確定した成果を入れるとき: --cv-confirmed=1 --revenue-confirmed=2480');
    log.detail('観測時点を指定するとき  : --as-of=2026-10-05');
    log.detail('旧来の --clicks --cv --revenue も引き続き使えます');
    return;
  }
  const num = function (a, b) {
    if (args.flags[a] !== undefined) return Number(args.flags[a]);
    if (b && args.flags[b] !== undefined) return Number(args.flags[b]);
    return undefined;
  };
  const metrics = {
    likes: Number(args.flags.likes) || 0,
    /* 外部送客クリック。旧 --clicks も受ける */
    outboundClicks: num('outbound-clicks', 'clicks'),
    clicks: num('outbound-clicks', 'clicks'),
    uniqueUsers: num('unique-users'),
    cvPending: num('cv-pending', 'cv'),
    cvConfirmed: num('cv-confirmed'),
    revenuePending: num('revenue-pending', 'revenue'),
    revenueConfirmed: num('revenue-confirmed'),
    asOf: args.flags['as-of'] ? new Date(args.flags['as-of'] + 'T12:00:00+09:00').toISOString() : undefined,
    dataSource: args.flags.source || 'manual'
  };
  const added = feedback.record(plan, orders, metrics, s);
  log.step(added.length + ' 件の実績を記録しました');
  added.forEach(function (e) {
    const cv = e.conversionsConfirmed !== null
      ? '確定成約' + e.conversionsConfirmed
      : '保留成約' + e.conversionsPending;
    log.detail('#' + e.date + ' ' + e.timeJst + ' [' + e.role + '] ' + e.name +
      ' → 外部クリック' + e.outboundClicks + ' ' + cv + ' / 成熟 ' + e.maturity);
  });
  const immature = added.filter(function (e) {
    return e.maturity !== 'cv_mature' && e.maturity !== 'final' && e.conversionsConfirmed === null;
  });
  if (immature.length) {
    log.detail(immature.length + ' 件はまだ成熟していません。成約0はこの時点では失敗を意味しません');
    log.detail('（アフィリエイト成果はクリック後89日以内の購入まで発生しうるため）');
  }
}

function reportMaturity(sum) {
  log.step('成果の成熟');
  log.detail('アフィリエイト成果はクリック後89日以内の購入まで発生しうる。');
  log.detail('投稿直後の成約0は失敗ではなく、観測期間が未成熟なだけである。');
  const label = { click_ready: '24時間後 クリック評価可', cv_early: '7日後 早期CV参考値', cv_mature: '30日後 CV学習開始', final: '89日後以降 最終値' };
  Object.keys(sum.maturity).forEach(function (k) {
    log.detail(log.pad(label[k] || k, 30) + ' ' + String(sum.maturity[k]).padStart(3) + ' 件');
  });
}

function reportExperiment(s, id) {
  const data = feedback.load(s);
  const rows = data.entries.filter(function (e) { return e.experimentId === id; });
  if (!rows.length) return log.fail('実験 ' + id + ' の実績がありません');

  log.step('実験 ' + id + '（' + rows.length + ' 投稿）');
  const slots = {};
  rows.forEach(function (e) {
    const k = e.slotVariant || 'control';
    const b = slots[k] || { n: 0, clicks: 0, roles: {}, mature: 0, cv: 0 };
    b.n += 1;
    b.clicks += Number(e.outboundClicks) || 0;
    b.roles[e.role] = (b.roles[e.role] || 0) + 1;
    if (feedback.isCvUsable(e)) { b.mature += 1; b.cv += Number(e.conversionsConfirmed) || 0; }
    slots[k] = b;
  });

  Object.keys(slots).forEach(function (k) {
    const b = slots[k];
    log.detail(log.pad(k, 16) + ' ' + b.n + '投稿 / 外部クリック ' + b.clicks +
      ' / クリック per 投稿 ' + (b.clicks / b.n).toFixed(2) + ' / 役割 ' + JSON.stringify(b.roles));
  });

  const need = (s.experiment || {}).minPostsPerSlotForWinner || 12;
  const ready = Object.keys(slots).every(function (k) { return slots[k].n >= need; });
  log.step('判定');
  if (!ready) {
    log.detail('各枠 ' + need + ' 投稿に達していないため、勝者は決めません。');
    log.detail('現在: ' + Object.keys(slots).map(function (k) { return k + ' ' + slots[k].n; }).join(' / '));
  } else {
    log.detail('各枠が判定に必要な件数に達しました。区間が重なる場合は保留としてください。');
  }
  log.detail('次の実験では時間帯の割当を反転してください（room experiment create --reverse）');
}

/* 時間帯クロスオーバー実験を作る */
async function cmdExperiment(args) {
  const sub = args._[1] || 'create';
  if (sub !== 'create') return log.fail('使い方: node bin/room.js experiment create [--reverse] [--date=YYYY-MM-DD]');
  const s = strategy();
  const analysis = await pipeline.analyze(s, {
    freshCollect: !!args.flags.fresh,
    crosscheck: args.flags.nocheck ? false : true
  });
  const e = experiment.create(analysis.scored, s, {
    startDate: args.flags.date || time.dateKey(),
    reverse: !!args.flags.reverse
  });
  const check = experiment.audit(e, s);

  log.step('実験 ' + e.experimentId);
  log.detail(e.note);
  log.detail('投稿 ' + e.posts.length + ' 件 / クラスター ' + e.clusters.length + ' 個 / 1日 ' + e.target.postsPerDay + ' 投稿');
  Object.keys(e.bySlot).forEach(function (k) {
    log.detail(log.pad(k, 16) + ' ' + e.bySlot[k].count + '投稿 役割 ' + JSON.stringify(e.bySlot[k].roles));
  });

  log.step('検査');
  if (check.ok) log.detail('両枠の役割構成が同一。比較条件として成立しています');
  else check.issues.forEach(function (i) { log.warn(i); });

  log.step('投稿する順番');
  e.posts.forEach(function (p) {
    log.info('  #' + String(p.order).padStart(2) + ' ' + p.date + ' ' + p.timeJst +
      '  [' + p.slotVariant + '] ' + render.ROLE_LABEL[p.role] + '  ' + p.price.toLocaleString('ja-JP') + '円');
    log.info('      ' + p.cleanName.slice(0, 44));
  });

  const file = store.writeJson('experiment-' + e.experimentId + '.json', e);
  log.step('保存');
  log.detail('data/' + path.basename(file));
  log.detail('勝者判定には各枠 ' + e.winnerReadyAt + ' 投稿が要ります。今回は片枠6投稿です');
}

function cmdReport(args) {
  const s = strategy();
  const sum = feedback.summarize(s);
  if (!sum.entries) return log.info('実績がまだありません。record コマンドで入れてください');

  if (args && args.flags && args.flags.maturity) return reportMaturity(sum);
  if (args && args.flags && args.flags.experiment) return reportExperiment(s, String(args.flags.experiment));

  const o = sum.observations;
  log.step('観測指標（' + sum.entries + ' 件の実績から）');
  log.detail(o.note);
  log.detail('ROOM反応観測    ' + o.ROOM反応観測.value.toFixed(2) + '　（' + o.ROOM反応観測.label + '）');
  log.detail('楽天市場送客観測 ' + o.楽天市場送客観測.value.toFixed(2) + '　（' + o.楽天市場送客観測.label + '）');
  log.detail('購買転換観測    ' + (o.購買転換観測.value * 100).toFixed(1) + '%　（' + o.購買転換観測.label + '）');
  if (o.購買転換観測.immaturePosts) {
    log.detail('  ※ 未成熟 ' + o.購買転換観測.immaturePosts + ' 件は購買転換の母集団から外しています');
  }
  log.detail('確定売上 ' + o.売上金額.confirmed.toLocaleString('ja-JP') + '円 / 保留 ' + o.売上金額.pending.toLocaleString('ja-JP') + '円');

  log.step('学習ゲート');
  const g = sum.gate;
  log.detail('クリック学習: ' + (g.clickLearning ? '有効' : '未達') + '　（全体 ' + g.totalPosts + ' 投稿）');
  log.detail('CV学習      : ' + (g.cvLearning ? '有効' : '未達') + '　（成熟 ' + g.maturePosts + ' 件）');
  log.detail('時間帯の勝者: ' + (g.slotWinner ? '判定可' : '判定不可') + '　' + JSON.stringify(g.slotCounts));
  if (g.reasons.length) log.detail('不足: ' + g.reasons.join(' / '));
  if (!g.clickLearning) log.detail('サンプルが足りないため、数値は出しても重みは変更していません');

  const table = function (title, stats) {
    log.step(title);
    Object.keys(stats).sort(function (a, b) { return stats[b].cvIndex - stats[a].cvIndex; }).forEach(function (k) {
      const v = stats[k];
      log.detail(log.pad(k, 18) + ' n=' + String(v.n).padStart(3) +
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
    log.detail(log.pad(r.word, 16) + ' 出現増 ' + String(r.growth).padStart(3) + '　レビュー速度 ' + (r.speed || 0).toFixed(2) + '/日');
  });
}

async function cmdGenre(args) {
  const id = args._[1] || strategy().genre.rootGenreId;
  const g = await ichiba.genre(id);
  log.step('ジャンル ' + g.id + ' : ' + g.name + '（階層 ' + g.level + '）');
  if (g.parents.length) log.detail('親: ' + g.parents.map(function (p) { return p.name + '(' + p.id + ')'; }).join(' > '));
  log.step('子ジャンル');
  g.children.forEach(function (c) { log.detail(log.pad(c.id, 10) + c.name); });
  log.info('');
  log.detail('使いたいIDを config/strategy.json の genre.rootGenreId に入れてください');
}

/* 作り直せないデータの退避。Git追跡と二重にして、
   リポジトリごと失う事故と、うっかり削除の両方に備える */
function cmdBackup(args) {
  const keep = args.flags.keep ? Number(args.flags.keep) : 14;
  const stamp = time.dateKey();
  const backupRoot = path.join(store.DATA_DIR, 'backup');
  const dir = path.join(backupRoot, stamp);
  store.ensureDir(dir);

  const targets = fs.readdirSync(store.DATA_DIR).filter(function (f) {
    return f.startsWith('snapshot-') || f === 'history.json' || f === 'results.json';
  });

  log.step('バックアップ');
  if (!targets.length) {
    log.detail('退避対象がまだありません（collect を実行すると定点観測が作られます）');
    return;
  }

  targets.forEach(function (f) {
    fs.copyFileSync(path.join(store.DATA_DIR, f), path.join(dir, f));
  });
  log.detail(targets.length + ' ファイルを data/backup/' + stamp + '/ へ退避しました');

  /* 古い退避を間引く。ディスクを無限に食わせない */
  const dirs = fs.readdirSync(backupRoot).sort();
  const drop = dirs.slice(0, Math.max(0, dirs.length - keep));
  drop.forEach(function (d) {
    fs.rmSync(path.join(backupRoot, d), { recursive: true, force: true });
  });
  if (drop.length) log.detail('古い退避 ' + drop.length + ' 日分を削除しました（保持 ' + keep + ' 日）');

  log.step('次にやること');
  log.detail('定点観測・投稿履歴・実績はGitでも追跡しています。');
  log.detail('collect のあとにコミットしておくと、このPCごと失っても復元できます。');
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
  log.detail('RAKUTEN_ACCESS_KEY: ' + (process.env.RAKUTEN_ACCESS_KEY ? '設定済み' : '未設定 ← 必須'));
  log.detail('RAKUTEN_APP_URL: ' + (process.env.RAKUTEN_APP_URL || '未設定 ← 必須'));
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

  /* 何を根拠にスコアが決まっているかを一目で分かるようにする。
     冷開始のまま重みを確定させると、実測でない値で棚が決まる */
  log.step('スコアリング');
  const vel = velocityLib.buildVelocityIndex(s);
  const bundle = pipeline.loadLatestCandidates();
  const items = bundle ? bundle.items : [];
  const phase = scoreLib.resolvePhase(items, s, { velocityIndex: vel.index, snapshotCount: vel.snapshotCount });
  const dom = scoreLib.affiliateDominance(items, s);

  log.detail('位相: ' + phase.phase +
    (phase.phase === 'cold_start' ? '（velocityで順位差を作らない）' : '（velocityを ' + Math.round(phase.velocityRamp * 100) + '% 反映）'));
  log.detail('velocity既知率: ' + (phase.velocityKnownRate * 100).toFixed(1) + '%' +
    '（観測へ切り替わる目安 ' + ((s.scoring || {}).velocityKnownRateThreshold || 0.6) * 100 + '%）');
  log.detail('有効スナップショット: ' + phase.snapshotDays + ' 日分');
  log.detail('料率の同値率: ' + (dom.share * 100).toFixed(1) + '%' +
    (dom.dominant ? '（' + dom.rate + '% に集中。affiliateの有効重みを半減）' : ''));

  const fb = feedback.summarize(s);
  if (fb.entries) {
    log.detail('投稿実績: ' + fb.entries + ' 件 / 成熟（CV学習可）: ' + fb.gate.maturePosts + ' 件');
    log.detail('学習ゲート: クリック ' + (fb.gate.clickLearning ? '有効' : '未達') +
      ' / CV ' + (fb.gate.cvLearning ? '有効' : '未達'));
  } else {
    log.detail('投稿実績: 0 件（実績が入るまで学習は動きません）');
  }

  if (process.env.RAKUTEN_APP_ID && process.env.RAKUTEN_ACCESS_KEY && process.env.RAKUTEN_APP_URL) {
    log.step('接続テスト');
    try {
      const g = await ichiba.genre(s.genre.rootGenreId);
      log.detail('楽天API 応答あり: ' + g.name + ' / 子ジャンル ' + g.children.length + ' 件');
      /* rootGenreId が 0 は全ジャンル横断の正常な設定。名前が空でも異常ではない */
      if (!g.name && String(s.genre.rootGenreId) !== '0') {
        log.warn('ジャンルIDが正しくない可能性があります。room genre 0 で探してください');
      }
    } catch (e) {
      log.warn('楽天APIに繋がりません: ' + e.message);
    }
  }
}

/* 実データが想定どおり返っているかを1クエリで点検する。
   楽天APIのレスポンスが欠けていると、スコアは静かに壊れる。
   「動いてはいるが全商品の作り込み度が0」のような事故を
   最初に見つけるためのコマンド。 */
async function cmdProbe(args) {
  const s = strategy();
  const keyword = args._[1] || (s.genre.subThemes[0] && s.genre.subThemes[0].keywords[0]) || 'キッチン 収納';

  log.step('点検クエリ: "' + keyword + '" / ジャンル ' + s.genre.rootGenreId);
  const items = await ichiba.searchItems({
    keyword: keyword,
    genreId: s.genre.rootGenreId,
    hits: 30,
    page: 1,
    sort: 'standard',
    minPrice: s.filters.priceHardMin,
    maxPrice: s.filters.priceHardMax
  });

  if (!items.length) {
    log.warn('0件でした。ジャンルIDかキーワードが実態と合っていません');
    log.detail('node bin/room.js genre 0 でジャンルを探し直してください');
    return;
  }
  log.detail(items.length + ' 件取得');

  /* 各フィールドが「何件で埋まっているか」を見る。
     1件だけ見ても、たまたま空だったのか全滅なのか分からない。 */
  const checks = [
    { key: 'caption', label: '商品説明', impact: '作り込み度が全商品0になる', ok: function (i) { return i.captionLength > 50; } },
    { key: 'affiliateRate', label: 'アフィリ報酬率', impact: '広告加熱度が機能しない（最重要）', ok: function (i) { return i.affiliateRate > 0; } },
    { key: 'pointRate', label: 'ポイント倍率', impact: 'ポイント評価が効かない', ok: function (i) { return i.pointRate >= 1; } },
    { key: 'images', label: '商品画像', impact: '作り込み度が下がる', ok: function (i) { return i.imageCount > 0; } },
    { key: 'reviewCount', label: 'レビュー件数', impact: 'ハードフィルタを誰も通らない', ok: function (i) { return i.reviewCount > 0; } },
    { key: 'reviewAverage', label: 'レビュー平均', impact: '同上', ok: function (i) { return i.reviewAverage > 0; } },
    { key: 'genreId', label: 'ジャンルID', impact: 'カテゴリ相関が効かない', ok: function (i) { return !!i.genreId; } },
    { key: 'shopCode', label: 'ショップコード', impact: '1ショップ上限が効かない', ok: function (i) { return !!i.shopCode; } }
  ];

  log.step('レスポンスの充足率');
  let broken = 0;
  checks.forEach(function (c) {
    const n = items.filter(c.ok).length;
    const rate = Math.round(n / items.length * 100);
    const mark = rate >= 80 ? '○' : rate > 0 ? '△' : '×';
    log.detail(mark + ' ' + log.pad(c.label, 16) + String(rate).padStart(3) + '%  (' + n + '/' + items.length + ')' +
      (rate < 80 ? '  → ' + c.impact : ''));
    if (rate < 80) broken += 1;
  });

  const affiliated = items.filter(function (i) { return /hb\.afl\.rakuten\.co\.jp/.test(i.affiliateUrl); }).length;
  log.detail((affiliated > 0 ? '○' : '×') + ' アフィリリンク  ' +
    Math.round(affiliated / items.length * 100) + '%' +
    (affiliated === 0 ? '  → RAKUTEN_AFFILIATE_ID が未設定か不正' : ''));

  log.step('ハードフィルタの通過率');
  const passed = items.filter(function (i) { return collectLib.passesHardFilter(i, s.filters) === null; });
  log.detail(passed.length + '/' + items.length + ' 件が通過（★' + s.filters.minReviewAverage +
    '以上 / レビュー' + s.filters.minReviewCount + '件以上 / ' + s.filters.priceHardMin + '-' + s.filters.priceHardMax + '円）');
  if (passed.length === 0) {
    log.warn('1件も通っていません。キーワードが商材とズレているか、フィルタが厳しすぎます');
  } else if (passed.length < items.length * 0.15) {
    log.warn('通過率が低すぎます。このキーワードでは候補が集まりません');
  }

  log.step('実データのスコア分布（参考値）');
  const rates = items.map(function (i) { return i.affiliateRate; }).filter(function (r) { return r > 0; }).sort(function (a, b) { return a - b; });
  if (rates.length) {
    log.detail('アフィリ報酬率: 最小 ' + rates[0] + '% / 中央 ' + rates[Math.floor(rates.length / 2)] + '% / 最大 ' + rates[rates.length - 1] + '%');
    log.detail('  → config/strategy.json の adHeat.affiliateRateBase / affiliateRateHot をこの幅に合わせてください');
  }
  const prices = passed.map(function (i) { return i.price; }).sort(function (a, b) { return a - b; });
  if (prices.length) {
    log.detail('通過商品の価格: 最小 ' + prices[0] + '円 / 中央 ' + prices[Math.floor(prices.length / 2)] + '円 / 最大 ' + prices[prices.length - 1] + '円');
  }

  log.step(broken === 0 ? '点検完了: 問題なし' : '点検完了: ' + broken + ' 項目に欠損あり');
  if (broken > 0) {
    log.detail('src/rakuten/ichiba.js の searchItems が渡しているパラメータを見直してください');
  }
}

function usage() {
  log.info([
    '楽天ROOM 運用エンジン',
    '',
    '  node bin/room.js doctor              設定と接続を確認する（最初にこれ）',
    '  node bin/room.js genre [id]          ジャンルIDを調べる',
    '  node bin/room.js probe [keyword]     実データが想定どおり返るか点検する',
    '  node bin/room.js collect             楽天市場から候補を収集（毎日回す）',
    '  node bin/room.js daily               収集から計画作成までを一気に（cron向け）',
    '  node bin/room.js launch              初動6件の検証計画を作る',
    '  node bin/room.js plan [--days=3]     通常運用の計画を作る',
    '  node bin/room.js next [--count=5]    これから出す投稿を見る',
    '  node bin/room.js now [--adapter=..]  投稿時刻が来たものを出す',
    '  node bin/room.js done 1,2,3          投稿済みにする',
    '  node bin/room.js record 1 --clicks=30 --cv=1 --likes=12 --revenue=2480',
    '  node bin/room.js report              動画由来の仮説指標を見る',
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
      case 'report': return cmdReport(args);
      case 'experiment': return await cmdExperiment(args);
      case 'trend': return cmdTrend();
      case 'genre': return await cmdGenre(args);
      case 'portfolio': return await cmdPortfolio(args);
      case 'probe': return await cmdProbe(args);
      case 'backup': return cmdBackup(args);
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

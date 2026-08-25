/* =========================================================
   QUEUE — 投稿計画の保存と取り出し
   楽天ROOMには投稿APIが無い。よってこのエンジンの成果物は
   「いつ・何を・どの文で出すか」が確定したキューであり、
   投稿の実行だけをアダプタに委ねる（post/adapters/）。
   ========================================================= */
'use strict';

const store = require('../util/store');
const time = require('../util/time');

function planFile(kind, startDate) {
  return 'plan-' + kind + '-' + startDate + '.json';
}

function savePlan(plan) {
  const file = planFile(plan.kind, plan.startDate);
  store.writeJson(file, plan);
  store.writeJson('plan-current.json', { file: file, kind: plan.kind, startDate: plan.startDate, savedAt: new Date().toISOString() });
  return file;
}

function loadCurrentPlan() {
  const ptr = store.readJson('plan-current.json', null);
  if (!ptr) return null;
  return store.readJson(ptr.file, null);
}

/* 未投稿かつ、指定時刻までに投稿すべきものを返す。
   cron で数分おきに回す前提なので、一度提示したものは既定で除く。
   これをやらないと同じ投稿の通知が猶予時間のあいだ何度も飛ぶ。 */
function duePosts(plan, atDate, graceMinutes, opts) {
  if (!plan) return [];
  const options = opts || {};
  const now = (atDate || new Date()).getTime();
  const grace = (graceMinutes === undefined ? 90 : graceMinutes) * 60000;
  return plan.posts.filter(function (p) {
    if (p.postedAt) return false;
    if (p.notifiedAt && !options.includeNotified) return false;
    const t = new Date(p.scheduledAt).getTime();
    return t <= now && now - t <= grace;
  });
}

function markPresented(plan, orders) {
  const set = new Set(orders);
  let n = 0;
  plan.posts.forEach(function (p) {
    if (set.has(p.order) && !p.notifiedAt) { p.notifiedAt = new Date().toISOString(); n += 1; }
  });
  if (n) savePlan(plan);
  return n;
}

function upcomingPosts(plan, atDate, count) {
  if (!plan) return [];
  const now = (atDate || new Date()).getTime();
  return plan.posts
    .filter(function (p) { return !p.postedAt && new Date(p.scheduledAt).getTime() > now; })
    .slice(0, count || 5);
}

function markPosted(plan, orders, note) {
  const set = new Set(orders);
  let n = 0;
  plan.posts.forEach(function (p) {
    if (set.has(p.order) && !p.postedAt) {
      p.postedAt = new Date().toISOString();
      if (note) p.postNote = note;
      n += 1;
    }
  });
  savePlan(plan);
  return n;
}

function progress(plan) {
  if (!plan) return null;
  const done = plan.posts.filter(function (p) { return !!p.postedAt; }).length;
  return {
    total: plan.posts.length,
    posted: done,
    remaining: plan.posts.length - done,
    nextAt: (plan.posts.find(function (p) { return !p.postedAt; }) || {}).scheduledAt || null
  };
}

module.exports = { savePlan, loadCurrentPlan, duePosts, upcomingPosts, markPosted, markPresented, progress, planFile };

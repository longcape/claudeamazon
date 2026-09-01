/* =========================================================
   SCHEDULE — 投稿時刻の割り当て
   ---------------------------------------------------------
   ゴールデンタイムは20:00-23:00（JST）。ホットタイムには
   全投稿を流し込む。日中のスロットは、夜に効かせるための
   露出の下地づくりとして少数だけ置く。
   重要: 評価取り→売上 のペアを時間で分断してはいけない。
   ペアを1つの「ユニット」として扱い、ユニット単位で
   スロットへ落とす。
   ========================================================= */
'use strict';

const time = require('../util/time');
const T = require('../util/text');

/* 評価取り＋直後の売上を1ユニットに束ねる */
function buildUnits(seq) {
  const units = [];
  let i = 0;
  while (i < seq.length) {
    if (seq[i].role === 'bait' && seq[i + 1] && seq[i + 1].role === 'cv') {
      units.push([seq[i], seq[i + 1]]);
      i += 2;
    } else {
      units.push([seq[i]]);
      i += 1;
    }
  }
  return units;
}

/* 時刻が未設定の投稿を渡されても検査ごと落とさない。
   時間割を組む前の商品リストをそのままNG検査へ通す使い方があるため、
   欠損は「時間帯の判定対象外」として -1 を返す */
function minutesOf(hhmm) {
  if (typeof hhmm !== 'string' || hhmm.indexOf(':') < 0) return -1;
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;
  return h * 60 + m;
}

function hhmmOf(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

/* 決定的なゆらぎ。毎回同じ分に投稿すると機械的すぎる */
function jitter(seed, range) {
  if (!range) return 0;
  const h = parseInt(T.hash(seed).slice(0, 5), 36);
  return (h % (range * 2 + 1)) - range;
}

/* 枠数 room に収まり、許可役割にも合うユニットを先読みで探す。
   見つからなければ -1。順序はできるだけ保ちたいので近傍だけ見る。 */
function findFittingUnit(units, from, room, roles) {
  const window = Math.min(units.length, from + 8);
  for (let i = from; i < window; i += 1) {
    const unit = units[i];
    if (unit.length > room) continue;
    if (roles && !unit.every(function (p) { return roles.indexOf(p.role) >= 0; })) continue;
    return i;
  }
  return -1;
}

function daySlots(strategy, capacity, hotTimeOnly) {
  const cfg = strategy.schedule;
  const groups = [];

  (hotTimeOnly ? [] : (cfg.warmupSlots || [])).forEach(function (w) {
    const times = [];
    for (let i = 0; i < w.count; i += 1) times.push(minutesOf(w.at) + i * 3);
    groups.push({ kind: 'warmup', label: w.at, times: times, roles: w.roles || null });
  });

  const start = minutesOf(cfg.hotTime.start);
  const end = minutesOf(cfg.hotTime.end);
  const step = cfg.hotTime.intervalMinutes;
  const hotTimes = [];
  for (let t = start; t <= end && hotTimes.length < capacity + 4; t += step) hotTimes.push(t);
  groups.push({ kind: 'hot', label: cfg.hotTime.start + '-' + cfg.hotTime.end, times: hotTimes, roles: null });

  groups.sort(function (a, b) { return a.times[0] - b.times[0]; });
  return groups;
}

/* seq を日付とスロットに割り付ける */
function assignTimes(seq, strategy, opts) {
  const options = opts || {};
  const perDay = options.postsPerDay || strategy.schedule.dailyPosts;
  const startDate = options.startDate || time.dateKey();
  const units = buildUnits(seq);

  const out = [];
  let dayIndex = 0;
  let unitIdx = 0;

  while (units.length > unitIdx) {
    const dateKey = time.addDaysToKey(startDate, dayIndex);
    const groups = daySlots(strategy, perDay, options.hotTimeOnly);
    let placedToday = 0;

    for (const group of groups) {
      let slotIdx = 0;
      while (slotIdx < group.times.length && placedToday < perDay && units.length > unitIdx) {
        const room = Math.min(group.times.length - slotIdx, perDay - placedToday);
        /* このスロットに収まるユニットを先読みで探す。
           日中の1枠しかないスロットには、ペアではなく単発投稿を回す。 */
        const found = findFittingUnit(units, unitIdx, room, group.roles);
        if (found < 0) break;
        const unit = units.splice(found, 1)[0];

        unit.forEach(function (post) {
          const base = group.times[slotIdx];
          let at = base;
          if (group.kind === 'hot') {
            /* ゆらぎでゴールデンタイムの外へ出てしまっては本末転倒なので内側に収める */
            const lo = minutesOf(strategy.schedule.hotTime.start);
            const hi = minutesOf(strategy.schedule.hotTime.end);
            at = Math.max(lo, Math.min(hi, base + jitter(post.itemCode + dateKey, strategy.schedule.hotTime.jitterMinutes)));
          }
          const hhmm = hhmmOf(at);
          out.push(Object.assign({}, post, {
            date: dateKey,
            slotKind: group.kind,
            timeJst: hhmm,
            scheduledAt: time.jstAt(dateKey, hhmm).toISOString(),
            dayIndex: dayIndex
          }));
          slotIdx += 1;
          placedToday += 1;
        });
      }
    }

    if (placedToday === 0) {
      /* どのスロットにも入らない（ユニットが大きすぎる等）。無限ループ回避 */
      const unit = units.splice(unitIdx, 1)[0];
      unit.forEach(function (post, k) {
        const hhmm = hhmmOf(minutesOf(strategy.schedule.hotTime.start) + k * strategy.schedule.hotTime.intervalMinutes);
        out.push(Object.assign({}, post, {
          date: dateKey, slotKind: 'hot', timeJst: hhmm,
          scheduledAt: time.jstAt(dateKey, hhmm).toISOString(), dayIndex: dayIndex
        }));
      });
    }

    dayIndex += 1;
    if (dayIndex > 60) break;
  }

  out.sort(function (a, b) { return a.scheduledAt < b.scheduledAt ? -1 : 1; });
  return out.map(function (p, i) { return Object.assign({}, p, { order: i + 1 }); });
}

/* 時間割が規則を守れているかの検査 */
function auditSchedule(posts, strategy) {
  const issues = [];
  const hotStart = minutesOf(strategy.schedule.hotTime.start);
  const hotEnd = minutesOf(strategy.schedule.hotTime.end);

  let hot = 0;
  posts.forEach(function (p) {
    const m = minutesOf(p.timeJst);
    if (m >= hotStart && m <= hotEnd) hot += 1;
  });

  /* 売上投稿が評価取りと同じ日・同じ時間帯にいるか */
  posts.forEach(function (p, i) {
    if (p.role !== 'cv') return;
    const prev = posts[i - 1];
    if (!prev || prev.role !== 'bait') {
      issues.push({ level: 'error', message: p.timeJst + ' の売上投稿の直前が評価取りではない' });
      return;
    }
    const gap = (new Date(p.scheduledAt) - new Date(prev.scheduledAt)) / 60000;
    if (gap > 25) {
      issues.push({ level: 'warn', message: p.timeJst + ' の売上投稿が直前の評価取りから ' + Math.round(gap) + '分あいている（リズムが切れる）' });
    }
  });

  const byDay = {};
  posts.forEach(function (p) { byDay[p.date] = (byDay[p.date] || 0) + 1; });
  Object.keys(byDay).forEach(function (d) {
    if (byDay[d] > strategy.schedule.dailyPosts) {
      issues.push({ level: 'warn', message: d + ' の投稿数が上限を超えている（' + byDay[d] + '）' });
    }
  });

  return { issues: issues, hotTimeRate: posts.length ? hot / posts.length : 0, byDay: byDay, days: Object.keys(byDay).length };
}

module.exports = { assignTimes, auditSchedule, buildUnits, daySlots, findFittingUnit, minutesOf, hhmmOf };

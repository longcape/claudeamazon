/* =========================================================
   TIME — 日本時間(JST)の固定オフセット計算
   ---------------------------------------------------------
   サーバがUTCでもGitHub Actions上でも、ゴールデンタイムは
   常に日本時間の20:00-23:00でなければ意味がない。
   日本にサマータイムは無いので +9 固定で足りる。
   ========================================================= */
'use strict';

const JST_OFFSET_MIN = 9 * 60;

/* UTCのDate -> JSTの年月日時分 */
function toJstParts(date) {
  const shifted = new Date(date.getTime() + JST_OFFSET_MIN * 60000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay()
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }

/* 'YYYY-MM-DD'（JST基準の日付） */
function dateKey(date) {
  const p = toJstParts(date || new Date());
  return p.year + '-' + pad2(p.month) + '-' + pad2(p.day);
}

/* 'HH:MM'（JST基準の時刻） */
function timeLabel(date) {
  const p = toJstParts(date);
  return pad2(p.hour) + ':' + pad2(p.minute);
}

/* JSTの「2026-08-25 20:00」を実時刻(Date)に変換する */
function jstAt(dateKeyStr, hhmm) {
  const [y, m, d] = dateKeyStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - JST_OFFSET_MIN * 60000);
}

function addDaysToKey(dateKeyStr, days) {
  const base = jstAt(dateKeyStr, '12:00');
  return dateKey(new Date(base.getTime() + days * 86400000));
}

function daysBetweenKeys(a, b) {
  const diff = jstAt(b, '12:00').getTime() - jstAt(a, '12:00').getTime();
  return Math.round(diff / 86400000);
}

/* JSTでの表示用 'MM/DD(曜) HH:MM' */
function stamp(date) {
  const p = toJstParts(date);
  const w = ['日', '月', '火', '水', '木', '金', '土'][p.weekday];
  return pad2(p.month) + '/' + pad2(p.day) + '(' + w + ') ' + pad2(p.hour) + ':' + pad2(p.minute);
}

module.exports = { toJstParts, dateKey, timeLabel, jstAt, addDaysToKey, daysBetweenKeys, stamp, JST_OFFSET_MIN };

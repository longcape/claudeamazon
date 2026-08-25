/* =========================================================
   TEXT — 商品名・説明文の解析ユーティリティ
   楽天の商品名は「【楽天1位】送料無料 ◯◯ ラック 3段 ...」の
   ように販促ノイズが多い。素の商品名を取り出せないと
   紹介文もキーワード照合も精度が出ない。
   ========================================================= */
'use strict';

/* 全角英数・カナ幅の揺れを吸収する */
function normalize(s) {
  if (!s) return '';
  return String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[　]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 【】[]（）内の販促文言と、送料無料などの定型句を落とす */
const NOISE = [
  /【[^】]*】/g, /\[[^\]]*\]/g, /≪[^≫]*≫/g, /＜[^＞]*＞/g,
  /送料無料/g, /あす楽/g, /ポイント\s*\d+\s*倍/g, /最大\s*\d+\s*%?\s*(OFF|オフ)/gi,
  /楽天\s*\d*\s*位/g, /ランキング\s*\d*\s*位/g, /レビュー\s*特典/g, /クーポン利用で[^\s]*/g,
  /\d+年\d+月\d+日?/g, /新生活|母の日|父の日|敬老の日|お歳暮|お中元/g
];

function cleanItemName(name) {
  let s = normalize(name);
  NOISE.forEach(function (re) { s = s.replace(re, ' '); });
  return s.replace(/[\/｜|]/g, ' ').replace(/\s+/g, ' ').trim();
}

/* 商品名の「核」= 最初に現れる意味のある語の連なり。長すぎる名前を短くする */
function coreName(name, maxLen) {
  const cleaned = cleanItemName(name);
  const limit = maxLen || 26;
  if (cleaned.length <= limit) return cleaned;
  const cut = cleaned.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.5 ? cut.slice(0, lastSpace) : cut).trim();
}

function stripHtml(s) {
  return normalize(String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' '));
}

function countMatches(text, words) {
  const s = normalize(text);
  let n = 0;
  words.forEach(function (w) { if (w && s.indexOf(w) >= 0) n += 1; });
  return n;
}

/* 0..1 に収める線形正規化 */
function scale(value, lo, hi) {
  if (!isFinite(value)) return 0;
  if (hi === lo) return 0;
  return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function hash(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

module.exports = { normalize, cleanItemName, coreName, stripHtml, countMatches, scale, clamp01, hash };

/* =========================================================
   ADAPTERS — 投稿実行の差し替え口
   ---------------------------------------------------------
   楽天ROOMは公開の投稿APIを持たない。エンジン側は
   「何を・いつ・どの文で出すか」までを確定させ、
   実際に出す手段はここで差し替える。
     manual  … 画面とファイルに出す（既定・規約リスクなし）
     webhook … Discord/Slack へ飛ばす
     <path>  … 自分で書いたモジュール（{ name, post(posts) }）
   ========================================================= */
'use strict';

const path = require('path');

function resolve(spec) {
  const key = spec || process.env.ROOM_POST_ADAPTER || 'manual';
  if (key === 'manual') return require('./manual');
  if (key === 'webhook') return require('./webhook');

  const full = path.isAbsolute(key) ? key : path.resolve(process.cwd(), key);
  const mod = require(full);
  if (typeof mod.post !== 'function') {
    throw new Error(key + ' は post(posts) を持つモジュールではありません');
  }
  return mod;
}

module.exports = { resolve };

/* =========================================================
   知識の置き場所を 1 か所で決める
   ---------------------------------------------------------
   戦術・座標・映像の証拠・パッチ情報・見合わせリストの正本は、このリポジトリの外にある
   共通知識基盤（02_ロングケープ/AI_Coaching_Knowledge_Base）。対応は同基盤の
   99_Governance/VTC_CANONICAL.json にある。

   道具ごとに置き場所を書くと、必ずどれかが古い方（knowledge/ の写し）を読み書きする。
   実際に、収集の作業が写しの方へ書き、正本と食い違った。読むのも書くのも、ここを通すこと。

     import { knowledgePath, isCanonical } from './kb-paths.mjs';
     knowledgePath('tactics', 'ascent.json')   // 正本側のパス
     knowledgePath('agents', 'omen.json')      // 対応表に無い種類は knowledge/ 側

   更新の向きは 正本 → 写し（knowledge/）→ 生成物（assets/js/tactics-library.js）の一方向。
   写しは tools/kb-mirror.mjs が作る。写しを直接直さない。
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LEGACY = path.join(ROOT, 'knowledge');
export const KB = path.resolve(ROOT, '../../02_ロングケープ/AI_Coaching_Knowledge_Base');
export const KB_GAME = path.join(KB, '01_Games', 'VALORANT');
const CONFIG = path.join(KB, '99_Governance', 'VTC_CANONICAL.json');

/* --legacy-knowledge は、写しの方を読んで結果を比べるための確認用。ふだんは付けない */
export const useLegacy = process.argv.includes('--legacy-knowledge');

/* 対応表が読めないときに黙って写しへ落とすと、古いデータで作ったことに気づけない。
   正本が見つからなければ止める（写しで確かめたいときは --legacy-knowledge を明示する） */
export const MAPPING = (function () {
  if (useLegacy) return {};
  if (!fs.existsSync(CONFIG)) {
    throw new Error('共通知識基盤が見つからない: ' + CONFIG + '（写しで確かめるなら --legacy-knowledge を付ける）');
  }
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).mapping || {};
})();

export function isCanonical(category) {
  return Object.prototype.hasOwnProperty.call(MAPPING, category);
}

export function knowledgePath(category, ...rest) {
  if (!isCanonical(category)) return path.join(LEGACY, category, ...rest);
  return path.join(KB_GAME, MAPPING[category], ...rest);
}

/* 写し側の同じ場所（kb-mirror.mjs 用） */
export function legacyPath(category, ...rest) {
  return path.join(LEGACY, category, ...rest);
}

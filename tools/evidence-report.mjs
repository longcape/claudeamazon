/* =========================================================
   実戦での裏取りの集計を出す
   ---------------------------------------------------------
   knowledge/evidence/<map>.json を読み、マップごとの件数と、
   実戦確認済み（confirmed / variant）にした戦術の証拠を一覧にする。
   公開の判断材料として人が読むためのもの。

     node tools/evidence-report.mjs            # 集計だけ
     node tools/evidence-report.mjs --detail   # 証拠の中身も出す
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { knowledgePath } from './kb-paths.mjs';

const DIR = knowledgePath('evidence');
const detail = process.argv.includes('--detail');
const RESULTS = ['confirmed', 'variant', 'partial', 'not_observed', 'contradicted'];

const total = { rounds: 0, vods: 0, checked: 0 };
RESULTS.forEach((r) => { total[r] = 0; });

/* `_` で始まるファイルはマップの証拠ではない（類似点検の記録など）ので読まない */
fs.readdirSync(DIR).filter((f) => /^[a-z]+\.json$/.test(f)).sort().forEach((f) => {
  const ev = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const tactics = JSON.parse(fs.readFileSync(knowledgePath('tactics', f), 'utf8')).tactics;
  const byKey = {};
  tactics.forEach((t) => { byKey[t.key] = t; });

  const count = {};
  RESULTS.forEach((r) => { count[r] = 0; });
  const sides = { ATK: 0, DEF: 0 };
  ev.verifications.forEach((v) => {
    count[v.result] = (count[v.result] || 0) + 1;
    const t = byKey[v.key];
    if (t && (v.result === 'confirmed' || v.result === 'variant')) sides[t.side]++;
  });

  total.rounds += ev.rounds.length;
  total.vods += ev.vods.length;
  total.checked += ev.verifications.length;
  RESULTS.forEach((r) => { total[r] += count[r]; });

  console.log(ev.map + ': 試合 ' + ev.vods.length + ' / ラウンド ' + ev.rounds.length + ' / 照合 ' + ev.verifications.length +
    ' → 一致 ' + count.confirmed + ' 派生 ' + count.variant + '（攻め ' + sides.ATK + '・守り ' + sides.DEF + '） 部分 ' + count.partial +
    ' 未観測 ' + count.not_observed + ' 食い違い ' + count.contradicted);

  if (!detail) return;
  ev.verifications.filter((v) => v.result === 'confirmed' || v.result === 'variant' || v.result === 'contradicted').forEach((v) => {
    const t = byKey[v.key];
    console.log('  [' + v.result + '] ' + v.key + ' — ' + (t ? t.name.ja : '?'));
    (v.evidence || []).forEach((e) => {
      console.log('     ' + e.team + ' vs ' + e.opponent + ' R' + e.round + ' ' + (e.clock || '') + ' ' + e.youtube);
      if (e.match) {
        console.log('       配置: ' + e.match.setup_ja);
        console.log('       スキル: ' + e.match.utility_ja);
        console.log('       経路: ' + e.match.route_ja);
        console.log('       目的: ' + e.match.objective_ja);
      }
      if (e.variant_ja) console.log('       違い: ' + e.variant_ja);
    });
    if (v.note_ja) console.log('     メモ: ' + v.note_ja);
  });
});

console.log('\n合計: 試合 ' + total.vods + ' / ラウンド ' + total.rounds + ' / 照合 ' + total.checked +
  ' → 一致 ' + total.confirmed + ' 派生 ' + total.variant + ' 部分 ' + total.partial +
  ' 未観測 ' + total.not_observed + ' 食い違い ' + total.contradicted);

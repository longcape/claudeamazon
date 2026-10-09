/* =========================================================
   ✓ への昇格候補の一覧を出す
   ---------------------------------------------------------
   証拠ファイルの `candidates`（公開中の判定とは別に置いてある、あとから集めた証拠）を読み、
   マップごとに「条件がそろったもの／まだのもの」を一覧にする。公開の判断材料として人が読む。
   ここに出たものを公開するかどうかはユーザーが決める。この道具は何も書き換えない。
   判断が出て反映したものは status が promoted / applied / demoted になり、「片づいた」に数える。

     node tools/candidates-report.mjs            # 集計
     node tools/candidates-report.mjs --detail   # 証拠の中身も出す
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { knowledgePath } from './kb-paths.mjs';

const detail = process.argv.includes('--detail');
const DIR = knowledgePath('evidence');
const total = { ready: 0, not_ready: 0, done: 0 };
/* 判断が出て片づいたもの。promoted = ✓ へ昇格 / applied = 確認ラウンド数に反映 / demoted = ✓ から降格 */
const DONE = { promoted: '昇格済み', applied: '反映済み', demoted: '降格済み' };
const byKind = {};

fs.readdirSync(DIR).filter((f) => /^[a-z]+\.json$/.test(f)).sort().forEach((f) => {
  const ev = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const tactics = JSON.parse(fs.readFileSync(knowledgePath('tactics', f), 'utf8')).tactics;
  const name = (key) => { const t = tactics.find((x) => x.key === key); return t ? t.name.ja + '（' + (t.side === 'ATK' ? '攻め' : '守り') + '）' : '?'; };
  const list = ev.candidates || [];
  if (!list.length) return;
  const ready = list.filter((c) => c.status === 'ready');
  const done = list.filter((c) => DONE[c.status]);
  console.log(ev.map + ': 候補 ' + list.length + ' → そろった ' + ready.length + ' / まだ ' + (list.length - ready.length - done.length) + ' / 片づいた ' + done.length);
  list.forEach((c) => {
    if (DONE[c.status]) {
      total.done++;
      console.log('  [' + DONE[c.status] + ' ' + (c.resolved_on || '') + '] ' + c.kind + ' / ' + c.key + ' — ' + name(c.key) +
        (c.rounds_counted ? ' / 数えたラウンド ' + c.rounds_counted.length : ''));
      if (detail && c.resolution_ja) console.log('      ' + c.resolution_ja);
      return;
    }
    total[c.status === 'ready' ? 'ready' : 'not_ready']++;
    byKind[c.kind] = byKind[c.kind] || { ready: 0, not_ready: 0 };
    byKind[c.kind][c.status === 'ready' ? 'ready' : 'not_ready']++;
    const how = [...new Set((c.new_evidence || []).map((e) => e.utility_read_from).filter(Boolean))].join('+');
    console.log('  [' + (c.status === 'ready' ? 'そろった' : 'まだ') + '] ' + c.kind + ' / ' + c.key + ' — ' + name(c.key) +
      ' / 確認ラウンド ' + (c.rounds_total_if_promoted ?? '?') + (how ? ' / スキルの読み方 ' + how : '') +
      (c.proposed_tactic ? ' / 書き直し案あり' : ''));
    if (c.status !== 'ready' && c.blocker_ja) console.log('      理由: ' + String(c.blocker_ja).slice(0, 160));
    ['caveat_ja', 'contradiction_ja'].forEach((k) => { if (c[k]) console.log('      ' + (k === 'contradiction_ja' ? '食い違いの疑い: ' : '注意: ') + String(c[k]).slice(0, 220)); });
    if (detail) (c.new_evidence || []).forEach((e) => {
      console.log('      ' + e.team + ' vs ' + e.opponent + ' R' + e.round + ' ' + (e.youtube || '') + ' [' + (e.utility_read_from || '') + ']');
      if (e.match) console.log('        スキル: ' + String(e.match.utility_ja || '').slice(0, 200));
    });
  });
});

console.log('\n合計: そろった ' + total.ready + ' / まだ ' + total.not_ready + ' / 片づいた ' + total.done);
Object.keys(byKind).forEach((k) => console.log('  ' + k + ': そろった ' + byKind[k].ready + ' / まだ ' + byKind[k].not_ready));

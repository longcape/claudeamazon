/* =========================================================
   公開する戦術（✓ VCT 実戦確認済み）を 1 件ずつ確かめる
   ---------------------------------------------------------
   公開してよい条件を機械的に見る。1 つでも欠けたら終了コード 1。

     node tools/verify-publish.mjs            # 問題だけ出す
     node tools/verify-publish.mjs --table    # 全件の一覧も出す

   見ること:
   - 映像の証拠がある（大会・チーム・相手・ラウンド・時刻つき URL）。確認したラウンド数
   - マップ・攻守・確認したパッチがある
   - 実戦の映像から書いたもの（observed）である
   - 配置盤があり、マークが全部床の上にある
   - **映像のミニマップから読めない種類のスキルを、手順や説明に書いていない**
     読めるのは スモーク・壁・設置物（罠）・リコンの輪・視界を遮るもの。フラッシュ・スタン・
     モロ・ショックなどは読めないので、✓ の中身に入っていたら推測が混ざっている。
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, LEGACY, knowledgePath } from './kb-paths.mjs';

const table = process.argv.includes('--table');
const READABLE = ['smoke', 'wall', 'trap', 'recon', 'vision-denial'];
/* 種類としては読めない側だが、置いた物としてミニマップに出るので位置を確認できるもの。
   チェンバーの戻り先（アンカー）と、ケイオーのナイフ（刺さった場所に印が出る）。 */
const READABLE_OBJECTS = ['chamber:E', 'kayo:E'];
/* 説明文に出てはいけない言葉（映像から読めないスキル）。「読めていない」と断っている文は除く */
const UNREADABLE_WORDS = /フラッシュ|スタン|モロ|ショック|コンカス|ブームボット|グレネード|flash|stun|molly|shock dart|concuss/i;
const DISCLAIMS = /読め|確認でき|未確認|分から|不明|could not|not readable|unconfirmed|not visible|not seen/i;

const agents = {};
fs.readdirSync(path.join(LEGACY, 'agents')).filter((f) => /^[a-z]+\.json$/.test(f)).forEach((f) => {
  const a = JSON.parse(fs.readFileSync(path.join(LEGACY, 'agents', f), 'utf8'));
  agents[a.id] = {};
  (a.abilities || []).forEach((ab) => { agents[a.id][ab.slot] = ab.kind; });
});

/* 生成物（実際に公開されるもの）から、盤面と根拠を読む */
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'js', 'tactics-library.js'), 'utf8'), sandbox);
const LIB = sandbox.window.VCT_LIBRARY;

const floorOf = (mapId) => {
  const mask = JSON.parse(fs.readFileSync(knowledgePath('callouts', '_floor', mapId + '.json'), 'utf8'));
  const k = mask.size / 100;
  return (x, y) => { const cx = Math.round(x * k), cy = Math.round(y * k); return !!mask.rows[cy] && mask.rows[cy][cx] === '1'; };
};

const problems = [];
const rows = [];
let total = 0, one = 0, many = 0;
const byMap = {};

Object.keys(LIB.maps).sort().forEach((mapId) => {
  const src = JSON.parse(fs.readFileSync(knowledgePath('tactics', mapId + '.json'), 'utf8')).tactics;
  const ev = JSON.parse(fs.readFileSync(knowledgePath('evidence', mapId + '.json'), 'utf8'));
  const on = floorOf(mapId);
  byMap[mapId] = { ATK: 0, DEF: 0 };

  LIB.maps[mapId].forEach((it) => {
    total++;
    const w = it.key;
    const bad = (msg) => problems.push(w + ': ' + msg);
    const t = src.find((x) => x.key === it.key);
    const v = (ev.verifications || []).find((x) => x.key === it.key);
    if (it.lv !== 'A') { bad('✓ ではないものが公開対象に入っている（' + it.lv + '）'); return; }
    if (!t) { bad('正本の戦術データに無い'); return; }
    if (!v || v.result !== 'confirmed') bad('証拠の判定が confirmed ではない（' + (v ? v.result : 'なし') + '）');

    const proofs = (v && v.evidence) || [];
    const rounds = new Set(proofs.map((e) => e.vod + '#' + e.round)).size;
    if (!rounds) bad('映像の証拠が無い');
    proofs.forEach((e) => {
      const vod = (ev.vods || []).find((x) => x.id === e.vod) || {};
      if (!e.team || !e.opponent || !vod.event || !(Number(e.round) >= 1)) bad('証拠の項目不足（大会・チーム・相手・ラウンド）');
      if (!/^https:\/\/(youtu\.be|www\.youtube\.com)\/.*[?&]t=\d+/.test(String(e.youtube || ''))) bad('証拠の URL に時刻が無い');
    });
    if (it.rounds !== rounds) bad('画面に出すラウンド数（' + it.rounds + '）が証拠（' + rounds + '）と違う');
    if (rounds === 1) one++; else if (rounds > 1) many++;

    if (it.side !== 'ATK' && it.side !== 'DEF') bad('攻守が不正');
    byMap[mapId][it.side]++;
    if (!t.observed) bad('実戦の映像から書いたもの（observed）になっていない');
    if (!/^\d+\.\d+$/.test(String(it.patch || ''))) bad('確認したパッチが無い');
    if (!it.name.ja || !it.name.en || !it.note.ja || !it.note.en) bad('名前・説明の ja / en が揃っていない');

    const marks = ((it.phases || [])[0] || {}).marks || [];
    if (!marks.length) bad('配置盤が無い');
    marks.forEach((m) => { if (!on(m.x, m.y)) bad('マークが床の外 [' + m.x + ', ' + m.y + '] ' + m.ref); });

    /* 読めない種類のスキルを手順に書いていないか */
    (t.steps || []).forEach((s) => {
      const kind = agents[s.agent] && agents[s.agent][s.ability];
      if (s.ability && kind && READABLE.indexOf(kind) < 0 && READABLE_OBJECTS.indexOf(s.agent + ':' + s.ability) < 0) bad('映像から読めない種類のスキルが手順にある: ' + s.agent + ':' + s.ability + '（' + kind + '）「' + String(s.action_ja || '').slice(0, 30) + '」');
    });
    /* 説明文。「読めていない」と断っている文は、推測を足したのではなく限界を書いているので通す */
    ['ja', 'en'].forEach((lang) => {
      String(it.note[lang] || '').split(/[。.]/).forEach((sentence) => {
        if (UNREADABLE_WORDS.test(sentence) && !DISCLAIMS.test(sentence)) bad('説明（' + lang + '）に映像から読めないスキルが書かれている:「' + sentence.trim().slice(0, 50) + '」');
      });
    });

    rows.push([mapId, it.side, it.site, rounds, it.patch, marks.length, it.key, it.name.ja].join(' | '));
  });
});

if (table) rows.forEach((r) => console.log(r));
console.log('公開対象 ' + total + ' 件 / 1 ラウンド確認 ' + one + ' / 2 ラウンド以上確認 ' + many);
Object.keys(byMap).forEach((m) => console.log('  ' + m + ': 攻め ' + byMap[m].ATK + ' / 守り ' + byMap[m].DEF));
problems.forEach((p) => console.log('  ! ' + p));
console.log(problems.length ? '問題 ' + problems.length + ' 件' : '問題なし');
process.exit(problems.length ? 1 : 0);

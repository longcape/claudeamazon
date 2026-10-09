/* =========================================================
   知識ベースの量と根拠レベルの内訳を出す
   ---------------------------------------------------------
   何がどれだけ蓄積されていて、そのうち実戦の裏づけ（A）がどれだけあるかを
   一目で見るためのもの。進み具合の報告に使う。

     node tools/knowledge-stats.mjs
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { knowledgePath } from './kb-paths.mjs';

const KNOW = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'knowledge');
const dirOf = (dir) => knowledgePath(dir);
const list = (dir) => fs.existsSync(dirOf(dir))
  ? fs.readdirSync(dirOf(dir)).filter((f) => /^[a-z0-9-]+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(dirOf(dir), f), 'utf8')))
  : [];
const tally = () => ({ A: 0, B: 0, C: 0 });
const add = (t, ev) => { if (ev && t[ev.level] !== undefined) t[ev.level]++; };
const show = (t) => 'A ' + t.A + ' / B ' + t.B + ' / C ' + t.C;

const agents = list('agents');
let tips = 0, mistakes = 0, drills = 0;
agents.forEach((a) => {
  (a.abilities || []).forEach((ab) => { tips += (ab.uses_ja || []).length + (ab.tips_ja || []).length; });
  mistakes += ((a.coaching || {}).common_mistakes_ja || []).length;
  drills += ((a.coaching || {}).drills_ja || []).length;
});
console.log('エージェント ' + agents.length + ' 体: スキルの使いどころ・コツ ' + tips + ' / よくある失敗 ' + mistakes + ' / 練習 ' + drills);

const maps = list('maps');
const pos = tally(), plant = tally(), util = tally();
let np = 0, npl = 0, nu = 0, pool = 0;
maps.forEach((m) => {
  if (m.in_pool) pool++;
  (m.positions || []).forEach((p) => { np++; add(pos, p.evidence); });
  (m.plant_spots || []).forEach((p) => { npl++; add(plant, p.evidence); });
  (m.utility_spots || []).forEach((p) => { nu++; add(util, p.evidence); });
});
console.log('マップ ' + maps.length + '（現行プール ' + pool + '）: ポジション ' + np + '（' + show(pos) + '）/ 設置位置 ' + npl + '（' + show(plant) + '）/ スキルの置き場所 ' + nu + '（' + show(util) + '）');
maps.forEach((m) => {
  const t = tally(); (m.positions || []).forEach((p) => add(t, p.evidence));
  console.log('  ' + m.map + (m.in_pool ? '' : '（プール外）') + ': ポジション ' + (m.positions || []).length + '（' + show(t) + '）');
});

const concepts = list('concepts');
const pr = tally(); let npr = 0, diag = 0;
concepts.forEach((c) => { (c.principles || []).forEach((p) => { npr++; add(pr, p.evidence); }); diag += (c.diagnostics || []).length; });
console.log('基礎理論 ' + concepts.length + ' 項目: 原則 ' + npr + '（' + show(pr) + '）/ 診断（症状→原因→確認→練習）' + diag);

const tactics = list('tactics');
let nt = 0, obs = 0;
tactics.forEach((t) => (t.tactics || []).forEach((x) => { nt++; if (x.observed) obs++; }));
console.log('戦術 ' + nt + ' 件（うち実戦の映像から書いたもの ' + obs + '）');

const meta = list('meta');
console.log('大会データ ' + meta.length + ' 件: ' + meta.map((m) => m.event).join(' / '));
const patches = list('patches');
patches.forEach((p) => console.log('パッチ履歴: 最新 ' + p.latest.patch + '（' + p.latest.date + '）/ 記録 ' + p.patches.length + ' 本'));

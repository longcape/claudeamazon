/* =========================================================
   知識ベース（agents / maps / meta / concepts）の検査
   ---------------------------------------------------------
   形式は knowledge/SCHEMA.md。ここで見るのは「壊れていると後で必ず困るところ」だけ:
   JSON として読めるか、エージェント id・マップ id が実在するか、スキル名が公式データと合うか、
   根拠レベルがあるか、座標が床の上か。

     node tools/validate-knowledge.mjs            # 全部
     node tools/validate-knowledge.mjs agents     # 種類を指定（agents | maps | meta | concepts）
     node tools/validate-knowledge.mjs maps ascent
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { knowledgePath } from './kb-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KNOW = path.join(ROOT, 'knowledge');
const [onlyKind, onlyId] = process.argv.slice(2);

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'js', 'data.js'), 'utf8'), sandbox);
const D = sandbox.window.VCT_DATA;
const AGENTS = D.AGENTS.map((a) => a.id);
const MAPS = D.MAPS.map((m) => m.id);
const SLOTS = ['C', 'Q', 'E', 'X'];
const LEVELS = ['A', 'B', 'C'];

const officialFile = path.join(KNOW, 'agents', '_official.json');
const OFFICIAL = fs.existsSync(officialFile) ? JSON.parse(fs.readFileSync(officialFile, 'utf8')).agents : {};

const problems = [];
const bad = (where, msg) => problems.push(where + ': ' + msg);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const isList = (v, min) => Array.isArray(v) && v.length >= (min || 0);

function floorOf(mapId) {
  const file = knowledgePath('callouts', '_floor', mapId + '.json');
  if (!fs.existsSync(file)) return null;
  const mask = JSON.parse(fs.readFileSync(file, 'utf8'));
  const k = mask.size / 100;
  return (x, y) => {
    const cx = Math.round(x * k), cy = Math.round(y * k);
    return cy >= 0 && cy < mask.size && cx >= 0 && cx < mask.size && mask.rows[cy][cx] === '1';
  };
}

function checkEvidence(where, ev) {
  if (!ev || LEVELS.indexOf(ev.level) < 0) { bad(where, '根拠レベル（evidence.level）が無い'); return; }
  if (!isText(ev.basis_ja)) bad(where, 'evidence.basis_ja が無い');
  if (ev.level === 'A' && !isList(ev.refs, 1)) bad(where, 'A なのに refs（映像・試合ページ）が無い');
}

function files(kind) {
  const dir = path.join(KNOW, kind);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^[a-z0-9-]+\.json$/.test(f) && (!onlyId || f === onlyId + '.json'))
    .map((f) => ({ id: f.replace(/\.json$/, ''), file: path.join(dir, f) }));
}

function load(f) {
  try { return JSON.parse(fs.readFileSync(f.file, 'utf8')); }
  catch (e) { bad(path.relative(ROOT, f.file), 'JSON として読めない — ' + e.message); return null; }
}

const count = {};

/* ---------------- agents ---------------- */
if (!onlyKind || onlyKind === 'agents') {
  const list = files('agents');
  count.agents = list.length;
  list.forEach((f) => {
    const a = load(f); if (!a) return;
    const w = 'agents/' + f.id;
    if (a.id !== f.id || AGENTS.indexOf(a.id) < 0) bad(w, 'id がファイル名と違うか、知らないエージェント');
    ['identity_ja', 'comp_role_ja', 'difficulty_ja'].forEach((k) => { if (!isText(a[k])) bad(w, k + ' が無い'); });
    ['strengths_ja', 'weaknesses_ja'].forEach((k) => { if (!isList(a[k], 2)) bad(w, k + ' が少ない'); });
    const off = OFFICIAL[a.id];
    const seen = {};
    (a.abilities || []).forEach((ab) => {
      seen[ab.slot] = true;
      if (SLOTS.indexOf(ab.slot) < 0) { bad(w, 'スロットが不正: ' + ab.slot); return; }
      const o = off && off.abilities.find((x) => x.slot === ab.slot);
      if (o && ab.name_en !== o.name_en) bad(w, ab.slot + ' の名前が公式と違う（' + ab.name_en + ' / 公式 ' + o.name_en + '）');
      if (!isText(ab.kind) || !isText(ab.what_ja) || !isList(ab.uses_ja, 1)) bad(w, ab.slot + ' の kind / what_ja / uses_ja が足りない');
    });
    SLOTS.forEach((s) => { if (!seen[s]) bad(w, 'スキル ' + s + ' が無い'); });
    ['synergy', 'strong_against', 'weak_against'].forEach((k) => {
      (a[k] || []).forEach((x) => {
        const id = x.with || x.what;
        if (k === 'synergy' && AGENTS.indexOf(id) < 0) bad(w, k + ' に知らないエージェント: ' + id);
      });
    });
    (a.maps || []).forEach((m) => { if (MAPS.indexOf(m.map) < 0) bad(w, '知らないマップ: ' + m.map); });
    if (!a.coaching || !isList(a.coaching.checklist_ja, 2) || !isList(a.coaching.common_mistakes_ja, 2)) bad(w, 'coaching が足りない');
    checkEvidence(w, a.evidence);
  });
}

/* ---------------- maps ---------------- */
if (!onlyKind || onlyKind === 'maps') {
  const list = files('maps');
  count.maps = list.length;
  list.forEach((f) => {
    const m = load(f); if (!m) return;
    const w = 'maps/' + f.id;
    if (m.map !== f.id || MAPS.indexOf(m.map) < 0) { bad(w, 'map がファイル名と違うか、知らないマップ'); return; }
    const sites = D.mapById(m.map).sites;
    const on = floorOf(m.map);
    const xyOk = (where, xy) => {
      if (!Array.isArray(xy) || xy.length !== 2 || !xy.every((n) => Number.isFinite(Number(n)) && n >= 0 && n <= 100)) { bad(where, 'xy が不正'); return; }
      if (on && !on(xy[0], xy[1])) bad(where, 'xy [' + xy.join(', ') + '] が床の外（壁の中かマップの外）');
    };
    if (!isText(m.layout_ja)) bad(w, 'layout_ja が無い');
    const ids = {};
    (m.positions || []).forEach((p) => {
      const pw = w + '/' + p.id;
      if (!p.id || ids[p.id]) bad(pw, 'id が無いか重複');
      ids[p.id] = true;
      if (p.side !== 'ATK' && p.side !== 'DEF') bad(pw, 'side が不正');
      if (p.site !== 'MID' && sites.indexOf(p.site) < 0) bad(pw, 'site が不正: ' + p.site);
      if (!p.name || !isText(p.name.ja) || !isText(p.purpose_ja)) bad(pw, 'name.ja / purpose_ja が無い');
      xyOk(pw, p.xy);
      (p.agents_fit || []).forEach((a) => { if (AGENTS.indexOf(a) < 0) bad(pw, '知らないエージェント: ' + a); });
      checkEvidence(pw, p.evidence);
    });
    if (!isList(m.positions, 8)) bad(w, 'positions が少ない（' + (m.positions || []).length + '）');
    (m.plant_spots || []).forEach((p, i) => { xyOk(w + '/plant_spots[' + i + ']', p.xy); checkEvidence(w + '/plant_spots[' + i + ']', p.evidence); });
    (m.utility_spots || []).forEach((p, i) => { xyOk(w + '/utility_spots[' + i + ']', p.xy); checkEvidence(w + '/utility_spots[' + i + ']', p.evidence); });
    (m.key_areas || []).forEach((p, i) => checkEvidence(w + '/key_areas[' + i + ']', p.evidence));
    (m.agents_fit || []).forEach((a) => { if (AGENTS.indexOf(a.agent) < 0) bad(w, 'agents_fit に知らないエージェント: ' + a.agent); });
  });
}

/* ---------------- meta ---------------- */
if (!onlyKind || onlyKind === 'meta') {
  const list = files('meta');
  count.meta = list.length;
  list.forEach((f) => {
    const m = load(f); if (!m) return;
    const w = 'meta/' + f.id;
    if (!isText(m.event) || !isText(m.source) || !isText(m.as_of)) bad(w, 'event / source / as_of が無い');
    Object.keys(m.maps || {}).forEach((id) => {
      if (MAPS.indexOf(id) < 0) bad(w, '知らないマップ: ' + id);
      (m.maps[id].agents || []).forEach((a) => { if (AGENTS.indexOf(a.agent) < 0) bad(w, id + ' に知らないエージェント: ' + a.agent); });
      (m.maps[id].comps || []).forEach((c) => {
        if (!Array.isArray(c.agents) || c.agents.length !== 5 || c.agents.some((a) => AGENTS.indexOf(a) < 0)) bad(w, id + ' の構成が 5 人でないか、知らないエージェントがいる');
      });
    });
  });
}

/* ---------------- concepts ---------------- */
if (!onlyKind || onlyKind === 'concepts') {
  const list = files('concepts');
  count.concepts = list.length;
  list.forEach((f) => {
    const c = load(f); if (!c) return;
    const w = 'concepts/' + f.id;
    if (c.id !== f.id) bad(w, 'id がファイル名と違う');
    if (!c.title || !isText(c.title.ja) || !isText(c.summary_ja)) bad(w, 'title.ja / summary_ja が無い');
    if (!isList(c.principles, 3)) bad(w, 'principles が少ない');
    (c.principles || []).forEach((p) => {
      if (!isText(p.rule_ja) || !isText(p.why_ja)) bad(w + '/' + p.id, 'rule_ja / why_ja が無い');
      checkEvidence(w + '/' + p.id, p.evidence);
    });
    const links = c.links || {};
    (links.agents || []).forEach((a) => { if (AGENTS.indexOf(a) < 0) bad(w, 'links に知らないエージェント: ' + a); });
    (links.maps || []).forEach((m) => { if (MAPS.indexOf(m) < 0) bad(w, 'links に知らないマップ: ' + m); });
  });
}

/* ---------------- playbooks ---------------- */
if (!onlyKind || onlyKind === 'playbooks') {
  const list = files('playbooks');
  count.playbooks = list.length;
  list.forEach((f) => {
    const p = load(f); if (!p) return;
    const w = 'playbooks/' + f.id;
    if (p.map !== f.id || MAPS.indexOf(p.map) < 0) { bad(w, 'map がファイル名と違うか、知らないマップ'); return; }
    const sites = D.mapById(p.map).sites;
    const on = floorOf(p.map);
    const pt = (where, xy) => {
      if (!Array.isArray(xy) || xy.length !== 2 || !xy.every((n) => Number.isFinite(Number(n)) && n >= 0 && n <= 100)) { bad(where, 'xy が不正'); return; }
      if (on && !on(xy[0], xy[1])) bad(where, 'xy [' + xy.join(', ') + '] が床の外');
    };
    const ids = {};
    if (!isList(p.agents, 4)) bad(w, 'agents が少ない');
    (p.agents || []).forEach((a) => {
      const aw = w + '/' + a.agent;
      if (AGENTS.indexOf(a.agent) < 0) { bad(aw, '知らないエージェント'); return; }
      if (!isText(a.job_ja) || !isList(a.attack_ja, 1) || !isList(a.defense_ja, 1)) bad(aw, 'job_ja / attack_ja / defense_ja が足りない');
      checkEvidence(aw, a.evidence);
      const off = OFFICIAL[a.agent];
      (a.setups || []).forEach((su) => {
        const sw = aw + '/' + su.id;
        if (!su.id || ids[su.id]) bad(sw, 'id が無いか重複');
        ids[su.id] = true;
        if (su.side !== 'ATK' && su.side !== 'DEF') bad(sw, 'side が不正');
        if (su.site !== 'MID' && sites.indexOf(su.site) < 0) bad(sw, 'site が不正: ' + su.site);
        if (su.slot && SLOTS.indexOf(su.slot) < 0) bad(sw, 'slot が不正');
        if (su.slot && off && !off.abilities.some((x) => x.slot === su.slot)) bad(sw, '公式データに無いスロット');
        if (!su.name || !isText(su.name.ja) || !isText(su.purpose_ja)) bad(sw, 'name.ja / purpose_ja が無い');
        if (su.from_xy) pt(sw + ' from', su.from_xy);
        if (su.at_xy) (Array.isArray(su.at_xy[0]) ? su.at_xy : [su.at_xy]).forEach((xy) => pt(sw + ' at', xy));
        checkEvidence(sw, su.evidence);
      });
      (a.pairs || []).forEach((x) => { if (AGENTS.indexOf(x.with) < 0) bad(aw, 'pairs に知らないエージェント: ' + x.with); });
    });
    (p.comps || []).forEach((c, i) => {
      if (!Array.isArray(c.agents) || c.agents.length !== 5 || c.agents.some((a) => AGENTS.indexOf(a) < 0)) bad(w + '/comps[' + i + ']', '5 人でないか、知らないエージェントがいる');
      checkEvidence(w + '/comps[' + i + ']', c.evidence);
    });
  });
}

console.log(Object.keys(count).map((k) => k + ' ' + count[k]).join(' / '));
problems.slice(0, 80).forEach((p) => console.log('  ! ' + p));
if (problems.length > 80) console.log('  … ほか ' + (problems.length - 80) + ' 件');
console.log(problems.length ? '問題 ' + problems.length + ' 件' : '問題なし');
process.exit(problems.length ? 1 : 0);

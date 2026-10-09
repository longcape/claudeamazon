/* =========================================================
   共通知識基盤（正本）と knowledge/（写し）のずれを確かめ、そろえる
   ---------------------------------------------------------
   更新の向きは 正本 → 写し → 生成物 の一方向。写しは古い道具や人が読むための
   互換コピーで、ここが正本より進むことは本来ない。

     node tools/kb-mirror.mjs              # 確かめるだけ。ずれがあれば終了コード 1
     node tools/kb-mirror.mjs --to-legacy  # 正本 → 写し（ふだん使うのはこれ）
     node tools/kb-mirror.mjs --import     # 写しにだけ入った変更を正本へ取り込む（非常用）

   どちらが進んだかは、前回そろえたときの hash（import_manifest.json）と比べて決める。
   両方が変わっていたら機械的には決められないので、何もせずに止める。
   取り込み（--import）は、写し側で欄や配列が減っていないときだけ通し、正本の旧版を .bak で残す。
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { KB_GAME, MAPPING, knowledgePath, legacyPath } from './kb-paths.mjs';

const toLegacy = process.argv.includes('--to-legacy');
const doImport = process.argv.includes('--import');
const today = new Date().toISOString().slice(0, 10);
const MANIFEST = path.join(KB_GAME, '99_Sources', 'VTC', 'import_manifest.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').toUpperCase();
const entryFor = (canonical) => manifest.files.find((e) => path.resolve(e.canonical) === path.resolve(canonical));

/* そろえる対象。README や .bak は知識ではないので含めない */
function walk(dir, rel) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const r = rel ? rel + '/' + d.name : d.name;
    if (d.isDirectory()) return walk(path.join(dir, d.name), r);
    return /\.json$/.test(d.name) ? [r] : [];
  });
}
const pairs = [];
Object.keys(MAPPING).forEach((cat) => {
  const kb = knowledgePath(cat), lg = legacyPath(cat);
  if (/\.json$/.test(cat)) { pairs.push({ name: cat, kb: kb, lg: lg }); return; }
  const names = new Set([...walk(kb, ''), ...walk(lg, '')]);
  names.forEach((r) => pairs.push({ name: cat + '/' + r, kb: path.join(kb, r), lg: path.join(lg, r) }));
});

let same = 0, fixed = 0, open = 0, dirty = false;
const say = (msg) => console.log('  ' + msg);

pairs.forEach((p) => {
  const hasKb = fs.existsSync(p.kb), hasLg = fs.existsSync(p.lg);
  let entry = entryFor(p.kb);

  if (hasKb && !hasLg) {
    if (toLegacy) { fs.mkdirSync(path.dirname(p.lg), { recursive: true }); fs.copyFileSync(p.kb, p.lg); fixed++; say('写しへ追加: ' + p.name); }
    else { open++; say('写しに無い: ' + p.name + '（--to-legacy で追加）'); }
    return;
  }
  if (!hasKb && hasLg) {
    if (doImport) { fs.mkdirSync(path.dirname(p.kb), { recursive: true }); fs.copyFileSync(p.lg, p.kb); fixed++; say('正本へ追加: ' + p.name); hasNew(p); }
    else { open++; say('写しにだけある: ' + p.name + '（正本へ入れるなら --import）'); }
    return;
  }

  const k = sha(p.kb), l = sha(p.lg);
  if (!entry) { entry = { source: p.lg, canonical: p.kb, sha256: k, imported_date: today, independent_verification: false }; manifest.files.push(entry); dirty = true; }
  if (k === l) {
    if (String(entry.sha256).toUpperCase() !== k) { entry.sha256 = k; entry.imported_date = today; dirty = true; }
    same++; return;
  }

  const last = String(entry.sha256).toUpperCase();
  if (l === last) {                     /* 正本だけが進んでいる（本来の向き） */
    if (toLegacy) { fs.copyFileSync(p.kb, p.lg); entry.sha256 = k; entry.imported_date = today; dirty = true; fixed++; say('正本 → 写し: ' + p.name); }
    else { open++; say('正本が進んでいる: ' + p.name + '（--to-legacy でそろえる）'); }
    return;
  }
  if (k === last) {                     /* 写しだけが変わっている（誰かが写しを直した） */
    if (!doImport) { open++; say('写しが直接書き換えられている: ' + p.name + '（正本へ入れるなら --import）'); return; }
    const a = JSON.parse(fs.readFileSync(p.kb, 'utf8')), b = JSON.parse(fs.readFileSync(p.lg, 'utf8'));
    const lost = Object.keys(a).filter((key) => !(key in b));
    const shrunk = Object.keys(a).filter((key) => Array.isArray(a[key]) && Array.isArray(b[key]) && b[key].length < a[key].length);
    if (lost.length || shrunk.length) { open++; say('取り込めない（写し側で減っている: ' + lost.concat(shrunk).join(', ') + '）: ' + p.name); return; }
    const bak = p.kb.replace(/\.json$/, '') + '.before-' + today + '.bak';
    if (!fs.existsSync(bak)) fs.copyFileSync(p.kb, bak);
    fs.copyFileSync(p.lg, p.kb);
    entry.history = (entry.history || []).concat([{ sha256: entry.sha256, imported_date: entry.imported_date }]);
    entry.sha256 = l; entry.imported_date = today; entry.sync_note = '写し側の変更を取り込んだ（欄・配列の減少なし）';
    dirty = true; fixed++; say('写し → 正本（取り込み）: ' + p.name);
    return;
  }
  open++; say('両方が変わっている。機械的には決められない: ' + p.name);
});

function hasNew(p) {
  manifest.files.push({ source: p.lg, canonical: p.kb, sha256: sha(p.kb), imported_date: today, independent_verification: false, sync_note: '写しから新しく取り込んだ' });
  dirty = true;
}

if (dirty) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
console.log('一致 ' + same + ' / そろえた ' + fixed + ' / 未解決 ' + open + '（対象 ' + pairs.length + ' ファイル）');
process.exit(open ? 1 : 0);

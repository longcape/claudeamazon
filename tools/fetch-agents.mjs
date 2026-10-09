/* =========================================================
   エージェントの公式データを取り込む
   ---------------------------------------------------------
   スキルの名前と説明を手で書くと、必ず古くなるか取り違える。
   valorant-api.com から日本語と英語で取り、知識データの土台にする。

     node tools/fetch-agents.mjs

   出力: knowledge/agents/_official.json
   スロットの対応は fetch-assets.mjs と同じ（Ability1 = Q、Ability2 = E、Grenade = C、Ultimate = X）。
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'knowledge', 'agents');
const SLOT = { Ability1: 'Q', Ability2: 'E', Grenade: 'C', Ultimate: 'X', Passive: 'P' };

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'js', 'data.js'), 'utf8'), sandbox);
const D = sandbox.window.VCT_DATA;

async function get(lang) {
  const res = await fetch('https://valorant-api.com/v1/agents?isPlayableCharacter=true&language=' + lang);
  if (!res.ok) throw new Error('valorant-api.com: HTTP ' + res.status);
  return (await res.json()).data;
}

const [en, ja] = await Promise.all([get('en-US'), get('ja-JP')]);
const norm = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); };
const out = {};
const missing = [];

D.AGENTS.forEach(function (a) {
  const e = en.find(function (x) { return norm(x.displayName) === norm(a.name) || norm(x.displayName) === a.id; });
  if (!e) { missing.push(a.id); return; }
  const j = ja.find(function (x) { return x.uuid === e.uuid; }) || e;
  out[a.id] = {
    id: a.id,
    name_en: e.displayName,
    name_ja: j.displayName,
    role: a.role,
    description_en: e.description,
    description_ja: j.description,
    abilities: e.abilities.map(function (ab) {
      const jb = j.abilities.find(function (x) { return x.slot === ab.slot; }) || ab;
      return {
        slot: SLOT[ab.slot] || ab.slot,
        name_en: ab.displayName, name_ja: jb.displayName,
        description_en: ab.description, description_ja: jb.description
      };
    }).sort(function (x, y) { return 'CQEXP'.indexOf(x.slot) - 'CQEXP'.indexOf(y.slot); })
  };
});

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, '_official.json'),
  JSON.stringify({ source: 'valorant-api.com/v1/agents', fetched_at: new Date().toISOString().slice(0, 10), agents: out }, null, 2) + '\n');
console.log('agents: ' + Object.keys(out).length + (missing.length ? ' / 取得できず: ' + missing.join(', ') : ''));

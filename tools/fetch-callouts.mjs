/* =========================================================
   場所の名前（コールアウト）→ 配置盤の座標 の対応表を作る
   ---------------------------------------------------------
   valorant-api.com はマップごとにコールアウトの位置（ゲーム内座標）と、
   それをミニマップ上の 0-1 へ直す係数を配っている。目分量で座標を
   拾うと必ずズレるので、ここから機械的に求める。

   配置盤はミニマップを ROTATION で回して表示しているため、
   同じ回転をここでも掛けて「画面に見えている向き」の 0-100 に揃える。

     node tools/fetch-callouts.mjs            # 全マップ
     node tools/fetch-callouts.mjs ascent     # 指定したマップだけ

   出力: 共通知識基盤の callouts/<map>.json（置き場所は tools/kb-paths.mjs）
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { knowledgePath } from './kb-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = knowledgePath('callouts');

/* 回転角とマップ一覧はアプリ本体を正本にする（二重に持つと必ずずれる） */
function loadGlobals() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  ['data.js', 'maps-layout.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'js', f), 'utf8'), sandbox);
  });
  return { D: sandbox.window.VCT_DATA, M: sandbox.window.VCT_MAPS };
}

function rotate(x, y, deg) {
  const r = deg * Math.PI / 180;
  const dx = x - 50, dy = y - 50;
  return {
    x: 50 + dx * Math.cos(r) - dy * Math.sin(r),
    y: 50 + dx * Math.sin(r) + dy * Math.cos(r)
  };
}

const round1 = function (n) { return Math.round(n * 10) / 10; };

const { D, M } = loadGlobals();
const only = process.argv.slice(2);

const res = await fetch('https://valorant-api.com/v1/maps');
if (!res.ok) throw new Error('valorant-api.com: HTTP ' + res.status);
const maps = (await res.json()).data;

fs.mkdirSync(OUT, { recursive: true });

D.MAPS.forEach(function (m) {
  if (only.length && only.indexOf(m.id) < 0) return;
  const src = maps.find(function (x) {
    return String(x.displayName).toLowerCase() === m.id && Array.isArray(x.callouts) && x.callouts.length;
  });
  if (!src) { console.warn('skip (コールアウトなし): ' + m.id); return; }

  const spin = M.rotation(m.id);
  const callouts = src.callouts.map(function (c) {
    /* ゲーム内座標は x と y が入れ替わってミニマップに載る */
    const u = (c.location.y * src.xMultiplier + src.xScalarToAdd) * 100;
    const v = (c.location.x * src.yMultiplier + src.yScalarToAdd) * 100;
    const p = rotate(u, v, spin);
    return {
      name: (c.superRegionName + ' ' + c.regionName).trim(),   // 例: "A Main"
      region: c.regionName,
      area: c.superRegionName,
      x: round1(p.x),
      y: round1(p.y)
    };
  });

  fs.writeFileSync(path.join(OUT, m.id + '.json'),
    JSON.stringify({ map: m.id, rotation: spin, source: 'valorant-api.com/v1/maps', callouts: callouts }, null, 2) + '\n');
  console.log(m.id + ': ' + callouts.length);
});

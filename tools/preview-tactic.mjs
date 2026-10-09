/* =========================================================
   戦術 1 件の配置盤を画像にして確かめる
   ---------------------------------------------------------
   取り込んだときに盤面へ出るマーク（人・スキル・設置位置・経路）を、
   配置盤と同じ向きのミニマップに重ねて書き出す。壁の中やマップの外に
   置いていないか、実戦で見えた位置と合っているかを目で見るためのもの。

     node tools/build-library.mjs --out <tmp.js>
     node tools/preview-tactic.mjs <tmp.js> <map> <key> <out.png>

   <key> を all にすると、そのマップの全戦術のマークを 1 枚に重ねる
   （壁の中に落ちている点をまとめて探すとき）。
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [libFile, mapId, key, out] = process.argv.slice(2);
if (!libFile || !mapId || !key || !out) {
  console.error('usage: node tools/preview-tactic.mjs <library.js> <map> <key|all> <out.png>');
  process.exit(1);
}

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.resolve(libFile), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'js', 'maps-layout.js'), 'utf8'), sandbox);
const list = (sandbox.window.VCT_LIBRARY.maps[mapId] || []).filter(function (t) { return key === 'all' || t.key === key; });
if (!list.length) { console.error('見つからない: ' + mapId + ' / ' + key); process.exit(1); }

const spin = sandbox.window.VCT_MAPS.rotation(mapId);
const img = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'assets', 'img', 'maps', mapId + '.png')).toString('base64');
const COLOR = { agent: '#35d0ff', ability: '#ffb020', plant: '#ff4655' };

let svg = '';
list.forEach(function (t) {
  (t.phases || []).forEach(function (ph) {
    (ph.routes || []).forEach(function (r) {
      svg += '<polyline points="' + r.points.map(function (p) { return p.x + ',' + p.y; }).join(' ') +
             '" fill="none" stroke="#35d0ff" stroke-width="0.5" stroke-dasharray="1.2 0.8"/>';
    });
    ph.marks.forEach(function (m) {
      const label = key === 'all' ? '' : (m.kind === 'plant' ? 'PLANT' : m.ref + (m.order ? ' #' + m.order : ''));
      svg += '<circle cx="' + m.x + '" cy="' + m.y + '" r="' + (key === 'all' ? 0.6 : 1.1) + '" fill="' + COLOR[m.kind] + '" stroke="#000" stroke-width="0.2"/>';
      if (label) {
        svg += '<text x="' + m.x + '" y="' + (m.y - 1.6) + '" font-size="1.9" fill="#fff" stroke="#000" stroke-width="0.45" paint-order="stroke" text-anchor="middle" font-family="sans-serif">' + label + '</text>';
      }
    });
  });
});

const title = key === 'all' ? mapId + ' (all marks)' : list[0].name.ja;
const html = '<body style="margin:0;background:#10151c"><svg viewBox="0 0 100 100" width="1000" height="1000">' +
  '<image href="' + img + '" x="0" y="0" width="100" height="100" transform="rotate(' + spin + ' 50 50)"/>' + svg +
  '<text x="2" y="4" font-size="2.4" fill="#fff" font-family="sans-serif">' + title.replace(/[<&]/g, '') + '</text></svg></body>';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
await page.setContent(html);
await page.screenshot({ path: out });
await browser.close();
console.log(out);

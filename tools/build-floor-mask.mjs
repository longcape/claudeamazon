/* =========================================================
   歩ける床の範囲（フロアマスク）を作る
   ---------------------------------------------------------
   配置盤のマークは、場所の名前の座標や重なり避けのずらしで、
   壁の中やマップの外に落ちることがある。ミニマップ画像の
   「塗られている所 = 床」を 200×200 の升目に落としておき、
   build-library.mjs が床の外に出たマークを最寄りの床へ寄せる。

   画像は配置盤と同じ回転を掛けてから読むので、升目は
   「画面に見えている向き」の 0-100 と一致する。

     node tools/build-floor-mask.mjs          # 全マップ

   出力: 共通知識基盤の callouts/_floor/<map>.json  { size, rows: ["0101…", …] }
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { knowledgePath } from './kb-paths.mjs';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = knowledgePath('callouts', '_floor');
const SIZE = 200;

const sandbox = { window: {} };
vm.createContext(sandbox);
['data.js', 'maps-layout.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'js', f), 'utf8'), sandbox);
});
const D = sandbox.window.VCT_DATA, M = sandbox.window.VCT_MAPS;

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();

for (const m of D.MAPS) {
  const file = path.join(ROOT, 'assets', 'img', 'maps', m.id + '.png');
  if (!fs.existsSync(file)) { console.warn('skip: ' + m.id); continue; }
  const src = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
  const rows = await page.evaluate(async function (a) {
    const img = new Image();
    await new Promise(function (res, rej) { img.onload = res; img.onerror = rej; img.src = a.src; });
    const c = document.createElement('canvas');
    c.width = a.size; c.height = a.size;
    const g = c.getContext('2d');
    g.translate(a.size / 2, a.size / 2);
    g.rotate(a.spin * Math.PI / 180);
    g.drawImage(img, -a.size / 2, -a.size / 2, a.size, a.size);
    const px = g.getImageData(0, 0, a.size, a.size).data;
    const out = [];
    for (let y = 0; y < a.size; y++) {
      let row = '';
      for (let x = 0; x < a.size; x++) row += px[(y * a.size + x) * 4 + 3] > 110 ? '1' : '0';
      out.push(row);
    }
    return out;
  }, { src: src, size: SIZE, spin: M.rotation(m.id) });

  const filled = rows.join('').split('1').length - 1;
  fs.writeFileSync(path.join(OUT, m.id + '.json'), JSON.stringify({ size: SIZE, rows: rows }) + '\n');
  console.log(m.id + ': 床 ' + Math.round(filled / (SIZE * SIZE) * 100) + '%');
}
await browser.close();

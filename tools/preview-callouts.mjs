/* =========================================================
   コールアウトの座標が盤面の見た目と合っているかを目で確かめる
   ---------------------------------------------------------
   配置盤と同じ回転でミニマップを描き、その上に名前と点を重ねた
   画像を書き出す。座標の向き（回転・x/y の入れ替え）を取り違えると
   全部の戦術がずれるので、対応表を作り直したら必ず見る。

     node tools/preview-callouts.mjs ascent out.png
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { knowledgePath } from './kb-paths.mjs';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapId = process.argv[2];
const out = process.argv[3];
if (!mapId || !out) { console.error('usage: node tools/preview-callouts.mjs <map> <out.png>'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(knowledgePath('callouts', mapId + '.json'), 'utf8'));
const img = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'assets', 'img', 'maps', mapId + '.png')).toString('base64');

const dots = data.callouts.map(function (c) {
  return '<circle cx="' + c.x + '" cy="' + c.y + '" r="0.7" fill="#ff4655"/>' +
         '<text x="' + c.x + '" y="' + (c.y - 1.2) + '" font-size="2.1" fill="#fff" stroke="#000" stroke-width="0.5" paint-order="stroke" text-anchor="middle" font-family="sans-serif">' + c.name + '</text>';
}).join('');

const html = '<body style="margin:0;background:#10151c"><svg viewBox="0 0 100 100" width="1000" height="1000">' +
  '<image href="' + img + '" x="0" y="0" width="100" height="100" transform="rotate(' + data.rotation + ' 50 50)"/>' + dots + '</svg></body>';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
await page.setContent(html);
await page.screenshot({ path: out });
await browser.close();
console.log(out);

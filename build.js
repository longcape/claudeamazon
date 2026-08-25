#!/usr/bin/env node
/* =========================================================
   BUILD — 単一 HTML へのバンドル
   index.html + assets/**  を 1 枚の HTML に束ねる。
   生成物:
     dist/valorant-tactical-setup-card.html  スタンドアロン（配布・オフライン用）
     dist/artifact-body.html                 公開ページ用（外側の html/head/body なし）
   ========================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const FONT_URL = 'https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;700&display=swap';

const read = function (p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); };

const html = read('index.html');
const css = read('assets/css/style.css');

/* index.html に書かれている順どおりに JS を拾う。
   ここを固定リストにすると、ファイルを増やしたときに取りこぼす。 */
const scriptTag = /<script src="([^"]+)"><\/script>/g;
const scriptPaths = [];
let m;
while ((m = scriptTag.exec(html)) !== null) scriptPaths.push(m[1]);
if (scriptPaths.length === 0) throw new Error('index.html に <script src> が見つかりません');

const scripts = scriptPaths.map(function (rel) {
  return { name: rel, code: read(rel) };
});

/* インライン化した中身がタグを閉じてしまわないか確認する */
function assertSafe(label, code, needle) {
  if (code.toLowerCase().indexOf(needle) >= 0) {
    throw new Error(label + ' に ' + needle + ' が含まれているためインライン化できません');
  }
}
assertSafe('style.css', css, '</style');
scripts.forEach(function (s) { assertSafe(s.name, s.code, '</script'); });

const styleBlock =
  '<style>\n' +
  "@import url('" + FONT_URL + "');\n\n" +
  css +
  '</style>';

const scriptBlock = scripts.map(function (s) {
  return '<script>\n/* ---- ' + s.name + ' ---- */\n' + s.code + '<\/script>';
}).join('\n');

/* --- body の中身を組み立てる --- */
const bodyInner = html
  .slice(html.indexOf('<body>') + '<body>'.length, html.lastIndexOf('</body>'))
  .replace(/\s*<script src="[^"]+"><\/script>/g, '')
  .trim();

const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [, 'VALORANT TACTICAL SETUP CARD'])[1];
const description = (html.match(/<meta name="description" content="([^"]*)"/) || [, ''])[1];

/* --- 1. スタンドアロン --- */
const standalone =
  '<!DOCTYPE html>\n' +
  '<html lang="ja">\n' +
  '<head>\n' +
  '<meta charset="utf-8" />\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
  '<title>' + title + '</title>\n' +
  '<meta name="description" content="' + description + '" />\n' +
  styleBlock + '\n' +
  '</head>\n' +
  '<body>\n' +
  bodyInner + '\n\n' +
  scriptBlock + '\n' +
  '</body>\n' +
  '</html>\n';

/* --- 2. 公開ページ用（html/head/body は発行時に付与される） --- */
const artifactBody =
  '<title>' + title + '</title>\n' +
  styleBlock + '\n' +
  bodyInner + '\n\n' +
  scriptBlock + '\n';

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'valorant-tactical-setup-card.html'), standalone);
fs.writeFileSync(path.join(DIST, 'artifact-body.html'), artifactBody);

const kb = function (s) { return (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB'; };
console.log('dist/valorant-tactical-setup-card.html  ' + kb(standalone));
console.log('dist/artifact-body.html                 ' + kb(artifactBody));

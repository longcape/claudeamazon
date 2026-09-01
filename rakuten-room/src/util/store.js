/* =========================================================
   STORE — data/ 配下へのJSON永続化
   外部DBを持たない。スナップショット・計画・実績はすべて
   リポジトリ内のJSONファイルとして残す（差分が読める）。
   ========================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
/* テストや複数アカウント運用のために、保存先を差し替えられるようにしておく */
const DATA_DIR = process.env.ROOM_DATA_DIR
  ? path.resolve(process.env.ROOM_DATA_DIR)
  : path.join(ROOT, 'data');
const OUT_DIR = process.env.ROOM_OUT_DIR
  ? path.resolve(process.env.ROOM_OUT_DIR)
  : path.join(ROOT, 'out');
/* 設定ディレクトリも差し替え可能にする。
   trend の観測結果は config/trend-words.json へ書き戻されるため、
   ここが固定だとテスト実行が実運用の設定ファイルを汚す。 */
const CONFIG_DIR = process.env.ROOM_CONFIG_DIR
  ? path.resolve(process.env.ROOM_CONFIG_DIR)
  : path.join(ROOT, 'config');

function configPath(name) {
  return path.join(CONFIG_DIR, name);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  const full = path.isAbsolute(file) ? file : path.join(DATA_DIR, file);
  if (!fs.existsSync(full)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    throw new Error(file + ' が壊れています: ' + e.message);
  }
}

function writeJson(file, value) {
  const full = path.isAbsolute(file) ? file : path.join(DATA_DIR, file);
  ensureDir(path.dirname(full));
  fs.writeFileSync(full, JSON.stringify(value, null, 2) + '\n', 'utf8');
  return full;
}

function writeText(file, text) {
  const full = path.isAbsolute(file) ? file : path.join(OUT_DIR, file);
  ensureDir(path.dirname(full));
  fs.writeFileSync(full, text, 'utf8');
  return full;
}

function listData(prefix) {
  ensureDir(DATA_DIR);
  return fs.readdirSync(DATA_DIR)
    .filter(function (f) { return f.startsWith(prefix) && f.endsWith('.json'); })
    .sort();
}

function loadStrategy() {
  return readJson(configPath('strategy.json'), null) ||
    (function () { throw new Error('config/strategy.json が見つかりません'); })();
}

function loadTrendWords() {
  return readJson(configPath('trend-words.json'), { rising: [], decaying: [] });
}

module.exports = { ROOT, DATA_DIR, OUT_DIR, CONFIG_DIR, configPath, readJson, writeJson, writeText, listData, loadStrategy, loadTrendWords, ensureDir };

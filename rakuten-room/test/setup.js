'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');

/* store を require する前に保存先を差し替える */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-test-'));
process.env.ROOM_DATA_DIR = path.join(dir, 'data');
process.env.ROOM_OUT_DIR = path.join(dir, 'out');
process.env.ROOM_QUIET = '1';
fs.mkdirSync(process.env.ROOM_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.ROOM_OUT_DIR, { recursive: true });

/* 設定は複製を使う。trend の観測結果は config/trend-words.json へ
   書き戻されるので、実ファイルを指したままだとテストが運用設定を汚す。 */
const srcConfig = path.join(__dirname, '..', 'config');
const tmpConfig = path.join(dir, 'config');
fs.mkdirSync(tmpConfig, { recursive: true });
fs.readdirSync(srcConfig).forEach(function (f) {
  fs.copyFileSync(path.join(srcConfig, f), path.join(tmpConfig, f));
});
process.env.ROOM_CONFIG_DIR = tmpConfig;

module.exports = { dir: dir };

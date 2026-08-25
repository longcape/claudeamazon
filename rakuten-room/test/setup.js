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

module.exports = { dir: dir };

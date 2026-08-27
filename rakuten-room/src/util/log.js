/* =========================================================
   LOG — CLI出力
   ========================================================= */
'use strict';

const quiet = process.env.ROOM_QUIET === '1';

/* 日本語は1文字が2幅で表示される。JSのlengthは1と数えるので、
   padEnd をそのまま使うと表が揃わない。表示幅で揃える。 */
function pad(str, width) {
  const s = String(str);
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6))) ? 2 : 1;
  }
  return s + ' '.repeat(Math.max(0, width - w));
}

function info(msg) { if (!quiet) process.stdout.write(msg + '\n'); }
function step(msg) { if (!quiet) process.stdout.write('\n● ' + msg + '\n'); }
function detail(msg) { if (!quiet) process.stdout.write('  ' + msg + '\n'); }
function warn(msg) { process.stderr.write('  ! ' + msg + '\n'); }
function fail(msg) { process.stderr.write('\n✕ ' + msg + '\n'); }

module.exports = { info, step, detail, warn, fail, pad };

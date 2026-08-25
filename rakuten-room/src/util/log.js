/* =========================================================
   LOG — CLI出力
   ========================================================= */
'use strict';

const quiet = process.env.ROOM_QUIET === '1';

function info(msg) { if (!quiet) process.stdout.write(msg + '\n'); }
function step(msg) { if (!quiet) process.stdout.write('\n● ' + msg + '\n'); }
function detail(msg) { if (!quiet) process.stdout.write('  ' + msg + '\n'); }
function warn(msg) { process.stderr.write('  ! ' + msg + '\n'); }
function fail(msg) { process.stderr.write('\n✕ ' + msg + '\n'); }

module.exports = { info, step, detail, warn, fail };

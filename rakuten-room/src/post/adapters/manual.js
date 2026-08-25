/* =========================================================
   ADAPTER: manual（既定）
   ---------------------------------------------------------
   投稿時刻が来たものを画面に出し、貼るだけの状態にする。
   out/now-<日時>.txt にも書き出すので、スマホへ送るなり
   クリップボードへ流すなり好きにできる。
   ========================================================= */
'use strict';

const render = require('../render');
const store = require('../../util/store');
const time = require('../../util/time');
const log = require('../../util/log');

const name = 'manual';

async function post(posts) {
  if (!posts.length) {
    log.info('いま投稿すべきものはありません。');
    return { posted: [], skipped: [] };
  }

  const chunks = posts.map(function (p) { return render.renderNotification(p); });
  const text = chunks.join('\n\n' + '-'.repeat(40) + '\n\n');
  const file = store.writeText('now-' + time.dateKey() + '-' + time.timeLabel(new Date()).replace(':', '') + '.txt', text + '\n');

  log.step('投稿タイミング: ' + posts.length + ' 件');
  log.info('');
  log.info(text);
  log.info('');
  log.detail('書き出し: ' + file);
  log.detail('楽天ROOMへ貼り終えたら: node bin/room.js done ' + posts.map(function (p) { return p.order; }).join(','));

  /* 手動アダプタは「提示」までが仕事。投稿済みマークは done コマンドで人が付ける */
  return { posted: [], presented: posts.map(function (p) { return p.order; }), file: file };
}

module.exports = { name: name, post: post };

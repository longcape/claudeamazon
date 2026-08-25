/* =========================================================
   ADAPTER: webhook
   ---------------------------------------------------------
   投稿時刻に Discord / Slack へ本文とリンクを飛ばす。
   スマホの通知から、その場で貼れるようにするための口。
   ROOM_WEBHOOK_URL が要る。
   ========================================================= */
'use strict';

const render = require('../render');
const log = require('../../util/log');

const name = 'webhook';

function payloadFor(url, text) {
  /* Slack は text、Discord は content を見る。両方入れて済ませる */
  return JSON.stringify({ text: text, content: text });
}

async function post(posts) {
  const url = process.env.ROOM_WEBHOOK_URL;
  if (!url) throw new Error('ROOM_WEBHOOK_URL が未設定です');
  if (!posts.length) return { posted: [], presented: [] };

  const sent = [];
  for (const p of posts) {
    const text = render.renderNotification(p);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payloadFor(url, text)
    });
    if (!res.ok) {
      log.warn('通知に失敗 (#' + p.order + '): ' + res.status);
      continue;
    }
    sent.push(p.order);
  }
  log.detail('通知送信: ' + sent.length + '/' + posts.length + ' 件');
  return { posted: [], presented: sent };
}

module.exports = { name: name, post: post };

/* =========================================================
   RAKUTEN API CLIENT
   ---------------------------------------------------------
   楽天ウェブサービスは 1秒1リクエスト が目安の上限。
   ここを守らないとすぐ 429 が返り、収集が途中で死ぬ。
   全リクエストを単一のキューに通し、最小間隔を強制する。
   ========================================================= */
'use strict';

const MIN_INTERVAL_MS = 1100;
const MAX_RETRY = 4;

let lastCallAt = 0;
let chain = Promise.resolve();

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function credentials() {
  const appId = process.env.RAKUTEN_APP_ID;
  if (!appId) {
    throw new Error('RAKUTEN_APP_ID が未設定です。https://webservice.rakuten.co.jp/ でアプリIDを発行し .env に入れてください');
  }
  /* 2026-07-01版から applicationId 単体では通らず、accessKey との併用が必須になった */
  const accessKey = process.env.RAKUTEN_ACCESS_KEY;
  if (!accessKey) {
    throw new Error('RAKUTEN_ACCESS_KEY が未設定です。https://webservice.rakuten.co.jp/app/list の Access Key を .env に入れてください');
  }
  /* 現行ゲートウェイは Origin ヘッダを「アクセス元」として読み、
     アプリ設定の「許可されたウェブサイト」と照合する。
     送らないと REQUEST_CONTEXT_BODY_HTTP_REFERRER_MISSING、
     合わないと HTTP_REFERRER_NOT_ALLOWED で403。Referer ヘッダは見ていない（検証済み） */
  const appUrl = process.env.RAKUTEN_APP_URL;
  if (!appUrl) {
    throw new Error('RAKUTEN_APP_URL が未設定です。アプリ設定の「許可されたウェブサイト」を .env に入れてください');
  }
  return { appId: appId, accessKey: accessKey, appUrl: appUrl, affiliateId: process.env.RAKUTEN_AFFILIATE_ID || '' };
}

/* Origin はスキーム＋ホストまで。パスや末尾スラッシュが付くと照合に落ちる */
function toOrigin(rawUrl) {
  try { return new URL(rawUrl).origin; }
  catch (e) { var s = String(rawUrl); while (s.slice(-1) === '/') { s = s.slice(0, -1); } return s; }
}

function buildUrl(endpoint, params) {
  const cred = credentials();
  const url = new URL(endpoint);
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatVersion', '2');
  url.searchParams.set('applicationId', cred.appId);
  if (cred.affiliateId) url.searchParams.set('affiliateId', cred.affiliateId);
  Object.keys(params || {}).forEach(function (k) {
    const v = params[k];
    if (v === undefined || v === null || v === '') return;
    url.searchParams.set(k, String(v));
  });
  return url;
}

/* 実行本体。キューに直列化された状態で呼ばれる */
async function execute(url, headers) {
  for (let attempt = 0; attempt <= MAX_RETRY; attempt += 1) {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastCallAt));
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();

    let res;
    try {
      res = await fetch(url, { headers: headers });
    } catch (e) {
      if (attempt === MAX_RETRY) throw new Error('楽天APIへの接続に失敗しました: ' + e.message);
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt === MAX_RETRY) throw new Error('楽天APIが ' + res.status + ' を返し続けています');
      await sleep(1500 * Math.pow(2, attempt));
      continue;
    }

    const body = await res.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch (e) {
      throw new Error('楽天APIの応答がJSONではありません (status ' + res.status + ')');
    }

    if (res.status === 400 && json && json.error_description) {
      /* 検索語で0件のときも400で返ることがある。呼び出し側で握れるよう空を返す */
      if (/not found|見つかりません/i.test(json.error_description)) return { Items: [], count: 0 };
      throw new Error('楽天APIエラー: ' + json.error + ' / ' + json.error_description);
    }
    if (!res.ok) {
      throw new Error('楽天APIエラー ' + res.status + ': ' + (json.error_description || body.slice(0, 200)));
    }
    return json;
  }
  throw new Error('楽天APIの呼び出しに失敗しました');
}

/* 直列キュー。並行呼び出しされても間隔は守られる */
function call(endpoint, params) {
  const url = buildUrl(endpoint, params);
  /* accessKey はクエリにも置けるが、URLがログや履歴に残るのでヘッダで送る */
  const cred = credentials();
  const headers = {
    'User-Agent': 'rakuten-room-engine/1.0',
    accessKey: cred.accessKey,
    Origin: toOrigin(cred.appUrl)
  };
  const run = chain.then(function () { return execute(url, headers); });
  /* 失敗しても後続を止めない */
  chain = run.catch(function () {});
  return run;
}

module.exports = { call, credentials, MIN_INTERVAL_MS };

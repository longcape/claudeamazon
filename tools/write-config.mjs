#!/usr/bin/env node
/* =========================================================
   CONFIG の書き込み
   ---------------------------------------------------------
   環境変数の SUPABASE_URL / SUPABASE_ANON_KEY を
   assets/js/config.js へ流し込む。公開用のビルドでだけ使う。

     SUPABASE_URL=... SUPABASE_ANON_KEY=... node tools/write-config.mjs

   なぜ要るか:
   接続情報をコミットしてしまうと、smoke-test の
   「未設定ならクラウド保存は隠れる」が必ず落ちる。あの項目は
   「設定していない人の画面にボタンが出ない」ことを守っているので、
   通すためにテストを緩めたくない。だからリポジトリの config.js は
   空のままにして、公開するときだけここで書き込む。

   anon key はブラウザに露出する前提の公開キー。実際のアクセス制御は
   Supabase 側の RLS が行う。**service role キーはここでは扱わない。**

   環境変数が無いときは何もしない（失敗にしない）。
   接続情報なしでもアプリはオフラインで完全に動くので、
   その場合はコミュニティとクラウド保存が隠れたソロ版として公開される。
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'assets/js/config.js');

const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_ANON_KEY || '').trim();

if (!url || !key) {
  console.log('SUPABASE_URL / SUPABASE_ANON_KEY が空なので config.js はそのままにします。');
  console.log('（コミュニティとクラウド保存が隠れた状態で公開されます）');
  process.exit(0);
}

/* service role キーを間違って渡していないか。RLS を無視できるキーなので
   ブラウザへ出た時点で事故になる。名前と形の両方で弾く。 */
if (/^sb_secret_/.test(key) || /service_role/.test(key)) {
  console.error('service role キーらしき値が渡されました。中断します。');
  console.error('ブラウザに置いてよいのは anon / publishable キーだけです。');
  process.exit(1);
}
try {
  const payload = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString('utf8'));
  if (payload && payload.role === 'service_role') {
    console.error('service role の JWT が渡されました。中断します。');
    process.exit(1);
  }
} catch { /* JWT 形式でなければ判定しない（新形式の publishable キーはこちら） */ }

let src = fs.readFileSync(FILE, 'utf8');
const before = src;

src = src.replace(/SUPABASE_URL:\s*'[^']*'/, `SUPABASE_URL: '${url}'`);
src = src.replace(/SUPABASE_ANON_KEY:\s*'[^']*'/, `SUPABASE_ANON_KEY: '${key}'`);

if (src === before) {
  console.error('config.js の書き換え先が見つかりませんでした。');
  process.exit(1);
}

fs.writeFileSync(FILE, src);
console.log('config.js に接続情報を書き込みました。');
console.log('  URL : ' + url);
console.log('  key : ' + key.slice(0, 12) + '…（公開キー）');

#!/usr/bin/env node
/* =========================================================
   SMOKE TEST — 配布ファイルの動作確認
   ---------------------------------------------------------
   dist/valorant-tactical-setup-card.html を実際にブラウザで
   開いて、壊れやすいところだけを確かめる。

     node build.js && node tools/smoke-test.mjs

   playwright が入っていなければ何もせず終わる（失敗にしない）。
     npm install -D playwright && npx playwright install chromium

   ここに置いてあるのは「過去に実際に壊れたところ」だけ。
   網羅ではなく再発防止が目的なので、事故が起きたら 1 件足すこと。
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist/valorant-tactical-setup-card.html');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('playwright が見つからないので確認を飛ばします。');
  console.log('  npm install -D playwright && npx playwright install chromium');
  process.exit(0);
}

if (!fs.existsSync(DIST)) {
  console.error(`${path.relative(ROOT, DIST)} がありません。先に node build.js を実行してください。`);
  process.exit(1);
}

/* ---------------- 小さなテストランナー ---------------- */
let passed = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${label}`); return; }
  failures.push(label + (detail ? ` — ${detail}` : ''));
  console.log(`  NG   ${label}${detail ? ` — ${detail}` : ''}`);
}

const ALLY = ['jett', 'sova', 'omen', 'killjoy', 'skye'];
const ENEMY = ['raze', 'fade', 'viper', 'cypher', 'breach'];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: 'ja-JP' });
const page = await context.newPage();

/* ページ内の例外は握りつぶさず全部拾う */
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message)));
page.on('console', (m) => {
  /* フォントの読み込み失敗はオフライン確認時に必ず出るので除く */
  if (m.type() === 'error' && !/ERR_|fonts/.test(m.text())) pageErrors.push(m.text());
});
/* 公開ページはサンドボックスの中で動くので、ブラウザが confirm() と prompt() を
   無視する。ネイティブのダイアログを呼んだ時点でその操作は死ぬので、
   受け付けずに失敗として記録する。 */
page.on('dialog', (d) => {
  pageErrors.push('ネイティブダイアログが呼ばれた: ' + d.type() + ' / ' + d.message());
  d.dismiss();
});

/* 自前の確認ダイアログ。決定するなら text を渡す */
async function answerAsk(text) {
  await page.waitForSelector('#modal-ask:not([hidden])', { timeout: 3000 });
  if (text !== undefined) await page.fill('#ask-input', text);
  await page.click('#ask-ok');
  await page.waitForTimeout(300);
}

await page.goto('file://' + DIST);
await page.waitForTimeout(600);

/* ---------------- データ ---------------- */
console.log('\nデータ');
const data = await page.evaluate(() => {
  const D = window.VCT_DATA, AB = window.VCT_ABILITIES, M = window.VCT_MAPS, P = window.VCT_PORTRAITS;
  const noIcon = [];
  let abilities = 0;
  D.AGENTS.forEach((a) => AB.listFor(a.id).forEach((ab) => {
    abilities++;
    if (!ab.icon) noIcon.push(ab.ref);
  }));
  return {
    agents: D.AGENTS.length,
    maps: D.MAPS.length,
    abilities,
    noIcon,
    noPortrait: D.AGENTS.filter((a) => !P.official(a.id)).map((a) => a.id),
    noMinimap: D.MAPS.filter((m) => !M.minimap(m.id)).map((m) => m.id),
    noRotation: D.MAPS.filter((m) => M.ROTATION[m.id] === undefined).map((m) => m.id),
    spike: !!window.VCT_OFFICIAL_SPIKE
  };
});
check(`エージェント ${data.agents} 体`, data.agents >= 29);
check(`マップ ${data.maps} 種`, data.maps >= 13);
check(`スキル ${data.abilities} 個のアイコンが揃っている`, data.noIcon.length === 0, data.noIcon.join(', '));
check('顔アイコンが揃っている', data.noPortrait.length === 0, data.noPortrait.join(', '));
check('ミニマップが揃っている', data.noMinimap.length === 0, data.noMinimap.join(', '));
check('全マップに向きの補正角がある', data.noRotation.length === 0, data.noRotation.join(', '));
check('スパイクの公式アイコンがある', data.spike);

/* ---------------- 戦術デッキ ---------------- */
console.log('\nデッキ');
const deckCards = () => page.locator('#deck-grid .tcard').count();
const total = await deckCards();
check('サンプル戦術が並ぶ', total > 0);

await page.fill('#deck-query', 'ラッシュ');
await page.waitForTimeout(200);
const hits = await deckCards();
check('検索で絞り込める', hits > 0 && hits < total, `${hits} / ${total}`);

await page.fill('#deck-query', 'そんな戦術はない');
await page.waitForTimeout(200);
check('該当なしのときは理由が出る',
  (await deckCards()) === 0 && /\S/.test(await page.locator('#deck-grid').innerText()));

await page.click('#btn-deck-clear');
await page.waitForTimeout(200);
check('検索を消すと元に戻る', (await deckCards()) === total);

for (const mode of ['site', 'kind', 'side']) {
  await page.selectOption('#deck-group', mode);
  await page.waitForTimeout(200);
  const groups = await page.locator('.deck-section').count();
  const shown = await deckCards();
  check(`${mode} 別にまとめられる`, groups > 0 && shown === total, `${groups} 群 / ${shown} 枚`);
}
await page.selectOption('#deck-group', 'none');
await page.waitForTimeout(200);

/* ---------------- 上部メニュー ---------------- */
await page.click('#btn-topmenu');
await page.waitForTimeout(200);
check('書き出し・読み込みがメニューに入っている',
  (await page.locator('#topmenu-pop').isVisible()) &&
  (await page.locator('#topmenu-pop #btn-export').count()) === 1 &&
  (await page.locator('#topmenu-pop #btn-reset-all').count()) === 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('メニューは外を押すと閉じる', await page.locator('#topmenu-pop').isHidden());

/* ---------------- 免責表記 ---------------- */
/* Riot の二次利用条件で明記が求められている。消えていないか見る */
const legal = await page.locator('.app-foot').innerText();
/* 規約が指定している文言そのままかを見る。言い換えると条件を満たさない */
check('Riot 指定の文言が出ている',
  /created under Riot Games\u2019 \u201cLegal Jibber Jabber\u201d policy/.test(legal) &&
  /does not endorse or sponsor this project/.test(legal),
  legal.slice(0, 60));

/* ---------------- クラウド保存 ---------------- */
/* config.js が空のときは丸ごと隠れていること。
   設定済みの挙動は実際の Supabase が要るのでここでは見ない */
check('未設定ならクラウド保存は隠れる', await page.locator('#btn-cloud').isHidden());

/* ---------------- 構成の入力 ---------------- */
/* エージェントセレクトは 30 秒。1 体ごとに開き直していては間に合わない */
console.log('\n構成');
await page.click('#slots-ally .slot[data-index="0"]');
await page.waitForTimeout(250);
for (const a of ALLY) {
  await page.click(`.agent-opt[data-agent="${a}"]`);
  await page.waitForTimeout(160);
}
const allyPicked = await page.evaluate(() => window.VCT_STORE.state.allies.map((s) => s.agent));
check('5 クリックで味方 5 人が埋まる', allyPicked.every(Boolean), JSON.stringify(allyPicked));
check('埋まりきったら閉じる', await page.locator('#modal-agent').isHidden());

await page.click('#slots-enemy .slot[data-index="0"]');
await page.waitForTimeout(250);
for (const a of ENEMY) {
  await page.click(`.agent-opt[data-agent="${a}"]`);
  await page.waitForTimeout(160);
}

/* 構成のプリセット。名前は自前のダイアログで聞く */
await page.click('[data-comp-save="ally"]');
await answerAsk('テスト構成');
check('構成を保存できる', (await page.locator('#comp-bar-ally .comp-chip').count()) === 1);

await page.click('#comp-bar-enemy .comp-chip');
await page.waitForTimeout(400);
const applied = await page.evaluate(() => window.VCT_STORE.state.enemies.map((s) => s.agent));
check('保存した構成を流し込める', JSON.stringify(applied) === JSON.stringify(ALLY),
  JSON.stringify(applied));

/* 敵構成は戻しておく（この後の相性判定が味方と同じ構成では意味が薄い） */
await page.evaluate((list) => {
  list.forEach((a, i) => { window.VCT_STORE.state.enemies[i].agent = a; });
  window.VCT_STORE.save();
}, ENEMY);
await page.reload();
await page.waitForTimeout(600);

/* ---------------- 分岐ツリー ---------------- */
console.log('\n分岐ツリー');
await page.click('#btn-tree');
await page.waitForTimeout(400);
check('分岐ツリーが開く', await page.locator('#modal-tree').isVisible());
const treeNodes = await page.locator('.tree-node').count();
check('戦術のぶんだけノードが並ぶ', treeNodes === total, `${treeNodes} / ${total}`);

const ids = await page.evaluate(() => window.VCT_STORE.state.tactics.slice(0, 3).map((t) => t.id));
await page.selectOption(`select[data-tree-node="${ids[0]}"][data-tree-result="win"]`, ids[1]);
await page.waitForTimeout(250);
await page.selectOption(`select[data-tree-node="${ids[0]}"][data-tree-result="loss"]`, ids[2]);
await page.waitForTimeout(250);
check('分岐を設定すると線が引かれる', (await page.locator('.tree-edge').count()) === 2);

/* 「勝ったら同じ形をもう一度」は実戦で普通に出るので、自己ループを許している */
await page.selectOption(`select[data-tree-node="${ids[1]}"][data-tree-result="win"]`, ids[1]);
await page.waitForTimeout(250);
check('自分自身への分岐も置ける', (await page.locator('.tree-edge').count()) === 3);

await page.keyboard.press('Escape');
await page.waitForTimeout(300);

/* ---------------- ライブ画面でのツリー連動 ---------------- */
console.log('\nライブ連動');
await page.click('#btn-start');
await page.waitForTimeout(400);
await page.locator(`[data-act="pick"][data-id="${ids[0]}"]`).click();
await page.waitForTimeout(400);
await page.locator('[data-act="result"][data-result="WIN"]').click();
await page.waitForTimeout(500);
check('勝敗のあとツリーの次が出る', (await page.locator('.tree-next').count()) === 1);
/* 分岐は縛りではないので、他の戦術も必ず選べること */
check('ツリー以外の戦術も選べる', (await page.locator('.pick-list .pick').count()) > 0);

/* スコアリセット。サンドボックスで confirm が無視されて
   「押しても何も起きない」状態になっていたことがある */
check('リセット前にラウンドが残っている',
  (await page.evaluate(() => window.VCT_STORE.state.rounds.length)) > 0);
await page.click('#btn-reset-match');
await page.waitForSelector('#modal-ask:not([hidden])', { timeout: 3000 });
await page.click('#ask-cancel');
await page.waitForTimeout(300);
check('取り消したらリセットされない',
  (await page.evaluate(() => window.VCT_STORE.state.rounds.length)) > 0);
await page.click('#btn-reset-match');
await answerAsk();
check('スコアリセットが効く',
  (await page.evaluate(() => window.VCT_STORE.state.rounds.length)) === 0);

await page.evaluate(() => { window.VCT_STORE.resetMatch && window.VCT_STORE.resetMatch(); });
await page.reload();
await page.waitForTimeout(600);
await page.evaluate(() => { window.VCT_STORE.state.phase = 'setup'; window.VCT_STORE.save(); });
await page.reload();
await page.waitForTimeout(600);

/* ---------------- 配置盤を開く ---------------- */
console.log('\n配置盤');

/* 「配置を編集」は 3 か所にある。新規作成中のものが無反応だった事故がある */
await page.locator('.tcard-board').first().click();
await page.waitForTimeout(500);
check('デッキカードから配置盤が開く', await page.locator('#modal-board').isVisible());

const box = await page.locator('#board-canvas svg').boundingBox();

/* 一番下のエージェントのスキルまでスクロールせずに掴めるか */
const palette = await page.evaluate(() => {
  const el = document.getElementById('board-palette-ally');
  return { needsScroll: el.scrollHeight > el.clientHeight + 2 };
});
check('パレットがスクロールなしで全員ぶん収まる', !palette.needsScroll);

/* 盤面がモーダルからはみ出していないか */
const fit = await page.evaluate(() => {
  const hint = document.getElementById('board-hint').getBoundingClientRect();
  const body = document.querySelector('#modal-board .modal-body').getBoundingClientRect();
  return { hintBottom: Math.round(hint.bottom), bodyBottom: Math.round(body.bottom) };
});
check('盤面が画面に収まっている', fit.hintBottom <= fit.bodyBottom,
  `ヒント下端 ${fit.hintBottom} > 本文下端 ${fit.bodyBottom}`);

/* ---------------- 置く・動かす・消す ---------------- */
const marks = () => page.evaluate(() => {
  const S = window.VCT_STORE, B = window.VCT_BOARD;
  const t = S.state.tactics.find((x) => B.phases(x).some((p) => p.marks.length || p.routes.length));
  return t ? B.phases(t).map((p) => ({
    name: p.name,
    marks: p.marks.map((m) => m.kind),
    routes: p.routes.length
  })) : [];
});

async function dragTo(selector, fx, fy) {
  const el = page.locator(selector).first();
  const bb = await el.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + 30, bb.y + 25, { steps: 4 });   // しきい値を越えさせる
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(220);
}

await dragTo('#board-palette-ally .pal-group:nth-child(2) .pal-agent', 0.40, 0.40);
check('エージェントをドラッグで置ける', (await marks())[0]?.marks.length === 1);

/* パレットの一番下のスキルが掴めるか（以前ここが画面外で掴めなかった） */
await dragTo('#board-palette-ally .pal-group:last-child .pal-ability', 0.50, 0.50);
check('最下段のエージェントのスキルも置ける', (await marks())[0]?.marks.length === 2);

await dragTo('.pal-plant', 0.55, 0.30);
check('プラント位置を置ける', (await marks())[0]?.marks.includes('plant'));

/* プラントは 1 つだけ。置き直すと入れ替わる */
await dragTo('.pal-plant', 0.62, 0.66);
check('プラント位置は増えず入れ替わる',
  (await marks())[0].marks.filter((k) => k === 'plant').length === 1);

/* 左ドラッグで動く（消えない） */
const before = await page.evaluate(() => {
  const S = window.VCT_STORE, B = window.VCT_BOARD;
  const m = B.phases(S.state.tactics.find((x) => B.phases(x).some((p) => p.marks.length)))[0].marks[0];
  return { x: Math.round(m.x), y: Math.round(m.y) };
});
const mb = await page.locator('#board-canvas .board-mark').first().boundingBox();
await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.72, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(250);
const after = await page.evaluate(() => {
  const S = window.VCT_STORE, B = window.VCT_BOARD;
  const m = B.phases(S.state.tactics.find((x) => B.phases(x).some((p) => p.marks.length)))[0].marks[0];
  return { x: Math.round(m.x), y: Math.round(m.y) };
});
/* 位置まで見ること。数だけ数えていたせいで、動かずに複製される不具合を取り逃がした */
check('置いたものが左ドラッグで動く', before.x !== after.x || before.y !== after.y,
  `${JSON.stringify(before)} のまま`);

/* 右クリックで消える */
const countBefore = (await marks())[0].marks.length;
const rm = await page.locator('#board-canvas .board-mark').first().boundingBox();
await page.mouse.click(rm.x + rm.width / 2, rm.y + rm.height / 2, { button: 'right' });
await page.waitForTimeout(250);
check('右クリックで消せる', (await marks())[0].marks.length === countBefore - 1);

/* ---------------- ルート ---------------- */
console.log('\nルート');
await page.locator('[data-board-act="route-start"][data-team="ally"]').click();
await page.waitForTimeout(200);
for (const [fx, fy] of [[0.25, 0.80], [0.45, 0.55], [0.60, 0.35]]) {
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(120);
}
await page.locator('[data-board-act="route-done"]').click();
await page.waitForTimeout(300);
check('ルートを引ける', (await marks())[0].routes === 1);

/* 線から少しずれても右クリックで消せるか（当たり判定の広さ） */
const hit = await page.evaluate(() => {
  const el = document.querySelector('#board-canvas .board-route');
  const p = el.getPointAtLength(el.getTotalLength() * 0.4);
  const r = el.ownerSVGElement.getBoundingClientRect();
  return { x: r.left + r.width * p.x / 100 + 7, y: r.top + r.height * p.y / 100 };
});
await page.mouse.click(hit.x, hit.y, { button: 'right' });
await page.waitForTimeout(250);
check('ルートを右クリックで消せる', (await marks())[0].routes === 0);

/* ---------------- 局面 ---------------- */
console.log('\n局面');
await page.fill('#phase-name', 'Aフェイク');
await page.waitForTimeout(150);
await page.locator('.stage-add').click();
await page.waitForTimeout(300);
check('局面を追加できる', await page.locator('#board-phases .stage-tab').count() === 2);

await dragTo('#board-palette-ally .pal-group:nth-child(3) .pal-agent', 0.60, 0.55);
await page.fill('#phase-name', 'B本命');
await page.waitForTimeout(150);
check('局面ごとに配置が分かれている',
  await page.locator('#board-canvas .board-mark').count() === 1);

await page.locator('#board-phases .stage-tab').first().click();
await page.waitForTimeout(300);
check('局面を切り替えると配置も戻る',
  await page.locator('#board-canvas .board-mark').count() >= 2);
check('局面の名前が保たれている', await page.locator('#phase-name').inputValue() === 'Aフェイク');

/* ---------------- ライブ画面 ---------------- */
console.log('\nライブ画面');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.locator('#btn-start').click();
await page.waitForTimeout(400);
await page.locator('[data-act="pick"]').first().click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(400);
check('配置盤のパネルが出る', await page.locator('.board-panel').count() === 1);
check('局面タブがライブ画面にも出る', await page.locator('.board-panel .stage-tab').count() === 2);

/* ---------------- 保存 ---------------- */
console.log('\n保存');
const saved = await marks();
await page.reload();
await page.waitForTimeout(700);
const reloaded = await marks();
/* プラントの kind が保存で潰れていた事故があるので、種別まで見る */
check('再読み込みしても配置が残る',
  JSON.stringify(saved) === JSON.stringify(reloaded),
  `${JSON.stringify(saved)} → ${JSON.stringify(reloaded)}`);

/* ---------------- 設定による出し分け ----------------
   config.js の値でしか変わらないところは、dist の中身を書き換えた
   一時ファイルを開いて確かめる。dist は 1 枚の HTML なので置換で足りる。
   接続情報はリポジトリに置かない方針なので、ここではダミーを使う。 */
console.log('\n設定による出し分け');

const distHtml = fs.readFileSync(DIST, 'utf8');

/* 接続情報を入れたままコミットすると、この下の変種テストが成立しなくなるうえ
   「未設定ならクラウド保存は隠れる」も落ちる。まずそこを見る。 */
check('config.js に接続情報が残っていない',
  distHtml.includes("SUPABASE_URL: ''") && distHtml.includes("SUPABASE_ANON_KEY: ''"));

/* 変種を開く間は通信させない。空配列を返しておけば一覧は「投稿なし」になる */
await context.addInitScript(() => {
  window.fetch = () => Promise.resolve(
    new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
  );
});

async function openVariant(name, replacements) {
  let html = distHtml;
  for (const [from, to] of replacements) {
    if (!html.includes(from)) throw new Error(`変種 ${name}: 置換元が見つからない → ${from}`);
    html = html.split(from).join(to);
  }
  const file = path.join(os.tmpdir(), `vct-smoke-${name}.html`);
  fs.writeFileSync(file, html);
  await page.goto('file://' + file);
  await page.waitForTimeout(600);
  /* file:// は localStorage を共有するので、前のテストで開始したマッチの続きから
     立ち上がることがある。見るのはセットアップ画面なので戻しておく。 */
  await page.click('.phase-tab[data-phase="setup"]');
  await page.waitForTimeout(300);
  return file;
}

/* ログインモーダルは閉じているので、中の要素は「見えない」としか答えられない。
   applyAuthConfig() が触るのは hidden 属性なので、そちらを直接見る。 */
async function loginBoxes() {
  return page.evaluate(() => {
    const g = (id) => document.getElementById(id);
    return {
      discord: g('btn-login-discord').hidden,
      providers: g('login-providers').hidden,
      sep: g('login-sep').hidden,
      email: g('login-email-block').hidden
    };
  });
}

const CFG_URL = ["SUPABASE_URL: ''", "SUPABASE_URL: 'https://example.supabase.co'"];
const CFG_KEY = ["SUPABASE_ANON_KEY: ''", "SUPABASE_ANON_KEY: 'dummy-anon-key'"];

/* --- 未設定のとき --- */
await openVariant('default', []);
check('未設定ならコミュニティタブも隠れる', await page.locator('#tab-community').isHidden());
check('未設定ならクラウド保存ボタンも隠れる', await page.locator('#btn-cloud').isHidden());

/* Discord を有効にしていないのにボタンを出すと、押した先で必ず失敗する。
   出すかどうかは AUTH_PROVIDERS だけで決まること。 */
let authBox = await loginBoxes();
check('AUTH_PROVIDERS が空なら Discord ボタンは出ない', authBox.discord === true);
check('AUTH_PROVIDERS が空ならプロバイダ欄ごと隠れる', authBox.providers === true);
check('AUTH_EMAIL が true ならメールログインは出る', authBox.email === false);
check('プロバイダが無いときは区切り線も出ない', authBox.sep === true);

/* --- Discord を足したとき --- */
await openVariant('discord', [["AUTH_PROVIDERS: []", "AUTH_PROVIDERS: ['discord']"]]);
authBox = await loginBoxes();
check('AUTH_PROVIDERS に足せば Discord ボタンが出る', authBox.discord === false);
check('プロバイダがあれば区切り線も出る', authBox.sep === false);
check('Discord を足してもメールログインは残る', authBox.email === false);

/* --- 接続情報を入れたとき --- */
await openVariant('community', [CFG_URL, CFG_KEY]);
check('接続情報を入れるとコミュニティタブが出る',
  await page.locator('#tab-community').isHidden() === false);
check('接続情報を入れるとクラウド保存ボタンが出る',
  await page.locator('#btn-cloud').isHidden() === false);

await page.click('.phase-tab[data-phase="community"]');
await page.waitForTimeout(500);
check('コミュニティ画面が開く', await page.locator('#view-community').isVisible());
check('未ログインならログインへの導線が出る',
  (await page.locator('#community-account [data-act="login"]').count()) === 1);

/* ここは実際にモーダルを開けるので、hidden 属性ではなく見た目で確かめる */
await page.click('#community-account [data-act="login"]');
await page.waitForTimeout(400);
check('ログインモーダルが開く', await page.locator('#modal-login').isVisible());
check('開いた状態でも Discord ボタンは見えない',
  await page.locator('#btn-login-discord').isVisible() === false);
check('開いた状態でメールログインは見える',
  await page.locator('#login-email').isVisible());
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

await page.click('#btn-open-post');
await page.waitForTimeout(400);
check('投稿モーダルが開く', await page.locator('#modal-post').isVisible());
check('投稿モーダルに戦術が並ぶ', (await page.locator('#post-tactic option').count()) > 0);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

/* コミュニティ検索。列名は name / note で、title / body という列は無い。
   以前ここを title / body に当てていて、戦術名でもコール詳細でも
   絶対にヒットしない検索になっていた。 */
const found = await page.evaluate(() => {
  const U = window.VCT_UI;
  const posts = [
    { id: 'p1', name: 'B ファストラッシュ', note: 'フラッシュ2枚先行', map: 'ascent',
      side: 'ATK', site: 'B', kind: 'fast', author_name: 'ALPHA', likes: 0, enemy_comp: [] },
    { id: 'p2', name: 'A スタック', note: '3枚寄せ', map: 'bind',
      side: 'DEF', site: 'A', kind: 'stack', author_name: 'BRAVO', likes: 0, enemy_comp: [] }
  ];
  const n = (q) => {
    U.renderPosts(posts, null, q);
    return document.querySelectorAll('#post-grid .post-card').length;
  };
  const out = { all: n(''), byName: n('ファストラッシュ'), byNote: n('フラッシュ2枚'),
                byAuthor: n('BRAVO'), byMap: n('bind'), andWords: n('スタック BRAVO'),
                none: n('該当しない語') };
  out.emptyText = document.getElementById('post-empty').textContent;
  /* 最後に絞り込みを解いてから、カード内のボタンを数える */
  n('');
  out.likeButtons = document.querySelectorAll('#post-grid [data-act="like"]').length;
  out.importButtons = document.querySelectorAll('#post-grid [data-act="import-post"]').length;
  return out;
});
check('検索なしでは全件出る', found.all === 2, String(found.all));
check('戦術名で検索できる', found.byName === 1, String(found.byName));
check('コール詳細（本文）で検索できる', found.byNote === 1, String(found.byNote));
check('投稿者で検索できる', found.byAuthor === 1, String(found.byAuthor));
check('マップで検索できる', found.byMap === 1, String(found.byMap));
check('スペース区切りは AND になる', found.andWords === 1, String(found.andWords));
check('ヒットしなければその旨を出す', found.none === 0 && /ありません|No |없습니다/.test(found.emptyText),
  found.emptyText);

/* いいねボタンと取り込みボタンはカードごとに出ていること */
check('カードにいいねと取り込みのボタンが出る',
  found.likeButtons === 2 && found.importButtons === 2,
  `like ${found.likeButtons} / import ${found.importButtons}`);

/* --- 通報・編集・削除・エラー整形 ---
   ここから先は通信の中身が要るので、fetch を差し替えて筋書きを作る。
   RLS そのものは DB 側で確かめてあるので、ここで見るのは画面の出し分けと文言。 */
async function withStub(script) {
  return page.evaluate(script);
}

const reportUi = await withStub(async () => {
  const g = (id) => document.getElementById(id);
  const post = { id: 'p-report', name: '通報対象', note: 'x', map: 'ascent', side: 'ATK',
                 site: 'A', kind: 'execute', author_name: 'SOMEONE', user_id: null,
                 likes: 0, enemy_comp: [] };
  let counted = true;
  const sent = [];   /* RPC に何を渡したか */
  const orig = window.fetch;
  window.fetch = (u, o) => {
    const url = String(u), m = (o && o.method) || 'GET';
    if (url.includes('/rest/v1/tactic_posts') && m === 'GET') {
      return Promise.resolve(new Response(JSON.stringify([post]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (url.includes('/rpc/report_post')) {
      sent.push(JSON.parse(o.body));
      const body = JSON.stringify({ counted, reports: 1, hidden: false, threshold: 5 });
      counted = false;   /* 2 回目からはサーバ側で弾かれる筋書き */
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return orig(u, o);
  };
  localStorage.removeItem('vct.reported');
  localStorage.removeItem('vct.session');

  document.querySelector('.phase-tab[data-phase="setup"]').click();
  await new Promise((r) => setTimeout(r, 200));
  document.querySelector('.phase-tab[data-phase="community"]').click();
  await new Promise((r) => setTimeout(r, 600));

  const out = {};
  out.hasReportButton = !!document.querySelector('#post-grid [data-act="report"]');
  out.noOwnerButtons = !document.querySelector('#post-grid [data-act="edit-post"]') &&
                       !document.querySelector('#post-grid [data-act="delete-post"]');

  /* 押したらまず理由を選ばせる。誤操作で即通報にならないこと */
  document.querySelector('#post-grid [data-act="report"]').click();
  await new Promise((r) => setTimeout(r, 300));
  out.modalShown = !g('modal-report').hidden;
  out.targetText = g('report-target').textContent;
  out.reasonCount = g('report-reasons').querySelectorAll('input[name="report-reason"]').length;
  out.reasonValues = [...g('report-reasons').querySelectorAll('input[name="report-reason"]')].map((r) => r.value);
  out.detailHiddenAtFirst = g('report-detail-field').hidden;
  out.sentBeforeSubmit = sent.length;

  /* 「その他」を選ぶと補足欄が出る */
  const other = g('report-reasons').querySelector('input[value="other"]');
  other.checked = true;
  other.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  out.detailShownForOther = g('report-detail-field').hidden === false;
  g('report-detail').value = 'マップ違いの内容';

  g('report-form').requestSubmit();
  await new Promise((r) => setTimeout(r, 700));
  out.firstToast = g('toast').textContent;
  out.firstToastClass = g('toast').className;
  out.modalClosed = g('modal-report').hidden;
  out.firstSent = sent[0];
  const btn1 = document.querySelector('#post-grid [data-act="report"]');
  out.buttonDisabledAfter = btn1.disabled;
  out.buttonLabelAfter = btn1.textContent.trim();

  /* 理由を選び直したときに、その値が渡ること */
  localStorage.removeItem('vct.reported');
  window.VCT_UI.renderPosts([post], null, '');
  await new Promise((r) => setTimeout(r, 200));
  document.querySelector('#post-grid [data-act="report"]').click();
  await new Promise((r) => setTimeout(r, 300));
  const spam = g('report-reasons').querySelector('input[value="spam"]');
  spam.checked = true;
  spam.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 150));
  out.detailHiddenForSpam = g('report-detail-field').hidden;
  g('report-form').requestSubmit();
  await new Promise((r) => setTimeout(r, 700));
  out.dupToast = g('toast').textContent;
  out.dupToastClass = g('toast').className;
  out.secondSent = sent[1];

  window.fetch = orig;
  return out;
});

check('投稿カードに通報ボタンが出る', reportUi.hasReportButton);
check('他人・匿名の投稿に編集と削除は出ない', reportUi.noOwnerButtons);
check('通報は押してすぐには送らず理由を選ばせる',
  reportUi.modalShown === true && reportUi.sentBeforeSubmit === 0);
check('理由の選択肢が 5 つある', reportUi.reasonCount === 5, String(reportUi.reasonCount));
check('選択肢は DB の check 制約と同じ並び',
  JSON.stringify(reportUi.reasonValues) ===
  JSON.stringify(['spam', 'abuse', 'misleading', 'offtopic', 'other']),
  JSON.stringify(reportUi.reasonValues));
check('通報の文面に投稿名が入っている', /通報対象/.test(reportUi.targetText), reportUi.targetText.slice(0, 60));
check('補足欄は「その他」を選んだときだけ出る',
  reportUi.detailHiddenAtFirst === true && reportUi.detailShownForOther === true &&
  reportUi.detailHiddenForSpam === true);
check('選んだ理由と補足が RPC へ渡る',
  reportUi.firstSent && reportUi.firstSent.p_reason === 'other' &&
  reportUi.firstSent.p_detail === 'マップ違いの内容',
  JSON.stringify(reportUi.firstSent));
check('別の理由を選べばその値が渡る',
  reportUi.secondSent && reportUi.secondSent.p_reason === 'spam' &&
  reportUi.secondSent.p_detail === '',
  JSON.stringify(reportUi.secondSent));
check('通報が通ると成功として知らせる', /ok/.test(reportUi.firstToastClass), reportUi.firstToast);
check('通報が通ったらモーダルが閉じる', reportUi.modalClosed === true);
check('通報したらボタンが押せなくなる',
  reportUi.buttonDisabledAfter === true, reportUi.buttonLabelAfter);
check('同じ相手の 2 回目は通報済みとして知らせる',
  reportUi.dupToast !== reportUi.firstToast && /warn/.test(reportUi.dupToastClass),
  reportUi.dupToast);

const ownerUi = await withStub(async () => {
  const g = (id) => document.getElementById(id);
  const posts = [
    { id: 'mine', name: '自分の投稿', note: 'もとのコール', map: 'ascent', side: 'ATK', site: 'A',
      kind: 'execute', author_name: 'ME', user_id: 'me-123', likes: 0, enemy_comp: [] },
    { id: 'other', name: '他人の投稿', note: 'y', map: 'bind', side: 'DEF', site: 'B',
      kind: 'stack', author_name: 'YOU', user_id: 'other-999', likes: 0, enemy_comp: [] },
    { id: 'anon', name: '匿名の投稿', note: 'z', map: 'haven', side: 'ATK', site: 'C',
      kind: 'fake', author_name: 'ANONYMOUS', user_id: null, likes: 0, enemy_comp: [] }
  ];
  const orig = window.fetch;
  window.fetch = (u, o) => {
    const url = String(u), m = (o && o.method) || 'GET';
    if (url.includes('/rest/v1/tactic_posts')) {
      if (m === 'GET') return Promise.resolve(new Response(JSON.stringify(posts), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (m === 'PATCH') return Promise.resolve(new Response(JSON.stringify([{ id: 'mine', name: '編集後' }]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (m === 'DELETE') return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return orig(u, o);
  };
  localStorage.setItem('vct.session', JSON.stringify({
    access_token: 'stub', refresh_token: '', expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'me-123' }
  }));
  window.VCT_COMMUNITY.init();
  await new Promise((r) => setTimeout(r, 200));

  document.querySelector('.phase-tab[data-phase="setup"]').click();
  await new Promise((r) => setTimeout(r, 200));
  document.querySelector('.phase-tab[data-phase="community"]').click();
  await new Promise((r) => setTimeout(r, 700));

  const acts = {};
  document.querySelectorAll('#post-grid .post-card').forEach((c) => {
    acts[c.dataset.id] = [...c.querySelectorAll('.post-foot button')].map((b) => b.dataset.act);
  });

  const out = { acts };
  document.querySelector('#post-grid [data-act="edit-post"]').click();
  await new Promise((r) => setTimeout(r, 300));
  out.editOpen = !g('modal-post-edit').hidden;
  out.editName = g('post-edit-name').value;
  out.editNote = g('post-edit-note').value;
  out.nameMax = g('post-edit-name').maxLength;
  out.noteMax = g('post-edit-note').maxLength;
  g('post-edit-form').requestSubmit();
  await new Promise((r) => setTimeout(r, 700));
  out.savedToast = g('toast').textContent;
  out.editClosed = g('modal-post-edit').hidden;

  await new Promise((r) => setTimeout(r, 400));
  const del = document.querySelector('#post-grid [data-act="delete-post"]');
  if (del) {
    del.click();
    await new Promise((r) => setTimeout(r, 300));
    out.deleteConfirm = g('modal-ask').hidden ? '' : g('modal-ask').innerText;
    g('ask-ok').click();
    await new Promise((r) => setTimeout(r, 700));
    out.deletedToast = g('toast').textContent;
  }

  localStorage.removeItem('vct.session');
  window.VCT_COMMUNITY.init();
  window.fetch = orig;
  return out;
});

check('自分の投稿には編集と削除が出る',
  (ownerUi.acts.mine || []).includes('edit-post') && (ownerUi.acts.mine || []).includes('delete-post'),
  JSON.stringify(ownerUi.acts.mine));
check('他人の投稿には編集と削除が出ない',
  !(ownerUi.acts.other || []).includes('edit-post') && !(ownerUi.acts.other || []).includes('delete-post'),
  JSON.stringify(ownerUi.acts.other));
check('匿名の投稿には編集と削除が出ない',
  !(ownerUi.acts.anon || []).includes('edit-post') && !(ownerUi.acts.anon || []).includes('delete-post'),
  JSON.stringify(ownerUi.acts.anon));
check('編集モーダルに今の内容が入る',
  ownerUi.editOpen === true && ownerUi.editName === '自分の投稿' && ownerUi.editNote === 'もとのコール');
check('編集欄の上限が DB の制約と同じ', ownerUi.nameMax === 60 && ownerUi.noteMax === 600,
  `name ${ownerUi.nameMax} / note ${ownerUi.noteMax}`);
check('保存すると閉じて知らせる', ownerUi.editClosed === true && !!ownerUi.savedToast, ownerUi.savedToast);
check('削除の前に確認を出す', /削除|Delete|삭제/.test(ownerUi.deleteConfirm || ''), ownerUi.deleteConfirm);
check('削除できたことを知らせる', !!ownerUi.deletedToast, ownerUi.deletedToast);

/* --- 運営 UI の出し分け --- */
const modUi = await page.evaluate(async () => {
  const g = (id) => document.getElementById(id);
  const posts = [
    { id: 'visible', name: '見えている投稿', note: 'a', map: 'ascent', side: 'ATK', site: 'A',
      kind: 'execute', author_name: 'X', user_id: null, likes: 0, reports: 2,
      hidden: false, moderation: 'auto', enemy_comp: [] },
    { id: 'hiddenone', name: '隠れている投稿', note: 'b', map: 'bind', side: 'DEF', site: 'B',
      kind: 'stack', author_name: 'Y', user_id: null, likes: 0, reports: 5,
      hidden: true, moderation: 'auto', enemy_comp: [] }
  ];
  const orig = window.fetch;
  let restoreCalled = null;
  window.fetch = (u, o) => {
    const url = String(u), m = (o && o.method) || 'GET';
    if (url.includes('/rpc/is_admin')) {
      return Promise.resolve(new Response('true', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (url.includes('/rpc/admin_set_hidden')) {
      restoreCalled = JSON.parse(o.body);
      return Promise.resolve(new Response(JSON.stringify({ id: 'hiddenone', hidden: false, reports: 5, moderation: 'restored' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (url.includes('/rpc/admin_report_breakdown')) {
      return Promise.resolve(new Response(JSON.stringify({
        post_id: 'hiddenone', total: 5,
        by_reason: { spam: 3, abuse: 1, other: 1 },
        details: [{ reason: 'other', detail: 'マップ違い', created_at: '2026-09-02T00:00:00Z' }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (url.includes('/rest/v1/moderation_log')) {
      return Promise.resolve(new Response(JSON.stringify([
        { id: 2, action: 'restore', post_id: 'hiddenone', created_at: '2026-09-02T01:02:03Z',
          old_value: { hidden: true }, new_value: { hidden: false }, moderator_note: '誤通報だった' },
        { id: 1, action: 'set_threshold', post_id: null, created_at: '2026-09-02T01:00:00Z',
          old_value: { report_threshold: 5 }, new_value: { report_threshold: 6 }, moderator_note: '' }
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (url.includes('/rest/v1/tactic_posts') && m === 'GET') {
      return Promise.resolve(new Response(JSON.stringify(posts), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return orig(u, o);
  };

  const out = {};

  /* まず運営者ではない状態 */
  localStorage.removeItem('vct.session');
  await window.VCT_COMMUNITY.init();
  document.querySelector('.phase-tab[data-phase="setup"]').click();
  await new Promise((r) => setTimeout(r, 200));
  document.querySelector('.phase-tab[data-phase="community"]').click();
  await new Promise((r) => setTimeout(r, 600));
  out.toolsHiddenForGuest = g('admin-tools').hidden;
  out.modLogHiddenForGuest = g('btn-modlog').hidden;
  out.guestActs = [...document.querySelectorAll('#post-grid .post-foot button')].map((b) => b.dataset.act);
  out.guestSeesModBadge = !!document.querySelector('.post-mod');

  /* 運営者にする */
  localStorage.setItem('vct.session', JSON.stringify({
    access_token: 'stub', refresh_token: '', expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'admin-1' }
  }));
  await window.VCT_COMMUNITY.init();
  document.querySelector('.phase-tab[data-phase="setup"]').click();
  await new Promise((r) => setTimeout(r, 200));
  document.querySelector('.phase-tab[data-phase="community"]').click();
  await new Promise((r) => setTimeout(r, 700));
  out.isAdmin = window.VCT_COMMUNITY.isAdmin();
  out.toolsShownForAdmin = g('admin-tools').hidden === false;
  const acts = {};
  document.querySelectorAll('#post-grid .post-card').forEach((c) => {
    acts[c.dataset.id] = [...c.querySelectorAll('.post-foot button')].map((b) => b.dataset.act);
  });
  out.adminActs = acts;
  out.badgeText = (document.querySelector('#post-grid .post-card:nth-child(2) .post-mod') || {}).innerText || '';
  out.modLogButtonShown = g('btn-modlog').hidden === false;

  /* 通報の内訳を見る */
  document.querySelector('#post-grid [data-act="admin-reasons"]').click();
  await new Promise((r) => setTimeout(r, 500));
  out.breakdownOpen = g('modal-breakdown').hidden === false;
  out.breakdownText = g('breakdown-body').innerText;
  document.querySelector('#modal-breakdown [data-close]').click();
  await new Promise((r) => setTimeout(r, 300));

  /* 監査ログを見る */
  g('btn-modlog').click();
  await new Promise((r) => setTimeout(r, 500));
  out.modLogOpen = g('modal-modlog').hidden === false;
  out.modLogText = g('modlog-body').innerText;
  document.querySelector('#modal-modlog [data-close]').click();
  await new Promise((r) => setTimeout(r, 300));

  /* 復旧を押す。運営メモは書かなくてよい */
  document.querySelector('#post-grid [data-act="admin-restore"]').click();
  await new Promise((r) => setTimeout(r, 300));
  out.confirmText = g('modal-ask').hidden ? '' : g('modal-ask').innerText;
  out.noteInputShown = g('ask-input').hidden === false;
  g('ask-input').value = '誤通報だった';
  g('ask-ok').click();
  await new Promise((r) => setTimeout(r, 700));
  out.restoreCalled = restoreCalled;
  out.toast = g('toast').textContent;

  localStorage.removeItem('vct.session');
  await window.VCT_COMMUNITY.init();
  window.fetch = orig;
  return out;
});

check('一般ユーザーに運営メニューは出ない', modUi.toolsHiddenForGuest === true);
check('一般ユーザーに監査ログのボタンは出ない', modUi.modLogHiddenForGuest === true);
check('一般ユーザーのカードに通報理由のボタンは出ない',
  !modUi.guestActs.includes('admin-reasons'), JSON.stringify(modUi.guestActs));
check('一般ユーザーのカードに運営ボタンは出ない',
  !modUi.guestActs.includes('admin-restore') && !modUi.guestActs.includes('admin-hide'),
  JSON.stringify(modUi.guestActs));
check('一般ユーザーに通報数は見せない', modUi.guestSeesModBadge === false);
check('運営者だと判定できる', modUi.isAdmin === true);
check('運営者には運営メニューが出る', modUi.toolsShownForAdmin === true);
check('隠れている投稿には復旧ボタンが出る',
  (modUi.adminActs.hiddenone || []).includes('admin-restore'),
  JSON.stringify(modUi.adminActs.hiddenone));
check('見えている投稿には非表示ボタンが出る',
  (modUi.adminActs.visible || []).includes('admin-hide'),
  JSON.stringify(modUi.adminActs.visible));
check('運営者には通報数と状態が見える',
  /5/.test(modUi.badgeText) && /非表示|HIDDEN|숨김/.test(modUi.badgeText), modUi.badgeText);
check('復旧の前に確認を出す', /再表示|Show |다시 표시/.test(modUi.confirmText), modUi.confirmText.slice(0, 80));
check('復旧は hidden=false で呼ばれる',
  modUi.restoreCalled && modUi.restoreCalled.p_hidden === false,
  JSON.stringify(modUi.restoreCalled));
check('復旧できたことを知らせる', !!modUi.toast, modUi.toast);
check('運営者には監査ログのボタンが出る', modUi.modLogButtonShown === true);
check('通報の内訳が開く', modUi.breakdownOpen === true);
check('内訳に理由ごとの件数が出る',
  /スパム|Spam|스팸/.test(modUi.breakdownText) && /3/.test(modUi.breakdownText),
  modUi.breakdownText.slice(0, 120));
check('その他の補足も内訳に出る', /マップ違い/.test(modUi.breakdownText), modUi.breakdownText.slice(0, 160));
check('監査ログが開く', modUi.modLogOpen === true);
check('監査ログに操作と運営メモが出る',
  /再表示|Restored|다시 표시/.test(modUi.modLogText) && /誤通報だった/.test(modUi.modLogText),
  modUi.modLogText.slice(0, 160));
check('監査ログにしきい値の変更も出る',
  /report_threshold/.test(modUi.modLogText), modUi.modLogText.slice(0, 200));
check('運営操作では運営メモを書ける', modUi.noteInputShown === true);
check('運営メモが RPC へ渡る',
  modUi.restoreCalled && modUi.restoreCalled.p_note === '誤通報だった',
  JSON.stringify(modUi.restoreCalled));

/* 生の Postgres メッセージを画面に出さないこと */
const rawErr = await page.evaluate(async () => {
  const g = (id) => document.getElementById(id);
  const orig = window.fetch;
  const body = JSON.stringify({
    code: '23514', message:
      'new row for relation "tactic_posts" violates check constraint "tactic_posts_note_check"'
  });
  window.fetch = (u, o) => {
    if (String(u).includes('/rest/v1/tactic_posts') && o && o.method === 'POST') {
      return Promise.resolve(new Response(body, { status: 400, headers: { 'Content-Type': 'application/json' } }));
    }
    return orig(u, o);
  };
  g('btn-open-post').click();
  await new Promise((r) => setTimeout(r, 300));
  g('post-form').requestSubmit();
  await new Promise((r) => setTimeout(r, 700));
  const text = g('toast').textContent;
  g('modal-post').hidden = true;
  window.fetch = orig;
  return text;
});
check('失敗しても生の DB メッセージは出さない',
  !/violates|constraint|relation |row-level|PGRST/i.test(rawErr), rawErr);
check('失敗の理由は利用者向けの文言で出す', rawErr.length > 0 && /600|60|24|長|long|깁/.test(rawErr), rawErr);

/* 並び替えと絞り込み */
await page.click('#community-sort .chip[data-sort="top"]');
await page.waitForTimeout(400);
check('人気ソートに切り替わる',
  await page.locator('#community-sort .chip[data-sort="top"]').evaluate((el) => el.classList.contains('is-active')));

await page.fill('#community-query', 'ラッシュ');
await page.waitForTimeout(300);
check('検索するとクリアボタンが出る', await page.locator('#btn-community-clear').isHidden() === false);
await page.click('#btn-community-clear');
await page.waitForTimeout(300);
check('クリアボタンで検索語が消える', (await page.locator('#community-query').inputValue()) === '');

/* ---------------- スキーマ ----------------
   DB へは繋がないので、schema.sql の中身だけを見る。
   ここに並んでいるのは、実際に壊れて事故になったものだけ。 */
console.log('\nスキーマ');
const schema = fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8');

for (const table of ['tactic_posts', 'tactic_likes', 'saved_setups', 'ai_usage']) {
  check(`${table} の定義がある`, schema.includes(`create table if not exists public.${table}`));
}
for (const table of ['tactic_posts', 'tactic_likes', 'saved_setups', 'ai_usage']) {
  check(`${table} で RLS を有効にしている`,
    schema.includes(`alter table public.${table} enable row level security`));
}
for (const policy of ['tactic_posts_read', 'tactic_posts_insert', 'tactic_posts_update',
                      'tactic_posts_delete', 'tactic_likes_none', 'saved_setups_all']) {
  check(`ポリシー ${policy} がある`, schema.includes(`create policy ${policy}`));
}
for (const fn of ['touch_updated_at', 'enforce_post_rate_limit', 'like_post', 'report_post']) {
  check(`関数 ${fn} の定義がある`,
    schema.includes(`create or replace function public.${fn}`));
}

/* pgcrypto は extensions スキーマに入る。search_path を public だけに絞ると
   digest() が見つからず、tactic_posts への insert が丸ごと失敗する。 */
check('レート制限の search_path に extensions が入っている',
  /enforce_post_rate_limit[\s\S]{0,400}?set search_path = public, extensions/.test(schema));

/* revoke ... from anon, authenticated だけでは効かない。関数には既定で PUBLIC に
   EXECUTE が付いていて、anon も authenticated もその PUBLIC のメンバーだから。 */
for (const fn of ['touch_updated_at', 'enforce_post_rate_limit']) {
  check(`トリガ関数 ${fn} の EXECUTE を PUBLIC から落としている`,
    schema.includes(`revoke all on function public.${fn}() from public;`));
  check(`トリガ関数 ${fn} の EXECUTE を anon / authenticated からも落としている`,
    schema.includes(`revoke all on function public.${fn}() from anon, authenticated;`));
}

/* 通報の重複防止。これが無いと 1 人が 5 回叩くだけで投稿を隠せる */
check('tactic_reports の定義がある',
  schema.includes('create table if not exists public.tactic_reports'));
check('通報は投稿と通報者の組で一意になっている',
  /tactic_reports[\s\S]{0,400}?primary key \(post_id, reporter\)/.test(schema));
check('tactic_reports で RLS を有効にしている',
  schema.includes('alter table public.tactic_reports enable row level security'));
check('ポリシー tactic_reports_none がある', schema.includes('create policy tactic_reports_none'));
check('report_post が通報者と理由を受け取る',
  /create or replace function public\.report_post\(\s*p_post_id\s+uuid,\s*p_reporter\s+text,\s*p_reason\s+text[\s\S]{0,80}?p_detail\s+text/.test(schema));
check('通報者を取らない旧 report_post を落としている',
  schema.includes('drop function if exists public.report_post(uuid);'));
check('重複した通報は数えない',
  /report_post[\s\S]{0,900}?insert into public.tactic_reports[\s\S]{0,200}?on conflict do nothing/.test(schema));
check('しきい値に達したら hidden にする仕様は残っている',
  /report_post[\s\S]{0,1600}?\(reports \+ 1\) >= v_threshold/.test(schema));
check('しきい値はコードに埋めず設定値から読む',
  /report_post[\s\S]{0,600}?v_threshold int := public\.report_threshold\(\)/.test(schema));
check('しきい値の初期値は 5',
  schema.includes("values ('report_threshold', '5'::jsonb)") &&
  /report_threshold\(\)[\s\S]{0,400}?coalesce\([\s\S]{0,200}?5\s*\)/.test(schema));
check('復旧した投稿は自動では隠さない',
  /report_post[\s\S]{0,1600}?case when moderation = 'auto'/.test(schema));
check('moderation 列と取りうる値が定義されている',
  schema.includes("add column if not exists moderation text not null default 'auto'") &&
  schema.includes("check (moderation in ('auto', 'restored', 'forced'))"));

/* --- 運営まわり --- */
check('admins テーブルの定義がある', schema.includes('create table if not exists public.admins'));
check('admins で RLS を有効にしている',
  schema.includes('alter table public.admins enable row level security'));
check('admins にポリシーを作っていない（誰からも読めない）',
  !/create policy \w+\s+on public\.admins/.test(schema));
check('community_config テーブルの定義がある',
  schema.includes('create table if not exists public.community_config'));
check('community_config は読み取りだけ許している',
  schema.includes('create policy community_config_read') &&
  !/create policy \w+\s+on public\.community_config for (insert|update|delete|all)/.test(schema));
check('is_admin の定義がある', schema.includes('create or replace function public.is_admin()'));
check('is_admin を anon から呼べないようにしている',
  schema.includes('revoke all on function public.is_admin() from anon;'));
for (const fn of ['admin_set_hidden(uuid, boolean, text)', 'admin_set_report_threshold(int, text)',
                  'admin_report_breakdown(uuid)']) {
  check(`${fn} を anon から呼べないようにしている`,
    schema.includes(`revoke all on function public.${fn} from anon;`));
  check(`${fn} を authenticated にだけ渡している`,
    schema.includes(`grant execute on function public.${fn} to authenticated;`));
}
check('運営 RPC は必ず is_admin() を見てから動く',
  (schema.match(/if not public\.is_admin\(\) then\s+raise exception 'NOT_ADMIN'/g) || []).length >= 2);
check('復旧しても通報の履歴は消さない',
  !/admin_set_hidden[\s\S]{0,1200}?delete from public\.tactic_reports/.test(schema));
check('運営者は隠れている投稿も読める',
  schema.includes('create policy tactic_posts_admin_read'));

/* --- 秘密情報がどこにも無いこと --- */
const secretish = /service_role|SERVICE_ROLE|sb_secret_|eyJhbGciOi/;
check('配布ファイルに service role キーらしきものが無い', !secretish.test(distHtml));
for (const f of ['assets/js/config.js', 'assets/js/community.js', 'assets/js/app.js']) {
  check(`${f} に service role キーらしきものが無い`,
    !secretish.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
}
check('schema.sql に service role キーらしきものが無い', !/sb_secret_|eyJhbGciOi/.test(schema));

/* 逆に、いいねと通報は意図して公開しているので消えていないこと */
check('like_post は anon / authenticated に公開したまま',
  schema.includes('grant execute on function public.like_post(uuid, text) to anon, authenticated;'));
check('report_post は anon / authenticated に公開したまま',
  schema.includes('grant execute on function public.report_post(uuid, text, text, text) to anon, authenticated;'));

/* --- 通報理由 --- */
check('通報に理由の列がある',
  schema.includes("alter table public.tactic_reports add column if not exists reason text not null default 'other'"));
check('理由は決められた 5 つに限っている',
  schema.includes("check (reason in ('spam', 'abuse', 'misleading', 'offtopic', 'other'))"));
check('その他の補足を入れる列がある',
  schema.includes("alter table public.tactic_reports add column if not exists detail text not null default ''"));
check('補足の長さに上限がある', /tactic_reports_detail_check[\s\S]{0,120}?char_length\(detail\) <= 200/.test(schema));
check('知らない理由が来ても other に寄せる',
  /report_post[\s\S]{0,900}?v_reason := 'other';/.test(schema));
check('理由を足しても重複通報は弾いたまま',
  /report_post[\s\S]{0,1200}?insert into public\.tactic_reports \(post_id, reporter, reason, detail\)[\s\S]{0,300}?on conflict do nothing/.test(schema));
check('引数が増えた旧 report_post を落としている',
  schema.includes('drop function if exists public.report_post(uuid, text);'));
check('通報の内訳は運営者だけが引ける',
  /admin_report_breakdown[\s\S]{0,300}?if not public\.is_admin\(\) then/.test(schema));
check('通報の内訳に通報者そのものは含めない',
  !/admin_report_breakdown[\s\S]{0,1200}?'reporter'/.test(schema));

/* --- 監査ログ --- */
check('moderation_log テーブルの定義がある',
  schema.includes('create table if not exists public.moderation_log'));
for (const col of ['action', 'post_id', 'admin_user_id', 'created_at', 'old_value', 'new_value', 'moderator_note']) {
  check(`監査ログに ${col} がある`,
    new RegExp('create table if not exists public\\.moderation_log[\\s\\S]{0,700}?' + col).test(schema));
}
check('記録する操作を 3 つに限っている',
  schema.includes("check (action in ('restore', 'force_hide', 'set_threshold'))"));
check('moderation_log で RLS を有効にしている',
  schema.includes('alter table public.moderation_log enable row level security'));
check('監査ログを読めるのは運営者だけ',
  /create policy moderation_log_admin_read[\s\S]{0,200}?using \(public\.is_admin\(\)\)/.test(schema));
check('監査ログに書き込みポリシーは作らない',
  !/create policy \w+\s+on public\.moderation_log for (insert|update|delete|all)/.test(schema));
check('復旧と強制非表示は必ず記録する',
  /admin_set_hidden[\s\S]{0,2000}?insert into public\.moderation_log[\s\S]{0,400}?case when p_hidden then 'force_hide' else 'restore' end/.test(schema));
check('しきい値の変更も必ず記録する',
  /admin_set_report_threshold[\s\S]{0,1400}?insert into public\.moderation_log[\s\S]{0,200}?'set_threshold'/.test(schema));
check('記録には変更前後の値を残す',
  /admin_set_hidden[\s\S]{0,2200}?old_value[\s\S]{0,400}?jsonb_build_object\('hidden', v_old\.hidden/.test(schema));
check('引数が増えた旧 admin_set_hidden を落としている',
  schema.includes('drop function if exists public.admin_set_hidden(uuid, boolean);'));
check('引数が増えた旧 admin_set_report_threshold を落としている',
  schema.includes('drop function if exists public.admin_set_report_threshold(int);'));

/* ---------------- 多言語 ----------------
   キーを 1 つの言語にだけ足すと、その言語だけ英語のまま出る。 */
console.log('\n多言語');
const localeKeys = {};
for (const lang of ['ja', 'en', 'ko']) {
  const src = fs.readFileSync(path.join(ROOT, `assets/js/locales/${lang}.js`), 'utf8');
  localeKeys[lang] = new Set((src.match(/^ {2}'[^']+':/gm) || []).map((m) => m.trim().slice(1, -2)));
}
const missingEn = [...localeKeys.ja].filter((k) => !localeKeys.en.has(k));
const missingKo = [...localeKeys.ja].filter((k) => !localeKeys.ko.has(k));
const extraEn = [...localeKeys.en].filter((k) => !localeKeys.ja.has(k));
check(`3 言語のキー数がそろっている（${localeKeys.ja.size} 件）`,
  localeKeys.ja.size === localeKeys.en.size && localeKeys.ja.size === localeKeys.ko.size,
  `ja ${localeKeys.ja.size} / en ${localeKeys.en.size} / ko ${localeKeys.ko.size}`);
check('en に足りないキーが無い', missingEn.length === 0, missingEn.join(', '));
check('ko に足りないキーが無い', missingKo.length === 0, missingKo.join(', '));
check('ja に無いキーが en に無い', extraEn.length === 0, extraEn.join(', '));
for (const key of ['community.report', 'community.reported', 'community.reportConfirm',
                   'community.reportDone', 'community.reportDup', 'community.edit',
                   'community.delete', 'community.editTitle', 'community.updated',
                   'community.deleteConfirm', 'community.deleted',
                   'err.noteTooLong', 'err.denied', 'err.rateLimit', 'err.network', 'err.unknown',
                   'community.showHidden', 'community.hiddenBadge', 'community.reportsCount',
                   'community.restore', 'community.forceHide', 'community.restoreConfirm',
                   'community.restored', 'community.forceHideConfirm', 'community.forceHidden',
                   'err.notAdmin',
                   'community.reportTitle', 'community.reportReason', 'community.reportDetail',
                   'community.reason.spam', 'community.reason.abuse', 'community.reason.misleading',
                   'community.reason.offtopic', 'community.reason.other',
                   'community.reasons', 'community.breakdownTitle', 'community.breakdownEmpty',
                   'community.modNotePh', 'community.modLog', 'community.modLogTitle',
                   'community.modLogEmpty', 'community.action.restore',
                   'community.action.force_hide', 'community.action.set_threshold',
                   'intro.title', 'intro.steps', 'intro.save', 'intro.cloud', 'intro.close',
                   'board.hintPlaceTouch', 'community.postDisclosure', 'feedback.link',
                   'share.xMatch', 'share.needRounds',
                   'board.zoom', 'board.zoomIn', 'board.zoomOut', 'board.zoomReset', 'board.hintPan',
                   'pick.legend', 'pick.scoreTitle', 'pick.scoreBase', 'pick.scoreTotal',
                   'reason.winrateThin', 'reason.recentUse', 'reason.rhythmChange', 'reason.openingKind',
                   'eval.title', 'eval.sub', 'eval.bar', 'eval.exec', 'eval.exec.clean',
                   'eval.exec.partial', 'eval.exec.failed', 'eval.exec.unrated', 'eval.broken',
                   'eval.reasons', 'eval.reasonsHint', 'eval.note', 'eval.notePh', 'eval.detail',
                   'eval.clear', 'eval.saved', 'eval.cleared',
                   'eval.reason.read', 'eval.reason.utility', 'eval.reason.entry', 'eval.reason.trade',
                   'eval.reason.numbers', 'eval.reason.preplant', 'eval.reason.postplant',
                   'eval.reason.counter', 'eval.reason.rotation', 'eval.reason.timing',
                   'eval.reason.comms', 'eval.reason.duel', 'eval.reason.outplay',
                   'eval.reason.planWorked', 'eval.reason.other']) {
  check(`${key} が 3 言語にある`,
    localeKeys.ja.has(key) && localeKeys.en.has(key) && localeKeys.ko.has(key));
}

/* ---------------- はじめて開いた人 / スマホ ----------------
   まっさらな状態のスマホで開いたときに、案内が出て、主要な操作が画面に収まること。
   別のコンテキストを作るので localStorage もまっさら。 */
console.log('\nはじめて開いた人 / スマホ');
const phone = await browser.newContext({
  viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, locale: 'ja-JP'
});
const mp = await phone.newPage();
mp.on('pageerror', (e) => pageErrors.push('[スマホ] ' + String(e.message)));
await mp.goto('file://' + DIST);
await mp.waitForTimeout(700);

check('初めて開くと案内が出る', await mp.locator('#intro-strip').isVisible());
const introText = await mp.locator('#intro-strip').innerText();
check('案内に使い方の順番が書いてある', /マッチ開始/.test(introText) && /①/.test(introText), introText.slice(0, 60));
check('案内に保存先が書いてある', /このブラウザに自動で保存/.test(introText), introText.slice(0, 80));
check('接続情報の無い版ではクラウド保存の一文を出さない', await mp.locator('#intro-cloud').isHidden());

check('スマホで横にはみ出さない',
  await mp.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2));

await mp.click('#btn-intro-close');
await mp.waitForTimeout(200);
check('「わかった」で案内が閉じる', await mp.locator('#intro-strip').isHidden());
await mp.reload();
await mp.waitForTimeout(700);
check('一度閉じた案内は次から出ない', await mp.locator('#intro-strip').isHidden());

/* 配置盤の編集画面。以前は高さしか見ておらず、幅 375px で 468px の盤面になって
   右にはみ出していた */
await mp.locator('#deck-grid button', { hasText: '配置を編集' }).first().click();
await mp.waitForTimeout(900);
const phoneBoard = await mp.evaluate(() => {
  const svg = document.querySelector('#board-canvas svg');
  const card = document.querySelector('#modal-board .modal-card');
  const r = svg ? svg.getBoundingClientRect() : null;
  const c = card.getBoundingClientRect();
  return {
    w: r ? Math.round(r.width) : 0,
    left: r ? Math.round(r.left) : -1,
    right: r ? Math.round(r.right) : 9999,
    cardRight: Math.round(c.right),
    vw: window.innerWidth,
    hint: document.getElementById('board-hint').textContent
  };
});
check('スマホでも配置盤が画面の中に収まる',
  phoneBoard.left >= 0 && phoneBoard.right <= phoneBoard.vw,
  `盤面 ${phoneBoard.w}px / 右端 ${phoneBoard.right} / 画面 ${phoneBoard.vw}`);
check('スマホでも配置盤のカードがはみ出さない', phoneBoard.cardRight <= phoneBoard.vw + 1,
  `${phoneBoard.cardRight} / ${phoneBoard.vw}`);
check('スマホでは右クリックではなくタップでの消し方を案内する',
  !/右クリック/.test(phoneBoard.hint) && /タップ/.test(phoneBoard.hint), phoneBoard.hint);
await phone.close();

/* PC のブラウザを細くしたときの条件（タッチではないので、長い方の案内文が出る）。
   本番で配置盤がはみ出していたのはこちら。長い 1 行の案内文がカードごと押し広げていた。
   スマホ向けの短い案内文だけを見ていると、この崩れは検出できない */
const narrow = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'ja-JP' });
const np = await narrow.newPage();
np.on('pageerror', (e) => pageErrors.push('[細い画面] ' + String(e.message)));
await np.goto('file://' + DIST);
await np.waitForTimeout(700);
await np.locator('#deck-grid button', { hasText: '配置を編集' }).first().click();
await np.waitForTimeout(900);
const narrowBoard = await np.evaluate(() => {
  const svg = document.querySelector('#board-canvas svg').getBoundingClientRect();
  const card = document.querySelector('#modal-board .modal-card').getBoundingClientRect();
  return { right: Math.round(svg.right), left: Math.round(svg.left), w: Math.round(svg.width),
           cardRight: Math.round(card.right), vw: window.innerWidth,
           hint: document.getElementById('board-hint').textContent };
});
check('細い PC 画面でも配置盤が画面の中に収まる',
  narrowBoard.left >= 0 && narrowBoard.right <= narrowBoard.vw,
  `盤面 ${narrowBoard.w}px / 右端 ${narrowBoard.right} / 画面 ${narrowBoard.vw}`);
check('細い PC 画面でも配置盤のカードがはみ出さない', narrowBoard.cardRight <= narrowBoard.vw + 1,
  `${narrowBoard.cardRight} / ${narrowBoard.vw}`);
check('細い PC 画面では右クリックの案内が出ている（長い方の文言で確かめている）',
  /右クリック/.test(narrowBoard.hint), narrowBoard.hint);
await narrow.close();

/* 縦 1 列になる幅（1180px 以下）で、エージェントとスキルの一覧が盤面に重ならないこと。
   一覧が自前でスクロールする箱だったため、高さが足りないと行が 0px に潰され、
   中身だけがはみ出して盤面の上に重なっていた。エージェントを選んだ後でないと
   一覧にボタンが並ばないので、構成を入れてから確かめる */
for (const [label, opts] of Object.entries({
  'タブレット幅 1024': { viewport: { width: 1024, height: 768 } },
  'スマホ幅 375': { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }
})) {
  const ctx2 = await browser.newContext({ ...opts, locale: 'ja-JP' });
  const tp = await ctx2.newPage();
  tp.on('pageerror', (e) => pageErrors.push(`[${label}] ` + String(e.message)));
  await tp.goto('file://' + DIST);
  await tp.waitForTimeout(600);
  await tp.evaluate(([a, e]) => {
    const S = window.VCT_STORE;
    a.forEach((x, i) => { S.state.allies[i].agent = x; });
    e.forEach((x, i) => { S.state.enemies[i].agent = x; });
    S.save();
  }, [ALLY, ENEMY]);
  await tp.reload();
  await tp.waitForTimeout(600);
  await tp.locator('#deck-grid button', { hasText: '配置を編集' }).first().click();
  await tp.waitForTimeout(900);
  const lay = await tp.evaluate(async () => {
    const R = (el) => el.getBoundingClientRect();
    const pal = R(document.getElementById('board-palette-ally'));
    const stage = R(document.querySelector('#modal-board .board-stage'));
    /* 一覧の中のボタンを画面の中に持ってきて、一番上にいる（押せる）かを見る。
       ボタンの中の絵やアイコンに当たった場合は、そのボタンに当たったものとして数える */
    const btns = [...document.querySelectorAll('#board-palette-ally .pal-agent, #board-palette-ally .pal-ability')];
    let covered = 0;
    for (const b of btns) {
      b.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 20));
      const r = b.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const hit = el && (el === b || b.contains(el) || (el.closest && el.closest('.pal-agent, .pal-ability') === b));
      if (!hit) covered++;
    }
    return { overlap: pal.bottom > stage.top + 1, buttons: btns.length, covered };
  });
  check(`${label}: エージェントとスキルの一覧が盤面に重ならない`, lay.overlap === false);
  check(`${label}: 一覧のボタンがすべて押せる位置にある`,
    lay.buttons > 0 && lay.covered === 0, `${lay.covered} / ${lay.buttons} 個が隠れている`);
  await ctx2.close();
}

/* PC では従来どおり右クリックの案内のまま */
const pcHint = await page.evaluate(() => window.VCT_I18N.t('board.hintPlace'));
check('PC 向けの案内は右クリックのまま', /右クリック/.test(pcHint), pcHint);

/* 投稿で何が公開されるか。プレビューには出ない構成まで公開されるので、投稿前に書いておく */
const disclosure = await page.evaluate(() => {
  const el = document.getElementById('post-disclosure');
  return el ? el.textContent : '';
});
check('投稿画面に公開される内容が書いてある',
  /構成/.test(disclosure) && /投稿者名/.test(disclosure) && /公開されません/.test(disclosure),
  disclosure.slice(0, 60));

/* ---------------- ご意見・不具合の報告 ----------------
   ユーザーテストの受け皿。リンク先は config.js の FEEDBACK_URL。
   初見の行動を歪めないよう、案内には出さずフッターにだけ置く */
console.log('\nご意見・不具合の報告');

async function feedbackState() {
  return page.evaluate(() => {
    const box = document.getElementById('app-feedback');
    const a = document.getElementById('feedback-link');
    const inFooter = !!(box && box.closest('footer.app-foot'));
    return {
      shown: !!(box && !box.hidden),
      inFooter,
      href: a ? a.getAttribute('href') : null,
      target: a ? a.getAttribute('target') : null,
      rel: a ? a.getAttribute('rel') || '' : '',
      text: a ? a.textContent : '',
      introMentions: /フォーム|ご意見|不具合|Feedback|feedback|의견/.test(
        (document.getElementById('intro-strip') || { innerText: '' }).innerText)
    };
  });
}

/* 設定済みの配布版と、空・不正な URL の変種をそれぞれ確認する */
const feedbackConfig = distHtml.match(/FEEDBACK_URL: '[^']*'/)?.[0];
if (!feedbackConfig) throw new Error('FEEDBACK_URL の設定が見つかりません');
await openVariant('feedback-live', []);
let liveFeedback = await feedbackState();
check('配布版に公開フォームのリンクが設定されている', liveFeedback.shown && liveFeedback.href === 'https://docs.google.com/forms/d/e/1FAIpQLSe8O_yRX6g6icSr0Q9Q15ySe3v6fbVPwUV9Rv9IfkaiUM4Z0w/viewform');
await openVariant('feedback-empty', [[feedbackConfig, "FEEDBACK_URL: ''"]]);
let fb = await feedbackState();
check('リンク先が空ならご意見のリンクを出さない', fb.shown === false);

const FORM = 'https://forms.gle/exampleForSmokeTest';
await openVariant('feedback-set', [[feedbackConfig, `FEEDBACK_URL: '${FORM}'`]]);
fb = await feedbackState();
check('リンク先があればフッターにご意見のリンクが出る', fb.shown === true && fb.inFooter === true);
check('ご意見のリンクは設定したフォームを指す', fb.href === FORM, String(fb.href));
check('ご意見のリンクは新しいタブで開く', fb.target === '_blank');
check('新しいタブから元のページを操作させない', /noopener/.test(fb.rel), fb.rel);
check('ご意見のリンクの文言が出ている', /ご意見/.test(fb.text), fb.text);
/* 初見の行動を歪めないため、最初の案内からは誘導しない */
check('最初の案内にはフォームへの誘導を書かない', fb.introMentions === false);

/* https:// 以外（打ち間違いや javascript:）は踏ませない */
await openVariant('feedback-bad', [[feedbackConfig, "FEEDBACK_URL: 'javascript:alert(1)'"]]);
fb = await feedbackState();
check('https:// で始まらないリンク先は出さない', fb.shown === false);

/* ---------------- 競技向けの手直し ----------------
   X 投稿の導線 / 盤面の局所ズーム / ラウンドの評価 / 推奨度の意味。
   前のセクションで config の変種を読み込んでいるので、
   素の配布版を別のコンテキストで開き直してから確かめる。 */
console.log('\n競技向けの手直し');

const gymCtx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: 'ja-JP' });
const g = await gymCtx.newPage();
g.on('pageerror', (e) => pageErrors.push('[競技UI] ' + String(e.message)));
g.on('dialog', (d) => { pageErrors.push('[競技UI] ネイティブダイアログ: ' + d.message()); d.dismiss(); });
await g.goto('file://' + DIST);
await g.waitForTimeout(600);

/** 味方・敵をそろえ、渡したラウンド記録を入れて開き直す */
async function seedMatch(rounds, phase) {
  await g.evaluate(([a, e, rs, ph]) => {
    const S = window.VCT_STORE;
    a.forEach((x, i) => { S.state.allies[i].agent = x; });
    e.forEach((x, i) => { S.state.enemies[i].agent = x; });
    S.state.rounds = rs;
    S.state.pending = null;
    S.state.sideOverrides = {};
    S.state.phase = ph || 'live';
    /* 盤面の拡大は局面ごとに残るので、次の確認へ持ち越さないよう全体表示に戻す */
    S.state.tactics.forEach((t) => (t.phases || []).forEach((p) => { delete p.view; }));
    S.save();
  }, [ALLY, ENEMY, rounds || [], phase || 'live']);
  await g.reload();
  await g.waitForTimeout(500);
}

/* 評価の列を持たない「古い形」のラウンド記録。互換性の確認にも使う */
function oldRound(n, tacticId, result) {
  return { n: n, side: 'ATK', tacticId: tacticId, economy: 'full', result: result, note: '', at: 1 };
}

const roundsOf = () => g.evaluate(() => window.VCT_STORE.state.rounds);
const clickIfEnabled = (sel) => g.evaluate((s) => {
  const el = document.querySelector(s);
  if (el && !el.disabled) el.click();
}, sel);

const sampleIds = await g.evaluate(() => window.VCT_STORE.state.tactics.map((t) => t.id));

/* --- X 投稿の導線 --- */
await seedMatch([oldRound(1, sampleIds[0], 'WIN')]);
check('ライブ画面に X への導線が無い',
  (await g.locator('#view-live [data-act="share-x"]').count()) === 0);

await seedMatch(Array.from({ length: 13 }, (_, i) => oldRound(i + 1, sampleIds[0], 'WIN')));
const bannerHTML = await g.locator('#match-banner').innerHTML();
check('決着バナーからも X への導線を外した', !/share-x/.test(bannerHTML), bannerHTML.slice(0, 90));
check('決着バナーの「新しいマッチ」は残っている', /btn-next-match/.test(bannerHTML));

await g.click('#btn-topmenu');
await g.waitForTimeout(200);
const xMenu = await g.evaluate(() => {
  const btn = document.getElementById('btn-share-x');
  const pop = document.getElementById('topmenu-pop');
  const r = btn.getBoundingClientRect();
  return {
    inMenu: !!(btn && pop && pop.contains(btn)),
    disabled: btn.disabled,
    text: btn.textContent,
    inTopbar: !!btn.closest('.topbar'),
    visible: r.width > 0 && r.height > 0
  };
});
check('X へのポストは ⋯ メニューの中にある', xMenu.inMenu && xMenu.inTopbar);
check('X へのポストの文言で試合結果だと分かる', /試合結果/.test(xMenu.text), xMenu.text);
check('記録があるときは押せる', xMenu.disabled === false);
await g.keyboard.press('Escape');

await seedMatch([], 'setup');
await g.click('#btn-topmenu');
await g.waitForTimeout(200);
check('記録が無いときは押せない',
  await g.evaluate(() => document.getElementById('btn-share-x').disabled));
await g.keyboard.press('Escape');

await seedMatch([oldRound(1, sampleIds[0], 'WIN'), oldRound(2, sampleIds[1], 'LOSS')]);
const xOpen = await g.evaluate(() => {
  let captured = null;
  const orig = window.open;
  window.open = function (url) { captured = url; return null; };
  document.getElementById('btn-topmenu').click();
  document.getElementById('btn-share-x').click();
  window.open = orig;
  return {
    captured: captured,
    text: window.VCT_SHARE.buildMatchText({
      map: window.VCT_STORE.state.match.map,
      score: window.VCT_STORE.score(),
      rounds: window.VCT_STORE.state.rounds,
      tactics: window.VCT_STORE.state.tactics
    })
  };
});
check('X へのポストは今までどおり intent を開く',
  /^https:\/\/x\.com\/intent\/tweet\?/.test(String(xOpen.captured)), String(xOpen.captured).slice(0, 70));
check('ポスト本文は試合全体の要約になっている',
  /1-1/.test(xOpen.text) && /W/.test(xOpen.text), xOpen.text.replace(/\n/g, ' / '));

/* --- 盤面の局所ズーム --- */
async function openBoardEditor() {
  await g.evaluate(() => { window.VCT_STORE.state.phase = 'setup'; window.VCT_STORE.save(); });
  await g.reload();
  await g.waitForTimeout(500);
  await g.locator('#deck-grid button', { hasText: '配置を編集' }).first().click();
  await g.waitForTimeout(800);
}

const viewBoxOf = () => g.evaluate(() => {
  const svg = document.querySelector('#board-canvas svg');
  if (!svg) return null;
  const b = svg.viewBox.baseVal;
  return { x: b.x, y: b.y, w: b.width, h: b.height, zoom: Number(svg.getAttribute('data-zoom')) };
});
const boardMarks = () => g.evaluate(() => {
  const S = window.VCT_STORE;
  const p = window.VCT_BOARD.phaseAt(S.state.tactics[0], 0);
  return p.marks.map((m) => ({ kind: m.kind, x: m.x, y: m.y }));
});
const insideBoard = (v) => v.x >= -0.01 && v.y >= -0.01 && v.x + v.w <= 100.01 && v.y + v.h <= 100.01;
const maxZoom = await g.evaluate(() => window.VCT_BOARD.MAX_ZOOM);

await openBoardEditor();
let vbox = await viewBoxOf();
check('既定は全体表示', vbox.zoom === 1 && vbox.w === 100 && vbox.x === 0, JSON.stringify(vbox));
check('全体表示では縮小と「全体表示」は押せない',
  await g.evaluate(() => document.querySelector('[data-board-act="zoom-out"]').disabled &&
                         document.querySelector('[data-board-act="zoom-reset"]').disabled));

await clickIfEnabled('[data-board-act="zoom-in"]');
await g.waitForTimeout(250);
vbox = await viewBoxOf();
check('＋で拡大できる', vbox.zoom > 1 && vbox.w < 100, JSON.stringify(vbox));
check('拡大しても盤面の外は映さない', insideBoard(vbox), JSON.stringify(vbox));

for (let i = 0; i < 8; i++) { await clickIfEnabled('[data-board-act="zoom-in"]'); await g.waitForTimeout(90); }
vbox = await viewBoxOf();
check('拡大には上限がある', vbox.zoom <= maxZoom + 0.001, String(vbox.zoom));
check('上限まで拡大しても盤面の外は映さない', insideBoard(vbox), JSON.stringify(vbox));

await clickIfEnabled('[data-board-act="zoom-reset"]');
await g.waitForTimeout(250);
check('「全体表示」で戻せる', (await viewBoxOf()).zoom === 1);

await clickIfEnabled('[data-board-act="zoom-in"]');
await clickIfEnabled('[data-board-act="zoom-in"]');
await g.waitForTimeout(250);
const panBefore = await viewBoxOf();
let bbox = await g.locator('#board-canvas svg').boundingBox();
await g.mouse.move(bbox.x + bbox.width * 0.5, bbox.y + bbox.height * 0.5);
await g.mouse.down();
await g.mouse.move(bbox.x + bbox.width * 0.25, bbox.y + bbox.height * 0.25, { steps: 8 });
await g.mouse.up();
await g.waitForTimeout(250);
const panAfter = await viewBoxOf();
check('拡大中は何も無い所のドラッグで表示位置が動く',
  Math.abs(panAfter.x - panBefore.x) > 1 || Math.abs(panAfter.y - panBefore.y) > 1,
  `${JSON.stringify(panBefore)} → ${JSON.stringify(panAfter)}`);
check('パンしても倍率は変わらない', Math.abs(panAfter.zoom - panBefore.zoom) < 0.001);
check('パンしても盤面の外は映さない', insideBoard(panAfter), JSON.stringify(panAfter));

for (let i = 0; i < 5; i++) {
  await g.mouse.move(bbox.x + bbox.width * 0.2, bbox.y + bbox.height * 0.2);
  await g.mouse.down();
  await g.mouse.move(bbox.x + bbox.width * 0.95, bbox.y + bbox.height * 0.95, { steps: 5 });
  await g.mouse.up();
}
await g.waitForTimeout(250);
check('端まで動かしても盤面の外は映さない', insideBoard(await viewBoxOf()), JSON.stringify(await viewBoxOf()));

/* 拡大中に置いたものが、クリックした場所と一致すること（ここがズレると使い物にならない） */
const zoomView = await viewBoxOf();
bbox = await g.locator('#board-canvas svg').boundingBox();
await g.locator('#board-palette-ally .pal-agent').first().click();
await g.waitForTimeout(200);
await g.mouse.click(bbox.x + bbox.width * 0.3, bbox.y + bbox.height * 0.65);
await g.waitForTimeout(300);
const placed = (await boardMarks())[0];
const wantPlace = { x: zoomView.x + zoomView.w * 0.3, y: zoomView.y + zoomView.h * 0.65 };
check('拡大中に置いても座標がズレない',
  !!placed && Math.abs(placed.x - wantPlace.x) < 1.5 && Math.abs(placed.y - wantPlace.y) < 1.5,
  `置いた ${JSON.stringify(placed)} / 期待 ${JSON.stringify(wantPlace)}`);

await clickIfEnabled('[data-board-act="disarm"]');
await g.waitForTimeout(200);
await g.mouse.click(bbox.x + bbox.width * 0.3, bbox.y + bbox.height * 0.65);
await g.waitForTimeout(250);
check('拡大中でもマークを選べる',
  await g.evaluate(() => !!document.querySelector('#board-canvas .board-mark.is-selected')));

/* 選ぶと道具の行が 1 段増えて盤面が少し縮む。
   ここで測り直さないと、ドラッグ先の期待値の方がずれる */
const markBox = await g.locator('#board-canvas .board-mark').first().boundingBox();
bbox = await g.locator('#board-canvas svg').boundingBox();
const zoomView2 = await viewBoxOf();
await g.mouse.move(markBox.x + markBox.width / 2, markBox.y + markBox.height / 2);
await g.mouse.down();
await g.mouse.move(bbox.x + bbox.width * 0.6, bbox.y + bbox.height * 0.4, { steps: 8 });
await g.mouse.up();
await g.waitForTimeout(250);
const dragged = (await boardMarks())[0];
const wantDrag = { x: zoomView2.x + zoomView2.w * 0.6, y: zoomView2.y + zoomView2.h * 0.4 };
check('拡大中でもドラッグで動かせて、座標がズレない',
  !!dragged && Math.abs(dragged.x - wantDrag.x) < 1.5 && Math.abs(dragged.y - wantDrag.y) < 1.5,
  `動かした ${JSON.stringify(dragged)} / 期待 ${JSON.stringify(wantDrag)}`);

await clickIfEnabled('[data-board-act="delete-mark"]');
await g.waitForTimeout(250);
check('拡大中でも選んだマークを消せる', (await boardMarks()).length === 0);

const savedView = await g.evaluate(() => {
  const p = window.VCT_BOARD.phaseAt(window.VCT_STORE.state.tactics[0], 0);
  return p.view || null;
});
check('拡大の状態は局面ごとに保存される', !!savedView && savedView.zoom > 1, JSON.stringify(savedView));
await g.reload();
await g.waitForTimeout(600);
await g.locator('#deck-grid button', { hasText: '配置を編集' }).first().click();
await g.waitForTimeout(800);
check('再読み込みしても拡大の状態が残る',
  Math.abs((await viewBoxOf()).zoom - savedView.zoom) < 0.01, JSON.stringify(await viewBoxOf()));

await g.locator('.stage-add').click();
await g.waitForTimeout(400);
check('新しい局面は全体表示から始まる', (await viewBoxOf()).zoom === 1);
await g.locator('#board-phases .stage-tab').first().click();
await g.waitForTimeout(300);
check('局面を戻すと拡大の状態も戻る', (await viewBoxOf()).zoom > 1);

/* 古いデータ・壊れた値 */
await g.evaluate(() => {
  const S = window.VCT_STORE;
  S.state.tactics[0].phases[0].view = { zoom: 99, cx: -40, cy: 500 };
  delete S.state.tactics[1].phases[0].view;
  S.save();
});
await g.reload();
await g.waitForTimeout(600);
const viewsAfterLoad = await g.evaluate(() => {
  const B = window.VCT_BOARD, S = window.VCT_STORE;
  return {
    broken: B.view(B.phaseAt(S.state.tactics[0], 0)),
    old: B.view(B.phaseAt(S.state.tactics[1], 0)),
    savedOld: S.state.tactics[1].phases[0].view === undefined
  };
});
check('壊れた拡大設定は読み込み時に範囲内へ直す',
  viewsAfterLoad.broken.zoom <= maxZoom && viewsAfterLoad.broken.cx >= 12 && viewsAfterLoad.broken.cy <= 88,
  JSON.stringify(viewsAfterLoad.broken));
check('拡大設定を持たない古い戦術は全体表示のまま',
  viewsAfterLoad.old.zoom === 1 && viewsAfterLoad.savedOld);

/* ライブ画面からも戻せること（編集画面で寄せた範囲がそのまま出るため） */
await seedMatch([]);
await g.locator('[data-act="pick"]').first().click();
await g.waitForTimeout(400);
check('ライブ画面の配置盤にも拡大の操作がある',
  (await g.locator('.board-panel [data-act="zoom-in"]').count()) === 1);
await g.locator('.board-panel [data-act="zoom-in"]').click();
await g.waitForTimeout(300);
const liveZoom = () => g.evaluate(() => {
  const S = window.VCT_STORE, B = window.VCT_BOARD;
  return B.view(B.phaseAt(S.tacticById(S.state.pending.tacticId), 0)).zoom;
});
check('ライブ画面から拡大できる', (await liveZoom()) > 1);
await g.locator('.board-panel [data-act="zoom-reset"]').click();
await g.waitForTimeout(300);
check('ライブ画面から全体表示へ戻せる', (await liveZoom()) === 1);

/* 画面の広さ違い。スマホでは指の操作でも動くこと */
for (const [label, opts] of Object.entries({
  'スマホ幅 375': { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
  '広い画面 1440': { viewport: { width: 1440, height: 900 } }
})) {
  const ctx3 = await browser.newContext({ ...opts, locale: 'ja-JP' });
  const zp = await ctx3.newPage();
  zp.on('pageerror', (e) => pageErrors.push(`[${label}] ` + String(e.message)));
  await zp.goto('file://' + DIST);
  await zp.waitForTimeout(600);
  await zp.evaluate(([a, e]) => {
    const S = window.VCT_STORE;
    a.forEach((x, i) => { S.state.allies[i].agent = x; });
    e.forEach((x, i) => { S.state.enemies[i].agent = x; });
    S.save();
  }, [ALLY, ENEMY]);
  await zp.reload();
  await zp.waitForTimeout(600);
  await zp.locator('#deck-grid button', { hasText: '配置を編集' }).first().click();
  await zp.waitForTimeout(900);

  const zoomBtn = await zp.evaluate(() => {
    const b = document.querySelector('[data-board-act="zoom-in"]');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      size: r.width > 0 && r.height > 0,
      hit: !!(el && (el === b || b.contains(el))),
      inView: r.left >= 0 && r.right <= window.innerWidth
    };
  });
  check(`${label}: 拡大ボタンが押せる位置にある`,
    !!zoomBtn && zoomBtn.size && zoomBtn.hit && zoomBtn.inView, JSON.stringify(zoomBtn));

  await zp.evaluate(() => {
    for (let i = 0; i < 3; i++) {
      const b = document.querySelector('[data-board-act="zoom-in"]');
      if (b && !b.disabled) b.click();
    }
  });
  await zp.waitForTimeout(400);
  const zoomFit = await zp.evaluate(() => {
    const svg = document.querySelector('#board-canvas svg');
    const r = svg.getBoundingClientRect();
    const card = document.querySelector('#modal-board .modal-card').getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), cardRight: Math.round(card.right),
             vw: window.innerWidth, zoom: Number(svg.getAttribute('data-zoom')) };
  });
  check(`${label}: 拡大が効いている`, zoomFit.zoom > 1, String(zoomFit.zoom));
  check(`${label}: 拡大しても盤面が画面に収まる`,
    zoomFit.left >= 0 && zoomFit.right <= zoomFit.vw + 1 && zoomFit.cardRight <= zoomFit.vw + 1,
    JSON.stringify(zoomFit));

  if (opts.hasTouch) {
    /* 全体表示から 2 本指で広げられること（上限に張り付いた状態では確かめられない） */
    await zp.evaluate(() => {
      const b = document.querySelector('[data-board-act="zoom-reset"]');
      if (b && !b.disabled) b.click();
    });
    await zp.waitForTimeout(300);
    const pinch = await zp.evaluate(() => {
      const el = document.getElementById('board-canvas');
      const svg = el.querySelector('svg');
      const r = svg.getBoundingClientRect();
      const before = Number(svg.getAttribute('data-zoom'));
      const fire = (type, id, x, y) => el.dispatchEvent(new PointerEvent(type, {
        pointerId: id, clientX: x, clientY: y, bubbles: true, button: 0, buttons: 1,
        isPrimary: id === 1, pointerType: 'touch'
      }));
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      fire('pointerdown', 1, cx - 20, cy);
      fire('pointerdown', 2, cx + 20, cy);
      fire('pointermove', 2, cx + 70, cy);
      fire('pointerup', 2, cx + 70, cy);
      fire('pointerup', 1, cx - 20, cy);
      return { before: before, after: Number(document.querySelector('#board-canvas svg').getAttribute('data-zoom')) };
    });
    check('スマホ: 2 本指で拡大できる', pinch.after > pinch.before, JSON.stringify(pinch));

    const touchPan = await zp.evaluate(() => {
      const el = document.getElementById('board-canvas');
      const svg = el.querySelector('svg');
      const r = svg.getBoundingClientRect();
      const before = svg.viewBox.baseVal.x;
      const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, clientX: x, clientY: y, bubbles: true, button: 0, buttons: 1,
        isPrimary: true, pointerType: 'touch'
      }));
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      fire('pointerdown', cx, cy);
      fire('pointermove', cx - 40, cy);
      fire('pointermove', cx - 80, cy);
      fire('pointerup', cx - 80, cy);
      return { before: before, after: document.querySelector('#board-canvas svg').viewBox.baseVal.x };
    });
    check('スマホ: 拡大中は 1 本指のドラッグで表示位置が動く',
      Math.abs(touchPan.after - touchPan.before) > 0.5, JSON.stringify(touchPan));
  }
  await ctx3.close();
}

/* --- ラウンドの評価 --- */
await seedMatch([]);
await g.locator('[data-act="pick"]').first().click();
await g.waitForTimeout(300);
await g.locator('[data-act="result"][data-result="WIN"]').click();
await g.waitForTimeout(400);
check('勝敗を押すと評価バーが出る', (await g.locator('.eval-bar').count()) === 1);
check('未評価のあいだは目立たせる',
  await g.evaluate(() => document.querySelector('.eval-bar').classList.contains('is-todo')));
await g.locator('[data-act="eval-exec"][data-exec="clean"]').click();
await g.waitForTimeout(300);
let evalRounds = await roundsOf();
check('1 タップで遂行度を記録できる', evalRounds[0].exec === 'clean', JSON.stringify(evalRounds[0]));
check('評価しても勝敗は変わらない', evalRounds[0].result === 'WIN');

await g.locator('[data-act="eval-open"]').click();
await g.waitForTimeout(400);
check('理由の入力欄が開く', await g.locator('#modal-round-eval').isVisible());
check('遂行度は 4 段階', (await g.locator('#eval-exec button').count()) === 4);
check('理由の選択肢が 15 個ある', (await g.locator('#eval-reasons input').count()) === 15);
check('その他を選ぶまで補足欄は出ない', await g.locator('#eval-note-field').isHidden());
await g.locator('#eval-reasons input[value="read"]').check();
await g.locator('#eval-reasons input[value="utility"]').check();
await g.locator('#eval-reasons input[value="other"]').check();
await g.waitForTimeout(200);
check('その他を選ぶと補足欄が出る', await g.locator('#eval-note-field').isVisible());
await g.fill('#eval-note', 'スモークが 1 枚足りなかった');
await g.locator('#round-eval-form button[type="submit"]').click();
await g.waitForTimeout(400);
evalRounds = await roundsOf();
check('理由を複数選べる',
  evalRounds[0].reasons.length === 3 && evalRounds[0].reasons.indexOf('read') >= 0 &&
  evalRounds[0].reasons.indexOf('utility') >= 0, JSON.stringify(evalRounds[0].reasons));
check('その他の補足が残る',
  evalRounds[0].reasonNote === 'スモークが 1 枚足りなかった', evalRounds[0].reasonNote);

await g.reload();
await g.waitForTimeout(600);
evalRounds = await roundsOf();
check('再読み込みしても評価が残る',
  evalRounds[0].exec === 'clean' && evalRounds[0].reasons.length === 3 &&
  evalRounds[0].reasonNote.length > 0);

await g.locator('[data-act="pick"]').first().click();
await g.waitForTimeout(300);
await g.locator('[data-act="result"][data-result="LOSS"]').click();
await g.waitForTimeout(400);
evalRounds = await roundsOf();
check('新しいラウンドは未評価から始まる', evalRounds[1].exec === 'unrated');
await g.locator('#timeline [data-eval-round="2"]').click();
await g.waitForTimeout(400);
check('ラウンド履歴からあとで評価できる', await g.locator('#modal-round-eval').isVisible());
await g.locator('#eval-exec button[data-val="failed"]').click();
await g.locator('#round-eval-form button[type="submit"]').click();
await g.waitForTimeout(400);
evalRounds = await roundsOf();
check('敗北ラウンドにも遂行度を記録できる',
  evalRounds[1].exec === 'failed' && evalRounds[1].result === 'LOSS');

await g.locator('#btn-undo').click();
await g.waitForTimeout(400);
evalRounds = await roundsOf();
check('取り消すと評価ごと消える', evalRounds.length === 1 && evalRounds[0].n === 1);
check('取り消すと戦術が選び直せる状態に戻る',
  await g.evaluate(() => !!window.VCT_STORE.state.pending));
await g.locator('[data-act="result"][data-result="WIN"]').click();
await g.waitForTimeout(400);
evalRounds = await roundsOf();
check('入れ直したラウンドは未評価から始まる',
  evalRounds[1].exec === 'unrated' && evalRounds[1].reasons.length === 0);
check('取り消しても前のラウンドの評価は残っている', evalRounds[0].exec === 'clean');

const exportedJSON = await g.evaluate(() => window.VCT_STORE.exportJSON());
const exportedObj = JSON.parse(exportedJSON);
check('書き出しに評価が含まれる',
  exportedObj.rounds[0].exec === 'clean' && exportedObj.rounds[0].reasons.length === 3 &&
  typeof exportedObj.rounds[0].reasonNote === 'string');
const roundTrip = await g.evaluate((json) => {
  const S = window.VCT_STORE;
  S.resetAll();
  S.importJSON(json);
  return S.state.rounds;
}, exportedJSON);
check('読み込むと評価も戻る',
  roundTrip[0].exec === 'clean' && roundTrip[0].reasons.length === 3 && roundTrip[0].reasonNote.length > 0);
check('クラウド保存は書き出しと同じ内容を送っている',
  /C\.saveSetup\(name, JSON\.parse\(S\.exportJSON\(\)\)\)/.test(distHtml) &&
  /C\.updateSetup\(saved\.id, saved\.name, JSON\.parse\(S\.exportJSON\(\)\)\)/.test(distHtml));

await seedMatch([oldRound(1, sampleIds[0], 'WIN'), oldRound(2, sampleIds[0], 'LOSS')]);
evalRounds = await roundsOf();
check('評価を持たない古い記録は未評価として読める',
  evalRounds.length === 2 && evalRounds[0].exec === 'unrated' &&
  Array.isArray(evalRounds[0].reasons) && evalRounds[0].reasons.length === 0);
check('古い記録でもラウンド履歴が壊れない', (await g.locator('#timeline .tl-row').count()) === 2);

const execSplit = await g.evaluate((tid) => {
  const S = window.VCT_STORE;
  S.setRoundEval(1, { exec: 'clean' });
  S.setRoundEval(2, { exec: 'failed' });
  return S.statsFor(tid);
}, sampleIds[0]);
check('作戦通りに動けたラウンドだけの勝率が取れる',
  execSplit.cleanUsed === 1 && execSplit.cleanWinRate === 100, JSON.stringify(execSplit.byExec));
check('崩れたラウンドの勝率も別に取れる',
  execSplit.brokenUsed === 1 && execSplit.brokenWinRate === 0);
check('全体の勝率とは別の数字として持っている',
  execSplit.winRate === 50 && execSplit.ratedUsed === 2);
await g.reload();
await g.waitForTimeout(600);
check('戦術別成績に遂行度の内訳が出る', (await g.locator('.perf-splits').count()) >= 1);

/* --- 推奨度（カードの数値と色）--- */
const advisorCfg = await g.evaluate(() => ({
  base: window.VCT_ADVISOR.BASE_SCORE,
  good: window.VCT_ADVISOR.TONE_GOOD,
  bad: window.VCT_ADVISOR.TONE_BAD,
  weights: window.VCT_ADVISOR.WEIGHTS
}));
check('基準点と色の境目がコードから読める',
  advisorCfg.base === 50 && advisorCfg.good > advisorCfg.bad &&
  typeof advisorCfg.weights.lastLoss === 'number', JSON.stringify(advisorCfg).slice(0, 120));

const rankedRows = await g.evaluate(() =>
  window.VCT_ADVISOR.rank({ side: window.VCT_STORE.sideForRound(window.VCT_STORE.currentRoundNumber()) })
    .map((r) => ({ score: r.score, base: r.base, tone: r.tone, deltas: r.reasons.map((x) => x.delta) })));
check('内訳の合計が表示している数値と一致する', rankedRows.every((r) => {
  const sum = r.deltas.reduce((a, x) => a + (x || 0), 0);
  return Math.max(0, Math.min(100, r.base + sum)) === r.score;
}), JSON.stringify(rankedRows).slice(0, 160));
check('色は決められた境目どおりに付く', rankedRows.every((r) =>
  r.tone === (r.score >= advisorCfg.good ? 'good' : (r.score <= advisorCfg.bad ? 'bad' : 'warn'))),
  JSON.stringify(rankedRows.map((r) => [r.score, r.tone])).slice(0, 160));
check('同じ状態なら同じ数値になる', await g.evaluate(() => {
  const A = window.VCT_ADVISOR;
  const a = JSON.stringify(A.rank({ side: 'ATK' }).map((r) => [r.tactic.id, r.score]));
  const b = JSON.stringify(A.rank({ side: 'ATK' }).map((r) => [r.tactic.id, r.score]));
  return a === b;
}));

const evalEffect = await g.evaluate(() => {
  const S = window.VCT_STORE, A = window.VCT_ADVISOR;
  const before = JSON.stringify(A.rank({ side: 'ATK' }).map((r) => r.score));
  S.setRoundEval(1, { exec: 'failed', reasons: ['read'] });
  const after = JSON.stringify(A.rank({ side: 'ATK' }).map((r) => r.score));
  S.setRoundEval(1, { exec: 'clean', reasons: [] });
  return { before: before, after: after };
});
check('ラウンド評価は推奨度に混ぜていない', evalEffect.before === evalEffect.after);

const factorRow = await g.evaluate(() => {
  const S = window.VCT_STORE, A = window.VCT_ADVISOR;
  const id = S.state.tactics[0].id;
  /* 同じ戦術で 2 連敗した直後、という状況を作る */
  S.state.rounds = [
    { n: 1, side: 'ATK', tacticId: id, economy: 'full', result: 'LOSS', exec: 'unrated', reasons: [], reasonNote: '', at: 1 },
    { n: 2, side: 'ATK', tacticId: id, economy: 'full', result: 'LOSS', exec: 'unrated', reasons: [], reasonNote: '', at: 2 }
  ];
  S.state.pending = null;
  S.save();
  const rows = A.rank({ side: 'ATK' });
  const used = rows.filter((r) => r.tactic.id === id)[0];
  const unused = rows.filter((r) => r.stats.used === 0)[0];
  const by = {};
  used.reasons.forEach((x) => { by[x.key] = x.delta; });
  const byUnused = {};
  if (unused) unused.reasons.forEach((x) => { byUnused[x.key] = x.delta; });
  return { by: by, byUnused: byUnused, score: used.score, tone: used.tone };
});
check('直前に負けた同じ戦術は決めた重みだけ下がる',
  factorRow.by['reason.lastLoss'] === advisorCfg.weights.lastLoss, JSON.stringify(factorRow.by));
check('連投は連投数ぶん下がる',
  factorRow.by['reason.streak'] === advisorCfg.weights.streakPerRound * 2, JSON.stringify(factorRow.by));
check('この試合の勝率も内訳に出る',
  factorRow.by['reason.winrateBad'] === Math.round((0 - 50) * advisorCfg.weights.winRateFactor),
  JSON.stringify(factorRow.by));
check('未使用の戦術には未使用ぶんの加点が出る',
  factorRow.byUnused['reason.unused'] === advisorCfg.weights.unused, JSON.stringify(factorRow.byUnused));
check('下がりきった戦術は赤になる', factorRow.tone === 'bad' && factorRow.score <= advisorCfg.bad,
  `${factorRow.score} / ${factorRow.tone}`);

await g.reload();
await g.waitForTimeout(600);
const scoreUI = await g.evaluate(() => {
  const pick = document.querySelector('.pick');
  const delta = document.querySelector('.pick .pick-reasons .reason .reason-delta');
  const legend = document.querySelector('.pick-legend');
  const label = document.querySelector('.pick .pick-score small');
  return {
    delta: delta ? delta.textContent : null,
    title: pick ? pick.getAttribute('title') : '',
    legend: legend ? legend.textContent : '',
    label: label ? label.textContent : ''
  };
});
check('カードに加点・減点の数字が出る', /^[+−]\d+$/.test(String(scoreUI.delta)), String(scoreUI.delta));
check('内訳と合計をその場で読める',
  /基準点/.test(scoreUI.title) && /合計/.test(scoreUI.title), String(scoreUI.title).slice(0, 70));
check('数値の意味と色の意味が画面に書いてある',
  /勝率や成功確率ではありません/.test(scoreUI.legend) && /緑/.test(scoreUI.legend) &&
  /黄/.test(scoreUI.legend) && /赤/.test(scoreUI.legend), scoreUI.legend.slice(0, 60));
check('見出しは「推奨度」で確率とは書いていない',
  scoreUI.label === '推奨度', scoreUI.label);

const legends = await g.evaluate(() => {
  const I = window.VCT_I18N;
  const cur = I.get();
  const out = {};
  ['ja', 'en', 'ko'].forEach((l) => {
    I.set(l);
    out[l] = { legend: I.t('pick.legend'), label: I.t('pick.score') };
  });
  I.set(cur);
  return out;
});
check('英語でも成功確率ではないと書いてある',
  /not a win rate or a success probability/i.test(legends.en.legend), legends.en.legend.slice(0, 80));
check('韓国語でも成功確率ではないと書いてある',
  /승률이나 성공 확률이 아닙니다/.test(legends.ko.legend));
check('見出しの語も確率を名乗っていない',
  legends.ja.label === '推奨度' && legends.en.label === 'FIT' && !/probability|SCORE/i.test(legends.en.label),
  JSON.stringify(legends.en));

await gymCtx.close();

/* ---------------- まとめ ---------------- */
check('ページ内で例外が出ていない', pageErrors.length === 0, pageErrors.join(' / '));

await browser.close();

console.log(`\n${passed} 件 ok / ${failures.length} 件 NG`);
if (failures.length) {
  console.log('\n落ちたもの:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}

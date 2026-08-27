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
page.on('dialog', (d) => d.accept());

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

/* ---------------- 配置盤を開く ---------------- */
console.log('\n配置盤');
for (let i = 0; i < 5; i++) {
  await page.click(`#slots-ally .slot[data-index="${i}"]`);
  await page.click(`.agent-opt[data-agent="${ALLY[i]}"]`);
  await page.click(`#slots-enemy .slot[data-index="${i}"]`);
  await page.click(`.agent-opt[data-agent="${ENEMY[i]}"]`);
}

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

/* ---------------- まとめ ---------------- */
check('ページ内で例外が出ていない', pageErrors.length === 0, pageErrors.join(' / '));

await browser.close();

console.log(`\n${passed} 件 ok / ${failures.length} 件 NG`);
if (failures.length) {
  console.log('\n落ちたもの:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}

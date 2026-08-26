#!/usr/bin/env node
/* =========================================================
   公式アセット取得ツール
   ---------------------------------------------------------
   Riot の公式ゲームアセットを valorant-api.com（コミュニティ運営の
   公開ミラー）から取得し、エージェントアイコンとマップのミニマップを
   アプリに取り込む。

   使い方:
     node tools/fetch-assets.mjs            # 画像ファイルとして保存（推奨）
     node tools/fetch-assets.mjs --inline   # エージェントアイコンを data URI で埋め込む
                                            # （単一 HTML 配布版でも公式画像を使いたい場合）

   生成/更新されるもの:
     assets/img/agents/<id>.png
     assets/img/maps/<id>.png
     assets/js/official-assets.js   ← 上記を読み込ませる自動生成ファイル

   実行後に `node build.js` を走らせると配布ファイルにも反映される。

   注意: 画像は Riot Games の著作物です。ファンプロジェクトでの利用は
   Riot の「Legal Jibber Jabber」ポリシーに従ってください。商用利用や
   広告収益を伴う配信を行う場合は、事前に条件を確認することを推奨します。
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 古い Node では fetch が無く、原因の分かりにくいエラーになるので先に案内する */
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18 || typeof fetch !== 'function') {
  console.error(
    `このツールには Node.js 18 以上が必要です（今お使いのバージョン: ${process.versions.node}）。\n` +
    'https://nodejs.org/ja から最新版をインストールしてから、もう一度実行してください。'
  );
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const API = 'https://valorant-api.com/v1';
const INLINE = process.argv.includes('--inline');

const AGENT_DIR = path.join(ROOT, 'assets/img/agents');
const ABILITY_DIR = path.join(ROOT, 'assets/img/abilities');

/* API のスロット名 → アプリのキー割り当て */
const SLOT_MAP = { Grenade: 'C', Ability2: 'Q', Ability1: 'E', Ultimate: 'X' };

/* アビリティ名を取り込む言語。locales/ にある言語に合わせる */
const NAME_LANGS = { ja: 'ja-JP', en: 'en-US', ko: 'ko-KR' };
const MAP_DIR = path.join(ROOT, 'assets/img/maps');
const OUT_FILE = path.join(ROOT, 'assets/js/official-assets.js');

/** アプリが持っているエージェント / マップの id を data.js から読む。
    配列ごとに切り出してから走査する（全体を正規表現でなめると
    AGENTS と MAPS が混ざる）。 */
function idsFromDataJs() {
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/data.js'), 'utf8');

  const sliceArray = (declaration) => {
    const start = src.indexOf(declaration);
    if (start < 0) throw new Error(`data.js に ${declaration} が見つかりません`);
    const from = src.indexOf('[', start);
    const to = src.indexOf('\n  ];', from);
    if (from < 0 || to < 0) throw new Error(`${declaration} の配列を読み取れません`);
    return src.slice(from, to);
  };

  const parse = (block) =>
    [...block.matchAll(/\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)'/g)]
      .map(([, id, name]) => ({ id, name }));

  return {
    agents: parse(sliceArray('const AGENTS =')),
    maps: parse(sliceArray('const MAPS ='))
  };
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/* 公式画像は 1024x1024 で配信されており、38px のアイコンには大きすぎる。
   sharp があれば自動で縮小し、無ければ警告だけ出す。 */
let sharp = null;
let sharpChecked = false;
async function getSharp() {
  if (sharpChecked) return sharp;
  sharpChecked = true;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    sharp = null;
  }
  return sharp;
}

let oversized = 0;

async function download(url, dest, resizeTo) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  let buf = Buffer.from(await res.arrayBuffer());

  if (resizeTo) {
    const lib = await getSharp();
    if (lib) {
      buf = await lib(buf)
        .trim()
        .resize(resizeTo, resizeTo, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer();
    } else if (buf.length > 200 * 1024) {
      oversized++;
    }
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf;
}

/** API の表示名をアプリ側の id に対応づける */
function normalize(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main() {
  const { agents: wanted, maps: wantedMaps } = idsFromDataJs();
  console.log(`data.js のエージェント ${wanted.length} 体 / マップ ${wantedMaps.length} 種を対象にします`);

  const agentEntries = {};
  const mapEntries = {};
  const abilityIcons = {};
  const abilityNames = {};
  const missing = [];

  /* ---------- エージェント ---------- */
  const agentsRes = await getJSON(`${API}/agents?isPlayableCharacter=true`);
  const byName = new Map(agentsRes.data.map((a) => [normalize(a.displayName), a]));

  for (const want of wanted) {
    const found = byName.get(normalize(want.name)) || byName.get(normalize(want.id));
    if (!found) { missing.push(`agent:${want.id}`); continue; }

    const url = found.displayIconSmall || found.displayIcon;
    if (!url) { missing.push(`agent-icon:${want.id}`); continue; }

    const dest = path.join(AGENT_DIR, `${want.id}.png`);
    const buf = await download(url, dest, 192);
    agentEntries[want.id] = INLINE
      ? `data:image/png;base64,${buf.toString('base64')}`
      : `assets/img/agents/${want.id}.png`;
    console.log(`  agent  ${want.id.padEnd(10)} ${(buf.length / 1024).toFixed(0)} KB`);

    /* アビリティのアイコン */
    for (const ability of found.abilities ?? []) {
      const slot = SLOT_MAP[ability.slot];
      if (!slot || !ability.displayIcon) continue;
      const key = `${want.id}:${slot}`;
      const iconDest = path.join(ABILITY_DIR, `${want.id}_${slot}.png`);
      try {
        const iconBuf = await download(ability.displayIcon, iconDest, 96);
        abilityIcons[key] = INLINE
          ? `data:image/png;base64,${iconBuf.toString('base64')}`
          : `assets/img/abilities/${want.id}_${slot}.png`;
      } catch {
        missing.push(`ability-icon:${key}`);
      }
    }
  }

  /* アビリティ名を言語ごとに取り込む */
  for (const [appLang, apiLang] of Object.entries(NAME_LANGS)) {
    try {
      const res = await getJSON(`${API}/agents?isPlayableCharacter=true&language=${apiLang}`);
      const byId = new Map(res.data.map((a) => [a.uuid, a]));
      abilityNames[appLang] = {};
      for (const want of wanted) {
        const base = byName.get(normalize(want.name)) || byName.get(normalize(want.id));
        const localized = base ? byId.get(base.uuid) : null;
        if (!localized) continue;
        for (const ability of localized.abilities ?? []) {
          const slot = SLOT_MAP[ability.slot];
          if (!slot || !ability.displayName) continue;
          abilityNames[appLang][`${want.id}:${slot}`] = ability.displayName;
        }
      }
      console.log(`  names  ${appLang.padEnd(10)} ${Object.keys(abilityNames[appLang]).length} 件`);
    } catch (err) {
      console.log(`  ! ${appLang} のアビリティ名を取得できませんでした: ${err.message}`);
    }
  }

  /* API 側にあってアプリに無いエージェントを知らせる（新エージェント検出） */
  const knownIds = new Set(wanted.map((w) => normalize(w.name)));
  const extra = agentsRes.data.filter((a) => !knownIds.has(normalize(a.displayName)));
  if (extra.length) {
    console.log('\n⚠ data.js に未登録のエージェントが API 側にあります:');
    extra.forEach((a) => console.log(`   ${a.displayName} (${a.role?.displayName ?? '-'})`));
  }

  /* ---------- マップ ---------- */
  const mapsRes = await getJSON(`${API}/maps`);
  const mapByName = new Map(mapsRes.data.map((m) => [normalize(m.displayName), m]));

  /* API 側にあってアプリに無いマップを知らせる（新マップ検出）。
     対戦で使わないもの（射撃場など）は tacticalDescription を持たないので除く。 */
  const knownMapIds = new Set(wantedMaps.map((w) => normalize(w.name)));
  const extraMaps = mapsRes.data.filter(
    (m) => m.tacticalDescription && !knownMapIds.has(normalize(m.displayName))
  );
  if (extraMaps.length) {
    console.log('\n⚠ data.js に未登録のマップが API 側にあります:');
    extraMaps.forEach((m) => console.log(`   ${m.displayName}`));
  }

  for (const want of wantedMaps) {
    const found = mapByName.get(normalize(want.name));
    if (!found || !found.displayIcon) { missing.push(`map:${want.id}`); continue; }
    const dest = path.join(MAP_DIR, `${want.id}.png`);
    const buf = await download(found.displayIcon, dest, 512);
    /* ミニマップは 1 枚が大きいので、常にファイル参照にする */
    mapEntries[want.id] = `assets/img/maps/${want.id}.png`;
    console.log(`  map    ${want.id.padEnd(10)} ${(buf.length / 1024).toFixed(0)} KB`);
  }

  /* ---------- 生成 ---------- */
  const out = `/* =========================================================
   OFFICIAL ASSETS （自動生成 — 直接編集しないこと）
   生成日時: ${new Date().toISOString()}
   生成コマンド: node tools/fetch-assets.mjs${INLINE ? ' --inline' : ''}
   出典: Riot Games / valorant-api.com
   ========================================================= */
(function (global) {
  'use strict';
  const AGENTS = ${JSON.stringify(agentEntries, null, 2)};
  const MAPS = ${JSON.stringify(mapEntries, null, 2)};
  const ABILITY_ICONS = ${JSON.stringify(abilityIcons, null, 2)};
  const ABILITY_NAMES = ${JSON.stringify(abilityNames, null, 2)};

  if (global.VCT_PORTRAITS) Object.assign(global.VCT_PORTRAITS.OFFICIAL, AGENTS);
  if (global.VCT_MAPS) Object.assign(global.VCT_MAPS.MINIMAP, MAPS);
  if (global.VCT_ABILITIES) {
    Object.assign(global.VCT_ABILITIES.OFFICIAL_ICONS, ABILITY_ICONS);
    Object.assign(global.VCT_ABILITIES.OFFICIAL_NAMES, ABILITY_NAMES);
  }
})(window);
`;
  fs.writeFileSync(OUT_FILE, out);

  console.log(`\n✓ ${Object.keys(agentEntries).length} 体のアイコン / ${Object.keys(mapEntries).length} 枚のミニマップ / ` +
              `${Object.keys(abilityIcons).length} 個のスキルアイコンを取り込みました`);
  console.log(`  → ${path.relative(ROOT, OUT_FILE)}`);
  if (missing.length) console.log('  取得できなかったもの:', missing.join(', '));
  if (oversized) {
    console.log(`\n⚠ ${oversized} 枚の画像が大きいままです（1 枚あたり 200KB 超）。`);
    console.log('  そのままでも動きますが、単一 HTML 版が重くなります。');
    console.log('  `npm install sharp` を実行してからもう一度このツールを走らせると、自動で縮小されます。');
  }
  if (extra.length || extraMaps.length) {
    console.log('\n⚠ 未登録のものがあります。上の一覧を Claude に伝えると追加できます。');
  }
  if (!INLINE) {
    console.log('\n  単一 HTML 配布版にも公式アイコンを載せたい場合は --inline を付けて再実行してください。');
  }
  console.log('  最後に `node build.js` を実行して配布ファイルを更新してください。');
}

main().catch((err) => {
  console.error('\n取得に失敗しました:', err.message);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|403|EAI_AGAIN/.test(err.message)) {
    console.error(
      'valorant-api.com に接続できませんでした。次のいずれかが原因のことが多いです:\n' +
      '  - インターネットに繋がっていない\n' +
      '  - 会社や学校のネットワークが外部への通信を制限している\n' +
      '  - VPN やセキュリティソフトが通信を遮断している\n' +
      'ブラウザで https://valorant-api.com/v1/agents を開けるか確認してみてください。'
    );
  }
  process.exit(1);
});

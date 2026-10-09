/* =========================================================
   定石ライブラリを作る
   ---------------------------------------------------------
   戦術（tactics/<map>.json）と座標（callouts/<map>.json）から、
   アプリが読む assets/js/tactics-library.js を書き出す。

     node tools/build-library.mjs          # 書き出す
     node tools/build-library.mjs --check  # 書き出さず、問題だけ報告する

   読むのは共通知識基盤（正本）。置き場所は tools/kb-paths.mjs が決める。
   出力は自動生成物。手で編集しない（official-assets.js と同じ扱い）。
   知識データを直したら、これ → node build.js の順で作り直す。
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, knowledgePath, useLegacy } from './kb-paths.mjs';

/* --out <path> で書き出し先を変えられる（確認用に別の場所へ作るとき。アプリが読む本体を触らずに済む） */
const outArg = process.argv.indexOf('--out');
const OUT = outArg >= 0 && process.argv[outArg + 1]
  ? path.resolve(process.argv[outArg + 1])
  : path.join(ROOT, 'assets', 'js', 'tactics-library.js');
const checkOnly = process.argv.includes('--check');

const readJSON = function (p) { return JSON.parse(fs.readFileSync(p, 'utf8')); };

/* エージェント・マップ・戦術タイプの一覧はアプリ本体を正本にする */
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'js', 'data.js'), 'utf8'), sandbox);
const D = sandbox.window.VCT_DATA;
const AGENT_IDS = D.AGENTS.map(function (a) { return a.id; });
const KIND_IDS = D.KINDS.map(function (k) { return k.id; });
const SLOTS = ['C', 'Q', 'E', 'X'];

const patch = readJSON(knowledgePath('PATCH.json'));
const aliasFile = knowledgePath('callouts', '_aliases.json');
const ALIASES = fs.existsSync(aliasFile) ? readJSON(aliasFile) : {};

const problems = [];
const warn = function (msg) { problems.push(msg); };

/* 名前の揺れを吸収する。"A-Main" "a main" "A Main." を同じものとして扱う */
const norm = function (s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
};

/* マップごとの「名前 → 座標」。公式の名前に、別名（_aliases.json）を重ねる。
   別名の値は公式の名前（文字列）か、座標そのもの { x, y }。
   公式データに無い場所（ヘブン下など）や、公式の座標がおかしい場所の直しに使う。 */
function calloutTable(mapId) {
  const file = knowledgePath('callouts', mapId + '.json');
  const table = {};
  if (!fs.existsSync(file)) return table;
  readJSON(file).callouts.forEach(function (c) { table[norm(c.name)] = { x: c.x, y: c.y }; });

  const layers = [ALIASES['*'] || {}, ALIASES[mapId] || {}];
  layers.forEach(function (layer) {
    Object.keys(layer).forEach(function (name) {
      const v = layer[name];
      if (v && typeof v === 'object') table[norm(name)] = { x: v.x, y: v.y };
      else if (table[norm(v)]) table[norm(name)] = table[norm(v)];
      else warn(mapId + ': 別名 "' + name + '" の指す先 "' + v + '" が見つからない');
    });
  });
  return table;
}

/* [x, y]（0-100）の形で直接書かれた位置 */
function xy(v) {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const x = Number(v[0]), y = Number(v[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) return null;
  return { x: x, y: y };
}

function resolve(table, name) {
  if (!name) return null;
  return table[norm(name)] || null;
}

/* 歩ける床の範囲（tools/build-floor-mask.mjs が作る）。
   場所の名前の座標や、重なり避けのずらしで、マークが壁の中やマップの外に落ちることがある。
   床の外に出たら最寄りの床へ寄せる。寄せた件数は最後に報告する。 */
let snapped = 0;
function floorSnapper(mapId) {
  const file = knowledgePath('callouts', '_floor', mapId + '.json');
  if (!fs.existsSync(file)) return function (p) { return p; };
  const mask = readJSON(file);
  const k = mask.size / 100;
  const on = function (x, y) {
    const cx = Math.round(x * k), cy = Math.round(y * k);
    return cy >= 0 && cy < mask.size && cx >= 0 && cx < mask.size && mask.rows[cy][cx] === '1';
  };
  /* 縁ぎりぎりだとマークの半分が壁にかかるので、周りも床である所を選ぶ */
  const clear = function (x, y) { return on(x, y) && on(x + 0.8, y) && on(x - 0.8, y) && on(x, y + 0.8) && on(x, y - 0.8); };
  return function (p) {
    if (clear(p.x, p.y)) return p;
    for (let r = 0.5; r <= 9; r += 0.5) {
      for (let a = 0; a < 24; a++) {
        const x = p.x + Math.cos(a * Math.PI / 12) * r, y = p.y + Math.sin(a * Math.PI / 12) * r;
        if (clear(x, y)) { snapped++; return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }; }
      }
    }
    return p;   /* 近くに床が無い（座標そのものがおかしい）。そのまま出して目で気づけるようにする */
  };
}

/* 同じ場所に重なったマークを少しずつずらす。
   重なったままだと下のマークが見えず、掴めもしない */
function spreader() {
  const used = [];
  return function (p) {
    let x = p.x, y = p.y, n = 0;
    while (used.some(function (u) { return Math.abs(u.x - x) < 3.2 && Math.abs(u.y - y) < 3.2; }) && n < 12) {
      n++;
      const ang = n * 2.4;                    /* 黄金角ずつ回すと偏らずに広がる */
      const rad = 2.2 + n * 0.9;
      x = p.x + Math.cos(ang) * rad;
      y = p.y + Math.sin(ang) * rad;
    }
    x = Math.max(2, Math.min(98, Math.round(x * 10) / 10));
    y = Math.max(2, Math.min(98, Math.round(y * 10) / 10));
    used.push({ x: x, y: y });
    return { x: x, y: y };
  };
}

/* 手順（steps）から配置盤を 1 枚作る。
   立ち位置が分かる人はエージェントとして、スキルは落ちる場所へ使用順つきで置く。 */
function buildPhase(mapId, tac, table, missing) {
  const spread = spreader();
  const snap = floorSnapper(mapId);
  const place = function (p) { return snap(spread(p)); };
  const marks = [];
  const stood = {};
  const order = {};

  (Array.isArray(tac.steps) ? tac.steps : []).forEach(function (s) {
    const agent = AGENT_IDS.indexOf(s.agent) >= 0 ? s.agent : null;
    if (!agent) return;
    /* 実戦の映像から読んだ位置（at_xy / from_xy）があればそちらを使う。
       場所の名前は広い範囲を指すので、名前の中心に置くと実際の位置からずれる */
    const at = xy(s.at_xy) || resolve(table, s.at);
    const from = xy(s.from_xy) || resolve(table, s.from);
    if (s.at && !at) missing[s.at] = (missing[s.at] || 0) + 1;
    if (s.from && !from) missing[s.from] = (missing[s.from] || 0) + 1;

    const slot = SLOTS.indexOf(s.ability) >= 0 ? s.ability : null;
    const stand = slot ? from : (from || at);
    if (stand && !stood[agent]) {
      stood[agent] = true;
      const p = place(stand);
      marks.push({ kind: 'agent', ref: agent, team: 'ally', x: p.x, y: p.y, order: null });
    }
    if (slot && at) {
      order[agent] = (order[agent] || 0) + 1;
      const p = place(at);
      marks.push({ kind: 'ability', ref: agent + ':' + slot, team: 'ally', x: p.x, y: p.y, order: order[agent] });
    }
  });

  if (tac.side === 'ATK' && tac.plant) {
    /* 設置位置。公式データの「◯ Site」は設置場所の中心ではない（通路に落ちるマップもある）ので、
       映像から読んだ位置 → マップごとの設置位置（◯ Plant）→ ◯ Site の順に探す */
    const site = xy(tac.plant_xy) || resolve(table, tac.site + ' Plant') || resolve(table, tac.site + ' Site');
    if (site) {
      const p = place(site);
      marks.push({ kind: 'plant', ref: 'spike', team: 'ally', x: p.x, y: p.y, order: null });
    }
  }
  /* 進んだ経路（映像から読んだ折れ線）。あれば盤面に線として出す */
  const routes = (Array.isArray(tac.routes_xy) ? tac.routes_xy : []).slice(0, 6).map(function (line) {
    const points = (Array.isArray(line) ? line : []).map(xy).filter(Boolean).slice(0, 12);
    return points.length >= 2 ? { team: 'ally', points: points } : null;
  }).filter(Boolean);

  return marks.length ? { name: '', marks: marks, routes: routes } : null;
}

const text = function (obj, max) {
  const src = obj && typeof obj === 'object' ? obj : {};
  const out = {};
  ['ja', 'en', 'ko'].forEach(function (lang) {
    if (typeof src[lang] === 'string' && src[lang].trim()) out[lang] = src[lang].trim().slice(0, max);
  });
  return out;
};

/* 根拠レベル。
     A = 2026 年の公式大会映像で確認（knowledge/evidence/ に証拠がある）
     B = 解説資料ベース（実戦確認はしていない）
     C = 一般型・未検証
   A は証拠（大会・チーム・ラウンド・映像の時刻）が実際に入っているときだけ付ける。
   evidence ファイルに level: "A" と書いてあるだけでは信用しない。 */
function evidenceFor(mapId) {
  const file = knowledgePath('evidence', mapId + '.json');
  if (!fs.existsSync(file)) return {};
  const data = readJSON(file);
  const vods = {};
  (data.vods || []).forEach(function (v) { vods[v.id] = v; });
  const out = {};
  (data.verifications || []).forEach(function (v) {
    /* 実戦で一貫して別のやり方が見えたものは、ライブラリに載せない（データは knowledge/ に残す） */
    if (v.result === 'contradicted') { out[v.key] = { drop: true }; return; }
    if (v.result !== 'confirmed' && v.result !== 'variant') return;
    const proofs = (v.evidence || []).map(function (e) {
      const vod = vods[e.vod] || {};
      const url = String(e.youtube || '');
      const ok = /^https:\/\/(youtu\.be|www\.youtube\.com)\//.test(url) && /[?&]t=\d+/.test(url) &&
                 Number.isFinite(Number(e.round)) && e.team && e.opponent && vod.event;
      if (!ok) { warn(mapId + '/' + v.key + ': 証拠の項目が足りない（大会・チーム・相手・ラウンド・時刻つき URL）'); return null; }
      /* 確認日は証拠ごとに持てる（あとから足した証拠は、マップ全体の確認日より新しい） */
      return { ev: vod.event, team: e.team, opp: e.opponent, r: Number(e.round), url: url, on: e.checked_on || data.checked_on || '', id: e.vod + '#' + e.round, patch: vod.patch || '' };
    }).filter(Boolean);
    if (!proofs.length) return;
    /* 画面に並べる試合は 3 つまでだが、ラウンド数は全部を数える（同じラウンドを 2 回数えない） */
    const ids = {};
    proofs.forEach(function (p) { ids[p.id] = true; });
    const patches = proofs.map(function (p) { return p.patch; }).filter(Boolean);
    out[v.key] = {
      variant: v.result === 'variant',
      rounds: Object.keys(ids).length,
      patch: patches.length ? patches[0] : '',
      proofs: proofs.slice(0, 3).map(function (p) { return { ev: p.ev, team: p.team, opp: p.opp, r: p.r, url: p.url, on: p.on }; })
    };
  });
  return out;
}

const maps = {};
let total = 0, withBoard = 0;
const levels = { A: 0, B: 0, C: 0 };
let dropped = 0;

/* 公開する根拠レベル（publish.json）。いまは ✓（A）だけを出す。
   解説資料ベース（B）と一般型（C）はデータとして持っているが、画面には出さない。
   出すレベルを増やすときは、このファイルを直すだけでよい（コードに埋めない）。 */
const publishFile = knowledgePath('publish.json');
const PUBLISH = fs.existsSync(publishFile) ? (readJSON(publishFile).levels || ['A', 'B', 'C']) : ['A', 'B', 'C'];
let withheld = 0;

/* 載せるのを見合わせている戦術（knowledge/exclude.json）。理由はそのファイルに書いてある */
const excludeFile = knowledgePath('exclude.json');
const EXCLUDE = fs.existsSync(excludeFile) ? (readJSON(excludeFile).keys || {}) : {};
let held = 0;

fs.readdirSync(knowledgePath('tactics')).filter(function (f) { return /\.json$/.test(f); }).sort().forEach(function (f) {
  const data = readJSON(knowledgePath('tactics', f));
  const mapId = data.map;
  const map = D.mapById(mapId);
  if (!map) { warn(f + ': 知らないマップ "' + mapId + '"'); return; }

  const table = calloutTable(mapId);
  const proven = evidenceFor(mapId);
  Object.keys(proven).forEach(function (key) {
    if (!(data.tactics || []).some(function (t) { return t.key === key; })) {
      warn(mapId + ': 証拠の key "' + key + '" が戦術データに無い');
    }
  });
  const missing = {};
  const seen = {};
  const list = [];

  (data.tactics || []).forEach(function (tac) {
    const where = mapId + '/' + tac.key;
    if (!tac.key || seen[tac.key]) { warn(where + ': key が無いか重複している'); return; }
    seen[tac.key] = true;
    if (tac.side !== 'ATK' && tac.side !== 'DEF') { warn(where + ': side が不正'); return; }
    if (KIND_IDS.indexOf(tac.kind) < 0) { warn(where + ': kind "' + tac.kind + '" が不正'); return; }
    const site = String(tac.site || '').toUpperCase();
    if (site !== 'MID' && map.sites.indexOf(site) < 0) { warn(where + ': site "' + tac.site + '" がこのマップに無い'); return; }

    if (proven[tac.key] && proven[tac.key].drop) { dropped++; return; }
    if (EXCLUDE[tac.key]) { held++; return; }

    const name = text(tac.name, 60);
    const note = text(tac.note, 400);
    if (!name.ja || !name.en) { warn(where + ': name の ja / en が揃っていない'); return; }

    const agents = (tac.agents_typical || []).filter(function (a) { return AGENT_IDS.indexOf(a) >= 0; });
    (tac.agents_typical || []).forEach(function (a) {
      if (AGENT_IDS.indexOf(a) < 0) warn(where + ': 知らないエージェント "' + a + '"');
    });

    const phase = buildPhase(mapId, Object.assign({}, tac, { site: site }), table, missing);

    const proof = proven[tac.key];
    const lv = proof ? 'A' : (tac.confidence === 'medium' || tac.confidence === 'high' ? 'B' : 'C');
    levels[lv]++;
    if (PUBLISH.indexOf(lv) < 0) { withheld++; return; }
    if (phase) withBoard++;
    total++;

    list.push(Object.assign({
      key: tac.key, side: tac.side, site: site, kind: tac.kind,
      name: name, note: note,
      needs: (tac.needs || []).slice(0, 8),
      agents: agents.slice(0, 5),
      lv: lv
    }, proof ? { rounds: proof.rounds, patch: proof.patch || String(tac.patch_verified || ''), proofs: proof.proofs } : {},
       proof && proof.variant ? { variant: true } : {},
       phase ? { phases: [phase] } : {}));
  });

  /* 実戦で確認できたものを先に並べる（同じレベルの中は元の順のまま） */
  const rank = { A: 0, B: 1, C: 2 };
  list.sort(function (a, b) { return rank[a.lv] - rank[b.lv]; });

  const names = Object.keys(missing).sort(function (a, b) { return missing[b] - missing[a]; });
  if (names.length) {
    warn(mapId + ': 座標に直せない場所が ' + names.length + ' 種類 — ' +
         names.map(function (n) { return n + '×' + missing[n]; }).join(', '));
  }
  maps[mapId] = list;
});

const out = {
  levels: PUBLISH,
  patch: patch.latest_patch,
  checkedAt: patch.checked_at,
  pool: patch.map_pool,
  maps: maps
};

console.log('公開する戦術 ' + total + ' 件（配置盤つき ' + withBoard + ' 件） / マップ ' + Object.keys(maps).length);
console.log('根拠: A 実戦確認 ' + levels.A + ' / B 解説資料 ' + levels.B + ' / C 一般型 ' + levels.C +
            (dropped ? ' / 実戦と食い違うため除外 ' + dropped : '') +
            (held ? ' / 見合わせ（exclude.json） ' + held : ''));
console.log('公開するレベル: ' + PUBLISH.join(', ') + (withheld ? '（出さない ' + withheld + ' 件）' : ''));
if (snapped) console.log('床の外に出たマークを最寄りの床へ寄せた: ' + snapped + ' 個');
problems.forEach(function (p) { console.log('  ! ' + p); });

if (!checkOnly) {
  const banner = '/* 自動生成（tools/build-library.mjs）。手で編集しない。\n' +
                 '   元データは knowledge/ 。確認パッチ ' + out.patch + ' / ' + out.checkedAt + ' */\n';
  fs.writeFileSync(OUT, banner + 'window.VCT_LIBRARY = ' + JSON.stringify(out) + ';\n');
  console.log('→ ' + path.relative(ROOT, OUT) + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
}

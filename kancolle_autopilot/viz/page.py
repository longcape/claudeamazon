"""サンドボックスを操作するページ。

外部の CSS も JS も読み込まない 1 枚の HTML。画面は配置表をそのまま
描いていて、**クリックは座標として送る**。AI が通るのと同じ当たり判定を
人間も通るので、配置の間違いは触れば分かる。
"""

from __future__ import annotations

PLAY_PAGE = """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>艦これ Auto-Pilot サンドボックス</title>
<style>
:root {
  --bg:#f6f7f9; --panel:#fff; --line:#d8dce3; --text:#1c2330; --muted:#667085;
  --accent:#2f6fed; --bad:#c33b3b; --good:#2e7d4f; --warn:#c9721a;
}
@media (prefers-color-scheme: dark) {
  :root { --bg:#14171c; --panel:#1c2027; --line:#2c323b; --text:#e6e9ef;
    --muted:#98a2b3; --accent:#6ea0ff; --bad:#ef7676; --good:#6fcf97; --warn:#e0a458; }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:13px/1.6 system-ui,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif}
header{padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel);
  display:flex;gap:14px;align-items:center;flex-wrap:wrap}
header h1{font-size:14px;margin:0}
main{display:grid;grid-template-columns:1fr minmax(300px,380px);gap:12px;padding:12px}
@media (max-width:980px){main{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px}
.panel h2{font-size:11px;margin:0;padding:7px 12px;border-bottom:1px solid var(--line);
  color:var(--muted);letter-spacing:.04em}
.panel .body{padding:10px 12px}
svg{width:100%;height:auto;display:block;background:color-mix(in srgb,var(--text) 6%,transparent);
  cursor:crosshair;border-radius:0 0 8px 8px}
.widget{fill:color-mix(in srgb,var(--accent) 14%,transparent);stroke:var(--line)}
.widget:hover{fill:color-mix(in srgb,var(--accent) 40%,transparent);stroke:var(--accent)}
.wlabel{font-size:9px;fill:var(--muted);pointer-events:none}
.cursor{fill:var(--bad);pointer-events:none}
.right{display:flex;flex-direction:column;gap:12px}
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:1px 10px}
dt{color:var(--muted)}
dd{margin:0}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:1px 6px;border-bottom:1px solid var(--line)}
th{color:var(--muted)}
#log{max-height:24vh;overflow-y:auto;font-family:ui-monospace,Menlo,monospace;
  font-size:11px;white-space:pre-wrap}
button,select,input{font:inherit;padding:4px 9px;border-radius:6px;
  border:1px solid var(--line);background:var(--bg);color:var(--text)}
button{cursor:pointer}
button:hover{border-color:var(--accent)}
.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
.stop{color:var(--bad);font-weight:600}
.ok{color:var(--good)}
.warn{color:var(--warn)}
.hint{color:var(--muted);font-size:11px}
</style>
</head>
<body>
<header>
  <h1>サンドボックス操作</h1>
  <span id="screen" class="hint"></span>
  <span id="safety" class="hint"></span>
  <span style="flex:1"></span>
  <a href="/report.html" target="_blank"><button>記録をレポートで見る</button></a>
  <button id="reset">最初から</button>
</header>
<main>
  <section class="panel">
    <h2>Game View — クリックすると座標として送られます</h2>
    <svg id="view" viewBox="0 0 760 560"></svg>
    <div class="body">
      <div class="row">
        <button id="tick">AI に 1 周任せる</button>
        <select id="taskName">
          <option value="sortie">出撃</option>
          <option value="advance">進撃</option>
          <option value="supply">補給</option>
          <option value="repair">入渠</option>
          <option value="expedition">遠征</option>
          <option value="construction">建造</option>
          <option value="collect_expedition">遠征の受け取り</option>
          <option value="collect_build">建造艦の受け取り</option>
        </select>
        <input id="taskPayload" size="34" value='{"map":"1-5","fleet_id":1}'>
        <button id="runTask">AI に実行させる</button>
        <button id="enqueue">キューへ</button>
      </div>
      <div class="row">
        <input id="command" size="24" placeholder="status / stop / resume / queue">
        <button id="sendCommand">コマンド</button>
        <span class="hint" id="selection"></span>
      </div>
    </div>
  </section>
  <div class="right">
    <section class="panel"><h2>状態</h2><div class="body" id="state"></div></section>
    <section class="panel"><h2>安全判定</h2><div class="body" id="safetyBody"></div></section>
    <section class="panel"><h2>待機タスク</h2><div class="body" id="queue"></div></section>
    <section class="panel"><h2>操作ログ</h2><div class="body" id="log"></div></section>
  </div>
</main>
<script>
const view = document.getElementById("view");
let snap = null;

async function call(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: {"Content-Type": "application/json"},
    body: body ? JSON.stringify(body) : undefined,
  });
  snap = await res.json();
  render();
}

function drawView() {
  const parts = [];
  (snap.widgets || []).forEach(w => {
    parts.push('<rect class="widget" x="' + w.x + '" y="' + w.y + '" width="' + w.w +
      '" height="' + w.h + '" rx="4"><title>' + w.name + "</title></rect>");
    parts.push('<text class="wlabel" x="' + (w.x + 4) + '" y="' + (w.y + 13) + '">' +
      w.name + "</text>");
  });
  const c = snap.cursor;
  if (c) parts.push('<circle class="cursor" cx="' + c.x + '" cy="' + c.y + '" r="5"></circle>');
  view.innerHTML = parts.join("");
}

function drawState() {
  const s = snap.state, g = snap.game;
  const rows = s["艦"].map(x =>
    "<tr><td>#" + x.id + "</td><td>Lv" + x.lv + "</td><td>" + x.hp + "</td><td>" +
    x["状態"] + "</td><td>" + x["ロック"] + "</td></tr>").join("");
  document.getElementById("state").innerHTML =
    "<dl>" + Object.entries(s["資材"]).map(([k, v]) => "<dt>" + k + "</dt><dd>" + v + "</dd>").join("") +
    "<dt>戦果</dt><dd>" + g["戦果"] + "</dd>" +
    "<dt>出撃</dt><dd>" + (g["出撃"] ? g["出撃"] + " セル" + g["セル"] : "-") + "</dd>" +
    "<dt>直近戦闘</dt><dd>" + (g["直近戦闘"] || "-") + "</dd>" +
    "<dt>ゲージ</dt><dd>" + Object.entries(g["ゲージ"]).map(([k, v]) => k + " " + v).join(" ") + "</dd>" +
    "</dl><table><tr><th>艦</th><th>Lv</th><th>HP</th><th>状態</th><th>ロック</th></tr>" +
    rows + "</table>";
}

function drawSafety() {
  const v = snap.safety;
  const cls = v.level === "STOP" ? "stop" : (v.level === "WARNING" ? "warn" : "ok");
  document.getElementById("safety").innerHTML =
    '安全 <span class="' + cls + '">' + v.level + "</span>";
  document.getElementById("safetyBody").innerHTML =
    '<p class="' + cls + '" style="margin:0 0 6px">' + v.level +
    (v.stopped ? "（緊急停止中）" : "") + "</p>" +
    (v.reasons.length ? "<ul style='margin:0;padding-left:18px'>" +
      v.reasons.map(r => "<li>" + r + "</li>").join("") + "</ul>" : "") +
    (v.pending.length ? '<p class="stop" style="margin:6px 0 0">保護待ち: ' +
      v.pending.join(", ") + "</p>" : "");
}

function render() {
  document.getElementById("screen").textContent = "画面 " + snap.screen;
  document.getElementById("selection").textContent =
    "選択中 " + (JSON.stringify(snap.selection) || "{}");
  document.getElementById("queue").innerHTML = snap.queue.length
    ? "<ol style='margin:0;padding-left:18px'>" +
      snap.queue.map(t => "<li>" + t + "</li>").join("") + "</ol>"
    : '<span class="hint">なし</span>';
  document.getElementById("log").textContent = snap.log.join("\\n");
  const box = document.getElementById("log");
  box.scrollTop = box.scrollHeight;
  drawView(); drawState(); drawSafety();
}

view.addEventListener("click", (event) => {
  const box = view.getBoundingClientRect();
  const x = Math.round((event.clientX - box.left) / box.width * 760);
  const y = Math.round((event.clientY - box.top) / box.height * 560);
  call("/api/click", {x, y});
});

function payload() {
  const raw = document.getElementById("taskPayload").value.trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { alert("payload が JSON ではありません"); throw e; }
}

document.getElementById("tick").onclick = () => call("/api/tick", {});
document.getElementById("runTask").onclick = () =>
  call("/api/task", {name: document.getElementById("taskName").value, payload: payload()});
document.getElementById("enqueue").onclick = () =>
  call("/api/enqueue", {name: document.getElementById("taskName").value, payload: payload()});
document.getElementById("sendCommand").onclick = () => {
  const text = document.getElementById("command").value.trim();
  if (text) call("/api/command", {text});
};
document.getElementById("command").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("sendCommand").click();
});
document.getElementById("reset").onclick = () => call("/api/reset", {});

call("/api/state");
</script>
</body>
</html>
"""

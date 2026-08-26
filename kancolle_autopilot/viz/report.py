"""記録から自己完結の HTML レポートを作る。

追加指示書 §9（可視化）・§14（リプレイ）・§16（Debug Mode）に対応する。
GUI ツールキットは使わず、ブラウザで開ける 1 枚の HTML を吐く。外部の
CSS も JS も読み込まないので、記録ごと持ち歩ける。

表示するもの:

* **Game View** … その時点の画面と、配置されている操作対象、カーソルの軌跡
* **Timeline / Event Log** … 全イベント。クリックでその位置へ飛ぶ
* **AI Decision View** … 直近の判断と、期待と実際の食い違い
* **GameState View** … その時点のスナップショット

再生は記録された時刻差を保つ。等間隔で送ると、連打と待ちの区別が消える。
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Mapping, Sequence

from core.persistence import write_text_atomic
from monitor.game_state import GameState
from recording.decision_log import Decision
from recording.recorder import SessionRecorder
from recording.timeline import Timeline
from viz.model import ReportData, build_data

logger = logging.getLogger(__name__)

_TEMPLATE = """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --line: #d8dce3; --text: #1c2330;
  --muted: #667085; --accent: #2f6fed; --warn: #c9721a; --bad: #c33b3b;
  --good: #2e7d4f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171c; --panel: #1c2027; --line: #2c323b; --text: #e6e9ef;
    --muted: #98a2b3; --accent: #6ea0ff; --warn: #e0a458; --bad: #ef7676;
    --good: #6fcf97;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 13px/1.6 system-ui, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
}
header {
  padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel);
  display: flex; flex-wrap: wrap; gap: 16px; align-items: baseline;
}
header h1 { font-size: 15px; margin: 0; }
header .stat { color: var(--muted); font-size: 12px; }
header .bad { color: var(--bad); }
main { display: grid; grid-template-columns: minmax(280px, 380px) 1fr; gap: 12px; padding: 12px; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; } }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.panel h2 {
  font-size: 12px; margin: 0; padding: 8px 12px; border-bottom: 1px solid var(--line);
  color: var(--muted); font-weight: 600; letter-spacing: .04em;
}
.panel .body { padding: 10px 12px; }
#timeline { max-height: 62vh; overflow-y: auto; }
#timeline ol { list-style: none; margin: 0; padding: 0; }
#timeline li {
  padding: 3px 12px; cursor: pointer; display: flex; gap: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  border-left: 3px solid transparent;
}
#timeline li:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
#timeline li.now { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); }
#timeline li.past { opacity: .55; }
#timeline .k { color: var(--muted); min-width: 118px; }
.right { display: flex; flex-direction: column; gap: 12px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 1200px) { .cols { grid-template-columns: 1fr; } }
svg { width: 100%; height: auto; display: block; background: color-mix(in srgb, var(--text) 5%, transparent); }
.widget { fill: color-mix(in srgb, var(--accent) 12%, transparent); stroke: var(--line); }
.widget.hot { fill: color-mix(in srgb, var(--accent) 45%, transparent); stroke: var(--accent); }
.wlabel { font-size: 9px; fill: var(--muted); }
.trail { stroke: var(--accent); stroke-width: 1.5; fill: none; opacity: .7; }
.cursor { fill: var(--bad); }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; }
dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; }
dt { color: var(--muted); }
dd { margin: 0; }
.mismatch { color: var(--bad); font-weight: 600; }
.match { color: var(--good); }
#controls {
  position: sticky; bottom: 0; background: var(--panel); border-top: 1px solid var(--line);
  padding: 10px 16px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
}
button, select {
  font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line);
  background: var(--bg); color: var(--text); cursor: pointer;
}
button:hover { border-color: var(--accent); }
input[type=range] { flex: 1; min-width: 160px; }
#pos { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 84px; }
.empty { color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>__TITLE__</h1>
  <span class="stat" id="summary"></span>
  <span class="stat" id="mismatch"></span>
</header>
<main>
  <section class="panel" id="timeline">
    <h2>Timeline / Event Log</h2>
    <div class="body" style="padding:6px 0">
      <div style="padding:0 12px 8px"><label class="stat">
        <input type="checkbox" id="hideMoves" checked> カーソルの MOVE を隠す
      </label></div>
      <ol id="events"></ol>
    </div>
  </section>
  <div class="right">
    <section class="panel">
      <h2>Game View <span id="screenName" class="stat"></span></h2>
      <div class="body"><svg id="view" viewBox="0 0 __W__ __H__"></svg></div>
    </section>
    <div class="cols">
      <section class="panel">
        <h2>AI Decision View</h2>
        <div class="body" id="decision"></div>
      </section>
      <section class="panel">
        <h2>GameState View</h2>
        <div class="body" id="state"></div>
      </section>
    </div>
  </div>
</main>
<div id="controls">
  <button id="restart" title="最初へ">&#9198;</button>
  <button id="stepBack" title="1 つ戻る">&#9664;</button>
  <button id="play" title="再生 / 一時停止">&#9654;</button>
  <button id="step" title="1 つ進む">&#9654;&#9654;</button>
  <select id="speed">
    <option value="1">1x</option>
    <option value="2">2x</option>
    <option value="10">10x</option>
  </select>
  <input type="range" id="scrub" min="0" value="0">
  <span id="pos"></span>
</div>
<script>
const DATA = __DATA__;
const view = document.getElementById("view");
const list = document.getElementById("events");
let position = 0;
let playing = false;
let timer = null;

const visible = () => document.getElementById("hideMoves").checked
  ? DATA.events.filter(e => e.kind !== "MOVE")
  : DATA.events;

function summary() {
  const counts = {};
  DATA.events.forEach(e => counts[e.kind] = (counts[e.kind] || 0) + 1);
  document.getElementById("summary").textContent =
    DATA.events.length + " イベント / " + DATA.decisions.length + " 判断 — " +
    Object.entries(counts).sort().map(([k, v]) => k + ":" + v).join(" ");
  const bad = DATA.decisions.filter(d => d.matched === false).length;
  const el = document.getElementById("mismatch");
  el.textContent = bad ? "期待とずれた判断 " + bad + " 件" : "判断と結果は一致";
  el.className = "stat" + (bad ? " bad" : "");
}

function buildList() {
  list.innerHTML = "";
  visible().forEach(e => {
    const li = document.createElement("li");
    li.dataset.index = e.i;
    li.innerHTML = '<span class="k">' + e.kind + "</span><span>" +
      (e.label || "") + (e.task_id ? " [" + e.task_id + "]" : "") + "</span>";
    li.onclick = () => { position = e.i + 1; render(); };
    list.appendChild(li);
  });
  document.getElementById("scrub").max = DATA.events.length;
}

function currentScreen() {
  for (let i = Math.min(position, DATA.events.length) - 1; i >= 0; i--) {
    const e = DATA.events[i];
    if (e.screen) return e.screen;
    if (e.kind === "SCREEN_CHANGE" && DATA.screens[e.label]) return e.label;
  }
  return "HOME";
}

function trail() {
  const points = [];
  for (let i = Math.min(position, DATA.events.length) - 1; i >= 0 && points.length < 40; i--) {
    const e = DATA.events[i];
    if ((e.kind === "MOVE" || e.kind === "CLICK") && e.detail.x !== undefined) {
      points.unshift({ x: +e.detail.x, y: +e.detail.y, click: e.kind === "CLICK" });
    }
  }
  return points;
}

function drawView() {
  const screen = currentScreen();
  document.getElementById("screenName").textContent = screen;
  const widgets = DATA.screens[screen] || [];
  const last = DATA.events[Math.min(position, DATA.events.length) - 1];
  const hot = last && last.kind === "CLICK" ? last.label : null;
  const parts = [];
  widgets.forEach(w => {
    const on = hot && (w.name === hot);
    parts.push('<rect class="widget' + (on ? " hot" : "") + '" x="' + w.x + '" y="' + w.y +
      '" width="' + w.w + '" height="' + w.h + '" rx="4"></rect>');
    parts.push('<text class="wlabel" x="' + (w.x + 4) + '" y="' + (w.y + 13) + '">' + w.name + "</text>");
  });
  const points = trail();
  if (points.length > 1) {
    parts.push('<polyline class="trail" points="' +
      points.map(p => p.x + "," + p.y).join(" ") + '"></polyline>');
  }
  const tip = points[points.length - 1];
  if (tip) {
    parts.push('<circle class="cursor" cx="' + tip.x + '" cy="' + tip.y + '" r="' +
      (tip.click ? 7 : 4) + '"></circle>');
  }
  view.innerHTML = parts.join("");
}

function drawDecision() {
  const now = position ? DATA.events[Math.min(position, DATA.events.length) - 1].ms : 0;
  const found = DATA.decisions.filter(d => d.ms <= now).pop();
  const el = document.getElementById("decision");
  if (!found) { el.innerHTML = '<p class="empty">まだ判断がありません</p>'; return; }
  const verdict = found.matched === null ? "" :
    (found.matched ? '<span class="match">一致</span>' : '<span class="mismatch">ずれ</span>');
  el.innerHTML = "<dl>" +
    "<dt>decision</dt><dd>" + found.decision + "</dd>" +
    "<dt>reason_code</dt><dd>" + found.reason_code + "</dd>" +
    (found.constraints.length ? "<dt>constraints</dt><dd>" + found.constraints.join(", ") + "</dd>" : "") +
    "<dt>expected</dt><dd>" + (found.expected || "-") + "</dd>" +
    "<dt>actual</dt><dd>" + (found.actual || "（未確定）") + " " + verdict + "</dd>" +
    "</dl><h3 style='font-size:11px;color:var(--muted);margin:10px 0 4px'>判断時に見えていた状態</h3><dl>" +
    Object.entries(found.input).map(([k, v]) => "<dt>" + k + "</dt><dd>" + v + "</dd>").join("") +
    "</dl>";
}

function drawState() {
  const keys = Object.keys(DATA.snapshots).map(Number).filter(i => i < position);
  const el = document.getElementById("state");
  if (!keys.length) { el.innerHTML = '<p class="empty">この時点のスナップショットはありません</p>'; return; }
  const snap = DATA.snapshots[String(Math.max.apply(null, keys))];
  const rows = snap["艦"].map(s =>
    "<tr><td>#" + s.id + "</td><td>Lv" + s.lv + "</td><td>" + s.hp + "</td><td>" +
    s["状態"] + "</td><td>" + s["ロック"] + "</td></tr>").join("");
  el.innerHTML = "<dl>" +
    Object.entries(snap["資材"]).map(([k, v]) => "<dt>" + k + "</dt><dd>" + v + "</dd>").join("") +
    "<dt>出撃</dt><dd>" + (snap["出撃"] || "-") + "</dd>" +
    "<dt>直近ドロップ</dt><dd>" + (snap["直近ドロップ"] || "-") + "</dd>" +
    "</dl><table><tr><th>艦</th><th>Lv</th><th>HP</th><th>状態</th><th>ロック</th></tr>" +
    rows + "</table>";
}

function render() {
  position = Math.max(0, Math.min(position, DATA.events.length));
  [...list.children].forEach(li => {
    const i = +li.dataset.index;
    li.className = i === position - 1 ? "now" : (i < position ? "past" : "");
  });
  const now = list.querySelector(".now");
  if (now) now.scrollIntoView({ block: "nearest" });
  document.getElementById("scrub").value = position;
  document.getElementById("pos").textContent = position + " / " + DATA.events.length;
  drawView(); drawDecision(); drawState();
}

function stop() {
  playing = false;
  if (timer) { clearTimeout(timer); timer = null; }
  document.getElementById("play").innerHTML = "&#9654;";
}

function tick() {
  if (position >= DATA.events.length) { stop(); return; }
  const speed = +document.getElementById("speed").value;
  const prev = DATA.events[position - 1];
  const next = DATA.events[position];
  position += 1;
  render();
  // 記録された時刻差を保つ。等間隔で送ると連打と待ちの区別が消える。
  const gap = prev ? Math.min(Math.max(next.ms - prev.ms, 0), 5000) : 0;
  timer = setTimeout(tick, Math.max(gap / speed, 16));
}

document.getElementById("play").onclick = () => {
  if (playing) { stop(); return; }
  playing = true;
  document.getElementById("play").innerHTML = "&#10073;&#10073;";
  tick();
};
document.getElementById("step").onclick = () => { stop(); position += 1; render(); };
document.getElementById("stepBack").onclick = () => { stop(); position -= 1; render(); };
document.getElementById("restart").onclick = () => { stop(); position = 0; render(); };
document.getElementById("scrub").oninput = (e) => { stop(); position = +e.target.value; render(); };
document.getElementById("hideMoves").onchange = () => { buildList(); render(); };

summary(); buildList(); render();
</script>
</body>
</html>
"""


def render_report(data: ReportData) -> str:
    """表示用データから HTML を組み立てる。"""
    # 記録の中に "</script>" のような文字列があると、そこでスクリプトが
    # 終わってしまう。埋め込む前に区切りを壊しておく。
    payload = json.dumps(data.to_dict(), ensure_ascii=False).replace("</", "<\\/")
    return (
        _TEMPLATE.replace("__TITLE__", data.title)
        .replace("__W__", str(data.to_dict()["width"]))
        .replace("__H__", str(data.to_dict()["height"]))
        .replace("__DATA__", payload)
    )


def build_report(
    timeline: Timeline,
    decisions: Sequence[Decision] = (),
    snapshots: Mapping[int, GameState] | None = None,
    title: str = "セッション記録",
) -> str:
    """記録から HTML を作る。"""
    return render_report(build_data(timeline, decisions, snapshots, title))


def report_from_recorder(
    recorder: SessionRecorder, title: str = "セッション記録"
) -> str:
    """:class:`~recording.recorder.SessionRecorder` から HTML を作る。"""
    return build_report(
        recorder.timeline, list(recorder.decisions), recorder.snapshots, title
    )


def write_report(path: str | Path, html: str) -> Path:
    """HTML を書き出す。

    Returns:
        書き出したパス。
    """
    target = Path(path)
    write_text_atomic(target, html)
    logger.info("レポートを書き出しました: %s", target)
    return target

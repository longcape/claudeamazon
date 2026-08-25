/* =========================================================
   APP / CONTROLLER
   イベント登録と描画のオーケストレーション
   ========================================================= */
(function (global) {
  'use strict';

  const D = global.VCT_DATA;
  const S = global.VCT_STORE;
  const U = global.VCT_UI;
  const $ = U.$;

  /* 画面側だけが持つ一時状態 */
  const ui = {
    deckFilter: 'ALL',
    includeOffSide: false,
    economy: 'full',
    agentTarget: null,      // { team: 'ally'|'enemy', index: number }
    agentRole: 'all',
    agentQuery: '',
    editingTacticId: null
  };

  /* ================= 描画 ================= */
  function renderSetup() {
    U.renderMapSelect();
    U.renderSideToggle();
    U.renderMatchFields();
    U.renderRoster();
    U.renderDeck(ui.deckFilter);
    U.renderReady();
  }

  function renderLive() {
    U.renderScorebar();
    U.renderBoardRosters();
    U.renderStage(ui);
    U.renderTimeline();
    U.renderPerf();
  }

  function renderAll() {
    const live = S.state.phase === 'live';
    $('view-setup').hidden = live;
    $('view-live').hidden = !live;
    document.querySelectorAll('.phase-tab').forEach(function (t) {
      const active = (t.dataset.phase === 'live') === live;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
    });
    if (live) renderLive(); else renderSetup();
  }

  function goPhase(phase) {
    if (phase === 'live' && !U.renderReady()) {
      U.toast('味方・敵のエージェント 5 体ずつと、戦術を 1 つ以上登録してください。', 'err');
      return;
    }
    S.state.phase = phase;
    S.save();
    renderAll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ================= モーダル制御 ================= */
  function openModal(id) { $(id).hidden = false; document.body.style.overflow = 'hidden'; }
  function closeModal(id) { $(id).hidden = true; document.body.style.overflow = ''; }
  function closeAllModals() {
    closeModal('modal-agent');
    closeModal('modal-tactic');
  }

  function openAgentModal(team, index) {
    ui.agentTarget = { team: team, index: index };
    ui.agentQuery = '';
    ui.agentRole = 'all';
    const slot = rosterOf(team)[index];
    $('agent-search').value = '';
    $('agent-player').value = slot.player || '';
    $('agent-modal-title').textContent =
      (team === 'ally' ? 'ALLY' : 'ENEMY') + ' SLOT ' + (index + 1) + ' — SELECT AGENT';
    U.renderRoleFilter(ui.agentRole);
    U.renderAgentGrid({ query: '', role: 'all', current: slot.agent });
    openModal('modal-agent');
    $('agent-search').focus();
  }

  function rosterOf(team) {
    return team === 'ally' ? S.state.allies : S.state.enemies;
  }

  function openTacticModal(tacticId) {
    ui.editingTacticId = tacticId || null;
    const t = tacticId ? S.tacticById(tacticId) : null;
    $('tactic-modal-title').textContent = t ? 'EDIT TACTIC' : 'NEW TACTIC';
    $('t-name').value = t ? t.name : '';
    $('t-note').value = t ? t.note : '';
    U.renderKindSelect(t ? t.kind : 'execute');
    U.renderSiteSeg(t ? t.site : 'A');
    U.setSegActive($('t-side'), t ? t.side : 'BOTH');
    $('btn-delete-tactic').hidden = !t;
    openModal('modal-tactic');
    setTimeout(function () { $('t-name').focus(); }, 30);
  }

  /* ================= セットアップ画面のイベント ================= */
  function bindSetup() {
    $('map-select').addEventListener('click', function (e) {
      const btn = e.target.closest('.map-opt');
      if (!btn) return;
      S.state.match.map = btn.dataset.map;
      S.save();
      U.renderMapSelect();
    });

    $('side-toggle').addEventListener('click', function (e) {
      const btn = e.target.closest('.side-btn');
      if (!btn) return;
      S.state.match.startSide = btn.dataset.side;
      S.save();
      U.renderSideToggle();
    });

    $('inp-ally-team').addEventListener('input', function (e) {
      S.state.match.allyTeam = e.target.value;
      S.save();
      $('roster-ally-name').textContent = e.target.value || 'OUR TEAM';
    });
    $('inp-enemy-team').addEventListener('input', function (e) {
      S.state.match.enemyTeam = e.target.value;
      S.save();
      $('roster-enemy-name').textContent = e.target.value || 'OPPONENT';
    });
    $('inp-match-note').addEventListener('input', function (e) {
      S.state.match.note = e.target.value;
      S.save();
    });

    ['slots-ally', 'slots-enemy'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        const btn = e.target.closest('.slot');
        if (!btn) return;
        openAgentModal(btn.dataset.team, Number(btn.dataset.index));
      });
    });

    $('deck-filter').addEventListener('click', function (e) {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      ui.deckFilter = chip.dataset.filter;
      $('deck-filter').querySelectorAll('.chip').forEach(function (c) {
        c.classList.toggle('is-active', c === chip);
      });
      U.renderDeck(ui.deckFilter);
    });

    $('deck-grid').addEventListener('click', function (e) {
      const card = e.target.closest('.tcard');
      if (!card) return;
      openTacticModal(card.dataset.id);
    });
    $('deck-grid').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('.tcard');
      if (!card) return;
      e.preventDefault();
      openTacticModal(card.dataset.id);
    });

    $('btn-add-tactic').addEventListener('click', function () { openTacticModal(null); });

    $('btn-seed').addEventListener('click', function () {
      S.seedSamples();
      U.renderDeck(ui.deckFilter);
      U.renderReady();
      U.toast('サンプル戦術を追加しました。', 'ok');
    });

    $('btn-start').addEventListener('click', function () { goPhase('live'); });
  }

  /* ================= ライブ画面のイベント ================= */
  function bindLive() {
    $('stage').addEventListener('click', function (e) {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;

      if (act === 'pick') {
        S.setPending(el.dataset.id, ui.economy);
        renderLive();
        return;
      }
      if (act === 'result') {
        const rec = S.commitRound(el.dataset.result);
        if (rec) {
          U.toast('ROUND ' + rec.n + ' — ' + rec.result + ' を記録しました。', rec.result === 'WIN' ? 'ok' : 'err');
        }
        renderLive();
        return;
      }
      if (act === 'change') {
        S.clearPending();
        renderLive();
        return;
      }
      if (act === 'flip-side') {
        S.flipSideForRound(S.currentRoundNumber());
        renderLive();
        return;
      }
      if (act === 'toggle-offside') {
        ui.includeOffSide = !ui.includeOffSide;
        renderLive();
        return;
      }
      if (act === 'new-tactic') {
        openTacticModal(null);
        return;
      }
      if (act === 'eco') {
        ui.economy = el.dataset.eco;
        renderLive();
        return;
      }
    });

    $('btn-undo').addEventListener('click', function () {
      const last = S.undoLastRound();
      if (!last) { U.toast('取り消せるラウンドがありません。', 'err'); return; }
      U.toast('ROUND ' + last.n + ' の記録を取り消しました。');
      renderLive();
    });

    $('btn-reset-match').addEventListener('click', function () {
      if (!confirm('スコアとラウンド履歴をリセットします。戦術デッキとエージェント編成は残ります。よろしいですか？')) return;
      S.resetMatch();
      renderLive();
      U.toast('マッチをリセットしました。');
    });
  }

  /* ================= モーダルのイベント ================= */
  function bindAgentModal() {
    $('agent-search').addEventListener('input', function (e) {
      ui.agentQuery = e.target.value;
      const slot = ui.agentTarget ? rosterOf(ui.agentTarget.team)[ui.agentTarget.index] : { agent: '' };
      U.renderAgentGrid({ query: ui.agentQuery, role: ui.agentRole, current: slot.agent });
    });

    $('role-filter').addEventListener('click', function (e) {
      const chip = e.target.closest('.role-chip');
      if (!chip) return;
      ui.agentRole = chip.dataset.role;
      U.renderRoleFilter(ui.agentRole);
      const slot = ui.agentTarget ? rosterOf(ui.agentTarget.team)[ui.agentTarget.index] : { agent: '' };
      U.renderAgentGrid({ query: ui.agentQuery, role: ui.agentRole, current: slot.agent });
    });

    $('agent-grid').addEventListener('click', function (e) {
      const opt = e.target.closest('.agent-opt');
      if (!opt || !ui.agentTarget) return;
      const slot = rosterOf(ui.agentTarget.team)[ui.agentTarget.index];
      slot.agent = opt.dataset.agent;
      slot.player = $('agent-player').value.trim();
      S.save();
      closeModal('modal-agent');
      renderAll();
    });

    $('agent-player').addEventListener('input', function (e) {
      if (!ui.agentTarget) return;
      rosterOf(ui.agentTarget.team)[ui.agentTarget.index].player = e.target.value.trim();
      S.save();
    });

    $('btn-clear-slot').addEventListener('click', function () {
      if (!ui.agentTarget) return;
      const slot = rosterOf(ui.agentTarget.team)[ui.agentTarget.index];
      slot.agent = '';
      slot.player = '';
      S.save();
      closeModal('modal-agent');
      renderAll();
    });
  }

  function bindTacticModal() {
    $('t-side').addEventListener('click', function (e) {
      const btn = e.target.closest('button');
      if (!btn) return;
      U.setSegActive($('t-side'), btn.dataset.val);
    });
    $('t-site').addEventListener('click', function (e) {
      const btn = e.target.closest('button');
      if (!btn) return;
      U.setSegActive($('t-site'), btn.dataset.val);
    });

    $('tactic-form').addEventListener('submit', function (e) {
      e.preventDefault();
      const name = $('t-name').value.trim();
      if (!name) { U.toast('戦術名を入力してください。', 'err'); return; }
      const payload = {
        name: name,
        side: U.segValue($('t-side')) || 'BOTH',
        site: U.segValue($('t-site')) || '-',
        kind: $('t-kind').value,
        note: $('t-note').value.trim()
      };
      if (ui.editingTacticId) {
        S.updateTactic(ui.editingTacticId, payload);
        U.toast('戦術を更新しました。', 'ok');
      } else {
        S.addTactic(payload);
        U.toast('戦術を追加しました。', 'ok');
      }
      ui.editingTacticId = null;
      closeModal('modal-tactic');
      renderAll();
    });

    $('btn-delete-tactic').addEventListener('click', function () {
      if (!ui.editingTacticId) return;
      const t = S.tacticById(ui.editingTacticId);
      if (!confirm('「' + (t ? t.name : '') + '」を削除します。よろしいですか？')) return;
      S.removeTactic(ui.editingTacticId);
      ui.editingTacticId = null;
      closeModal('modal-tactic');
      renderAll();
      U.toast('戦術を削除しました。');
    });
  }

  /* ================= 共通イベント ================= */
  function bindGlobal() {
    document.querySelectorAll('.phase-tab').forEach(function (tab) {
      tab.addEventListener('click', function () { goPhase(tab.dataset.phase); });
    });

    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) closeAllModals();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeAllModals(); return; }

      const modalOpen = !$('modal-agent').hidden || !$('modal-tactic').hidden;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (modalOpen || typing || S.state.phase !== 'live') return;

      /* ライブ中のショートカット */
      if (S.state.pending) {
        if (e.key === 'w' || e.key === 'W') {
          S.commitRound('WIN'); renderLive(); U.toast('WIN を記録しました。', 'ok');
        } else if (e.key === 'l' || e.key === 'L') {
          S.commitRound('LOSS'); renderLive(); U.toast('LOSS を記録しました。', 'err');
        }
      } else if (/^[1-9]$/.test(e.key)) {
        const picks = $('stage').querySelectorAll('.pick');
        const target = picks[Number(e.key) - 1];
        if (target) target.click();
      }
    });

    /* 書き出し */
    $('btn-export').addEventListener('click', function () {
      const blob = new Blob([S.exportJSON()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const map = D.mapById(S.state.match.map);
      a.href = url;
      a.download = 'valorant-setup-card_' + (map ? map.name.toLowerCase() : 'match') + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      U.toast('JSON を書き出しました。', 'ok');
    });

    /* 読み込み */
    $('btn-import').addEventListener('click', function () { $('file-import').click(); });
    $('file-import').addEventListener('change', function (e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function () {
        try {
          S.importJSON(String(reader.result));
          renderAll();
          U.toast('データを読み込みました。', 'ok');
        } catch (err) {
          U.toast('読み込みに失敗しました: ' + err.message, 'err');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    $('btn-reset-all').addEventListener('click', function () {
      if (!confirm('すべてのデータ（編成・戦術デッキ・戦績）を初期化します。よろしいですか？')) return;
      S.resetAll();
      ui.deckFilter = 'ALL';
      renderAll();
      U.toast('初期化しました。');
    });
  }

  /* ================= 起動 ================= */
  function init() {
    const restored = S.load();
    if (!restored && S.state.tactics.length === 0) {
      S.seedSamples();   // 初回起動時は雛形を入れて操作感を掴めるようにする
    }
    bindSetup();
    bindLive();
    bindAgentModal();
    bindTacticModal();
    bindGlobal();
    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);

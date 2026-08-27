/* =========================================================
   APP / CONTROLLER
   イベント登録と描画のオーケストレーション
   ========================================================= */
(function (global) {
  'use strict';

  const D = global.VCT_DATA;
  const S = global.VCT_STORE;
  const U = global.VCT_UI;
  const I = global.VCT_I18N;
  const C = global.VCT_COMMUNITY;
  const ANALYST = global.VCT_ANALYST;
  const SHARE = global.VCT_SHARE;
  const BOARD = global.VCT_BOARD;
  const CFG = global.VCT_CONFIG;
  const $ = U.$;
  const t = function (key, params) { return I.t(key, params); };

  /* 公開ページ上でのみ使えるファイル保存 API（通常のブラウザでは null のまま） */
  let downloadsApi = null;
  if (global.claude && typeof global.claude.use === 'function') {
    global.claude.use('downloads').then(function (api) {
      downloadsApi = api;
    }, function () { /* 使えない環境ではフォールバックする */ });
  }

  /* 画面側だけが持つ一時状態 */
  const TREE = global.VCT_TREE;

  const ui = {
    view: 'setup',            // 'setup' | 'live' | 'community'
    deckFilter: 'ALL',
    deckQuery: '',            // 戦術の検索語
    deckGroup: 'none',        // まとめ方 none / site / kind / side
    includeOffSide: false,
    economy: 'full',
    agentTarget: null,
    agentRole: 'all',
    agentQuery: '',
    editingTacticId: null,
    analysis: null,           // 直近の相性判定結果
    aiReview: null,           // Claude が返した寸評
    aiRunning: false,
    posts: [],
    postSort: 'new',
    postMap: '',
    postTacticId: null,
    treeFocusId: null,        // ツリーで強調する戦術（直前に使ったもの）
    cloudSetups: [],          // クラウドに保存済みのセットアップ
    cloudLoading: false,

    /* 配置盤エディタ */
    boardTactic: null,        // 編集中の戦術
    phaseIndex: 0,            // 編集中の局面（A フェイク / B 本命 など）
    livePhase: 0,             // ライブ画面で表示中の局面
    boardSide: 'ATK',
    armed: null,              // パレットで選択中の「これから置くもの」
    selectedMarkId: null,     // 盤上で選択中のマーク
    routeTeam: null,          // ルート描画中のチーム
    draftRoute: []            // 描画途中のルート
  };

  /* ================= 描画 ================= */
  function renderSetup() {
    U.renderMapSelect();
    U.renderSideToggle();
    U.renderMatchFields();
    U.renderRoster();
    /* 言語を切り替えても選択肢の文言が付いてくるよう、毎回描き直す */
    U.renderDeckGroupSelect(ui.deckGroup);
    U.renderDeck(ui);
    U.renderReady();
  }

  function renderLive() {
    U.renderScorebar();
    U.renderBoardRosters();
    U.renderStage(ui);
    U.renderTimeline();
    U.renderPerf();
  }

  function renderCommunity() {
    U.renderAccount();
    U.renderCommunityMapFilter(ui.postMap);
    U.renderPosts(ui.posts);
  }

  function renderAll() {
    $('view-setup').hidden = ui.view !== 'setup';
    $('view-live').hidden = ui.view !== 'live';
    $('view-community').hidden = ui.view !== 'community';
    $('tab-community').hidden = !C.enabled();
    /* 未ログインでも押せるようにする。押した先でログインへ誘導した方が
       「どこから入るのか」が分かりやすい */
    $('btn-cloud').hidden = !C.enabled();

    document.querySelectorAll('.phase-tab').forEach(function (tab) {
      const active = tab.dataset.phase === ui.view;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });

    if (ui.view === 'live') renderLive();
    else if (ui.view === 'community') renderCommunity();
    else renderSetup();
  }

  function goPhase(phase) {
    if (phase === 'live' && !U.renderReady()) {
      U.toast(t('toast.needSetup'), 'err');
      return;
    }
    ui.view = phase;
    if (phase === 'setup' || phase === 'live') {
      S.state.phase = phase;
      S.save();
    }
    renderAll();
    if (phase === 'community') loadPosts();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ================= モーダル ================= */
  function openModal(id) { $(id).hidden = false; document.body.style.overflow = 'hidden'; }
  function closeModal(id) { $(id).hidden = true; document.body.style.overflow = ''; }
  function closeAllModals() {
    ['modal-agent', 'modal-tactic', 'modal-post', 'modal-login', 'modal-board', 'modal-cloud', 'modal-tree'].forEach(closeModal);
  }

  function rosterOf(team) { return team === 'ally' ? S.state.allies : S.state.enemies; }

  /* 構成の名前の下書き。頭 2 体の略称を並べておくと、
     あとから一覧で見分けやすい */
  function suggestCompName(roster) {
    return roster.map(function (s2) {
      const a = D.agentById(s2.agent);
      return a ? a.abbr : '';
    }).filter(Boolean).slice(0, 3).join('/');
  }

  /** 埋まっていない次のスロット。無ければ -1 */
  function nextEmptySlot(team, from) {
    const list = rosterOf(team);
    for (let i = from + 1; i < list.length; i++) if (!list[i].agent) return i;
    for (let i = 0; i <= from; i++) if (!list[i].agent) return i;
    return -1;
  }

  function openAgentModal(team, index) {
    ui.agentTarget = { team: team, index: index };
    ui.agentQuery = '';
    ui.agentRole = 'all';
    const slot = rosterOf(team)[index];
    $('agent-search').value = '';
    $('agent-player').value = slot.player || '';
    $('agent-modal-title').textContent = t('modal.agent.title', {
      team: t(team === 'ally' ? 'tag.ally' : 'tag.enemy'),
      n: index + 1
    });
    U.renderRoleFilter(ui.agentRole);
    U.renderAgentGrid({ query: '', role: 'all', current: slot.agent });
    openModal('modal-agent');
    $('agent-search').focus();
  }

  function openTacticModal(tacticId) {
    ui.editingTacticId = tacticId || null;
    const tac = tacticId ? S.tacticById(tacticId) : null;
    $('tactic-modal-title').textContent = t(tac ? 'modal.tactic.edit' : 'modal.tactic.new');
    $('t-name').value = tac ? tac.name : '';
    $('t-note').value = tac ? tac.note : '';
    U.renderKindSelect(tac ? tac.kind : 'execute');
    U.renderSiteSeg(tac ? tac.site : 'A');
    U.setSegActive($('t-side'), tac ? tac.side : 'BOTH');
    $('btn-delete-tactic').hidden = !tac;
    openModal('modal-tactic');
    setTimeout(function () { $('t-name').focus(); }, 30);
  }

  /* ================= 相性判定 ================= */
  function currentTactic() {
    if (S.state.pending) return S.tacticById(S.state.pending.tacticId);
    return null;
  }

  function runAnalysis(tactic) {
    const tac = tactic || currentTactic();
    if (!tac) return null;
    ui.analysis = ANALYST.analyze({
      tactic: tac,
      allies: S.state.allies,
      enemies: S.state.enemies,
      map: S.state.match.map,
      side: S.sideForRound(S.currentRoundNumber())
    });
    ui.aiReview = null;
    return ui.analysis;
  }

  function runAiReview() {
    const tac = currentTactic();
    if (!tac || !C.enabled()) return;
    if (!ui.analysis) runAnalysis(tac);

    ui.aiRunning = true;
    renderLive();

    C.aiReview({
      tactic: { name: tac.name, side: tac.side, site: tac.site, kind: tac.kind, note: tac.note },
      map: (D.mapById(S.state.match.map) || {}).name || S.state.match.map,
      side: S.sideForRound(S.currentRoundNumber()),
      allyComp: compNames(S.state.allies),
      enemyComp: compNames(S.state.enemies),
      lang: I.get(),
      analysis: ui.analysis ? {
        score: ui.analysis.score,
        verdict: ui.analysis.verdict,
        findings: ui.analysis.findings.map(function (f) { return t(f.key, f.params); })
      } : null
    }).then(function (data) {
      ui.aiRunning = false;
      ui.aiReview = data && data.review ? data.review : null;
      renderLive();
    }, function (err) {
      ui.aiRunning = false;
      renderLive();
      U.toast(err && err.status === 429 ? t('analyst.aiUnavailable') : String(err.message || err), 'err');
    });
  }

  function compNames(slots) {
    return slots.map(function (s) {
      const a = D.agentById(s.agent);
      return a ? a.name : null;
    }).filter(Boolean);
  }

  /* ================= 分岐ツリー ================= */

  function openTreeModal() {
    const last = S.lastRound();
    ui.treeFocusId = S.state.pending ? S.state.pending.tacticId : (last ? last.tacticId : null);
    U.renderTree(ui);
    openModal('modal-tree');
  }

  function bindTree() {
    $('btn-tree').addEventListener('click', openTreeModal);

    /* 分岐先の変更。線を引き直すので毎回まるごと描き直す。
       ノードは数十個までなので、差分更新に踏み込む理由がない */
    $('tree-canvas').addEventListener('change', function (e) {
      const sel = e.target.closest('[data-tree-node]');
      if (!sel) return;
      const tac = S.tacticById(sel.dataset.treeNode);
      if (!tac) return;
      TREE.setNext(tac, sel.dataset.treeResult, sel.value || null);
      S.save();
      U.renderTree(ui);
    });

    $('btn-tree-clear').addEventListener('click', function () {
      if (!confirm(t('tree.confirmClear'))) return;
      S.state.tactics.forEach(function (tac) {
        TREE.setNext(tac, 'win', null);
        TREE.setNext(tac, 'loss', null);
      });
      S.save();
      U.renderTree(ui);
      U.toast(t('tree.cleared'));
    });
  }

  /* ================= クラウド保存 ================= */

  function openCloudModal() {
    ui.cloudSetups = [];
    ui.cloudLoading = !!C.currentUser();
    U.renderCloud(ui);
    openModal('modal-cloud');
    if (C.currentUser()) refreshCloudList();
  }

  function refreshCloudList() {
    ui.cloudLoading = true;
    U.renderCloud(ui);
    return C.listSetups().then(function (rows) {
      ui.cloudSetups = Array.isArray(rows) ? rows : [];
      ui.cloudLoading = false;
      U.renderCloud(ui);
    }, function (err) {
      ui.cloudLoading = false;
      U.renderCloud(ui);
      U.toast(cloudError(err), 'err');
    });
  }

  /* 通信の失敗は理由が分からないと直しようがないので、
     ログインが切れた場合だけは専用の文言にする */
  function cloudError(err) {
    if (err && err.message === 'AUTH_REQUIRED') return t('cloud.needLogin');
    return t('cloud.failed', { msg: (err && err.message) || '' });
  }

  function bindCloud() {
    $('btn-cloud').addEventListener('click', openCloudModal);

    $('cloud-body').addEventListener('click', function (e) {
      const btn = e.target.closest('[data-cloud-act]');
      if (!btn) return;
      const act = btn.dataset.cloudAct;
      const row = btn.closest('[data-cloud-id]');
      const id = row ? row.dataset.cloudId : null;
      const saved = ui.cloudSetups.filter(function (r) { return r.id === id; })[0];

      if (act === 'login') {
        closeModal('modal-cloud');
        openModal('modal-login');
        return;
      }

      if (act === 'save') {
        const name = ($('cloud-name').value || '').trim();
        if (!name) { U.toast(t('cloud.nameRequired'), 'err'); return; }
        btn.disabled = true;
        C.saveSetup(name, JSON.parse(S.exportJSON())).then(function () {
          U.toast(t('cloud.saved'), 'ok');
          refreshCloudList();
        }, function (err) {
          btn.disabled = false;
          U.toast(cloudError(err), 'err');
        });
        return;
      }

      if (!saved) return;

      if (act === 'load') {
        /* 読み込むと手元の内容が丸ごと入れ替わる。取り返しがつかないので確認する */
        if (!confirm(t('cloud.confirmLoad', { name: saved.name }))) return;
        try {
          S.importObject(saved.payload);
        } catch (err) {
          U.toast(t('cloud.badPayload'), 'err');
          return;
        }
        closeModal('modal-cloud');
        ui.analysis = null;
        ui.aiReview = null;
        renderAll();
        U.toast(t('cloud.loaded', { name: saved.name }), 'ok');
        return;
      }

      if (act === 'overwrite') {
        if (!confirm(t('cloud.confirmOverwrite', { name: saved.name }))) return;
        btn.disabled = true;
        C.updateSetup(saved.id, saved.name, JSON.parse(S.exportJSON())).then(function () {
          U.toast(t('cloud.saved'), 'ok');
          refreshCloudList();
        }, function (err) {
          btn.disabled = false;
          U.toast(cloudError(err), 'err');
        });
        return;
      }

      if (act === 'delete') {
        if (!confirm(t('cloud.confirmDelete', { name: saved.name }))) return;
        C.deleteSetup(saved.id).then(function () {
          U.toast(t('cloud.deleted'), 'ok');
          refreshCloudList();
        }, function (err) { U.toast(cloudError(err), 'err'); });
      }
    });
  }

  /* ================= 配置盤 ================= */

  /** いま編集している局面の盤面 */
  function curPhase() {
    return BOARD.phaseAt(ui.boardTactic, ui.phaseIndex);
  }

  function openBoardEditor(tactic) {
    /* 押しても何も起きないボタンを作らない。理由を必ず出す */
    if (!tactic) { U.toast(t('board.needTactic'), 'err'); return; }
    ui.boardTactic = tactic;
    ui.phaseIndex = 0;
    ui.boardSide = S.sideForRound(S.currentRoundNumber());
    ui.armed = null;
    ui.selectedMarkId = null;
    ui.routeTeam = null;
    ui.draftRoute = [];
    BOARD.phases(tactic);
    /* 高さを測ってから描くので、先に開く */
    openModal('modal-board');
    U.renderBoardEditor(ui);
  }

  function refreshBoard() {
    U.renderBoardPhases(ui);
    U.renderBoardTools(ui);
    U.renderBoardHint(ui);
    U.renderBoardCanvas(ui);
    U.renderBoardPalette('ally', ui);
    U.renderBoardPalette('enemy', ui);
  }

  function commitBoard() {
    S.save();
    if (ui.view === 'live') renderLive();
    else if (ui.view === 'setup') U.renderDeck(ui);
  }

  function bindBoardEditor() {
    bindPaletteDrag();

    /* 局面（フェーズ）の切り替え・追加・削除・改名 */
    $('board-phases').addEventListener('click', function (e) {
      const btn = e.target.closest('[data-phase-act]');
      if (!btn) return;
      const act = btn.dataset.phaseAct;

      if (act === 'go') {
        ui.phaseIndex = Number(btn.dataset.phaseIndex) || 0;
      } else if (act === 'add') {
        if (!BOARD.addPhase(ui.boardTactic)) {
          U.toast(t('board.phaseLimit', { n: BOARD.MAX_PHASES }), 'err');
          return;
        }
        ui.phaseIndex = BOARD.phases(ui.boardTactic).length - 1;
      } else if (act === 'del') {
        const label = curPhase().name || t('board.phaseN', { n: ui.phaseIndex + 1 });
        if (!confirm(t('board.confirmPhaseDel', { name: label }))) return;
        BOARD.removePhase(ui.boardTactic, ui.phaseIndex);
        ui.phaseIndex = Math.max(0, ui.phaseIndex - 1);
      } else {
        return;
      }

      ui.armed = null;
      ui.selectedMarkId = null;
      ui.routeTeam = null;
      ui.draftRoute = [];
      commitBoard();
      refreshBoard();
    });

    /* 名前は打つたびに保存する。タブの見出しだけ差し替えて、
       入力欄そのものは描き直さない（打っている途中で focus が飛ぶため） */
    $('board-phases').addEventListener('input', function (e) {
      if (e.target.id !== 'phase-name') return;
      BOARD.renamePhase(ui.boardTactic, ui.phaseIndex, e.target.value);
      const tab = $('board-phases').querySelector('.stage-tab.is-active');
      if (tab) {
        tab.lastChild.textContent = e.target.value ||
          t('board.phaseN', { n: ui.phaseIndex + 1 });
      }
      commitBoard();
    });

    /* ツールバー */
    $('board-tools').addEventListener('click', function (e) {
      const btn = e.target.closest('[data-board-act]');
      if (!btn) return;
      const act = btn.dataset.boardAct;

      if (act === 'route-start') {
        ui.routeTeam = btn.dataset.team;
        ui.draftRoute = [];
        ui.armed = null;
        ui.selectedMarkId = null;
      } else if (act === 'route-done') {
        if (ui.draftRoute.length >= 2) {
          BOARD.addRoute(curPhase(), ui.routeTeam, ui.draftRoute);
          commitBoard();
        }
        ui.routeTeam = null;
        ui.draftRoute = [];
      } else if (act === 'route-cancel') {
        ui.routeTeam = null;
        ui.draftRoute = [];
      } else if (act === 'disarm') {
        ui.armed = null;
      } else if (act === 'size-up' || act === 'size-down') {
        U.setBoardSizeIndex(U.boardSizeIndex() + (act === 'size-up' ? 1 : -1));
        if (ui.view === 'live') renderLive();
      } else if (act === 'order-up' || act === 'order-down') {
        BOARD.bumpOrder(curPhase(), ui.selectedMarkId, act === 'order-up' ? -1 : 1);
        commitBoard();
      } else if (act === 'delete-mark') {
        BOARD.removeMark(curPhase(), ui.selectedMarkId);
        ui.selectedMarkId = null;
        commitBoard();
      }
      refreshBoard();
    });

    $('btn-board-clear').addEventListener('click', function () {
      if (!ui.boardTactic) return;
      if (!confirm(t('board.confirmClear'))) return;
      BOARD.clearBoard(curPhase());
      ui.selectedMarkId = null;
      ui.armed = null;
      ui.routeTeam = null;
      ui.draftRoute = [];
      commitBoard();
      refreshBoard();
    });

    bindBoardCanvas();
  }

  /**
   * パレットからマップへのドラッグ＆ドロップ。
   *
   * 掴んで運ぶ操作が一番直感的なので、これを主にする。
   * ただしタッチ環境や、同じものを続けて置きたい場合のために、
   * 「動かさずに離す＝選択」という従来の方法も残している。
   */
  function bindPaletteDrag() {
    const THRESHOLD = 5;
    let drag = null;

    function makeGhost(btn) {
      const ghost = document.createElement('div');
      ghost.className = 'place-ghost';
      const img = btn.querySelector('img');
      const glyph = btn.querySelector('svg');
      const label = btn.querySelector('span');
      /* パレットはアイコンのみなので、名前は title 属性から取る */
      const name = label ? label.textContent : (btn.getAttribute('title') || '').trim();
      const icon = img ? '<img src="' + img.src + '" alt="" />'
                       : (glyph ? glyph.outerHTML : '');
      ghost.innerHTML = icon + '<span>' + name + '</span>';
      document.body.appendChild(ghost);
      return ghost;
    }

    function moveGhost(ghost, e) {
      ghost.style.left = e.clientX + 'px';
      ghost.style.top = e.clientY + 'px';
    }

    /** ポインタの真下が盤面なら、その盤面を返す */
    function boardUnder(e) {
      if (drag && drag.ghost) drag.ghost.style.display = 'none';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (drag && drag.ghost) drag.ghost.style.display = '';
      return el ? el.closest('svg[data-board]') : null;
    }

    function cleanup() {
      if (drag && drag.ghost) drag.ghost.remove();
      if (drag && drag.btn) drag.btn.classList.remove('is-dragging');
      drag = null;
      const svg = $('board-canvas').querySelector('svg[data-board]');
      if (svg) svg.classList.remove('is-drop-target');
    }

    /* スパイクのチップはツールバーにあるので、そこも掴める場所に含める */
    ['board-palette-ally', 'board-palette-enemy', 'board-tools'].forEach(function (id) {
      const pal = $(id);

      pal.addEventListener('pointerdown', function (e) {
        if (e.button) return;          // 左ボタン（とタッチ）だけ掴める
        const btn = e.target.closest('[data-place-kind]');
        if (!btn) return;
        drag = {
          btn: btn,
          kind: btn.dataset.placeKind,
          ref: btn.dataset.placeRef,
          team: btn.dataset.placeTeam,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
          ghost: null,
          pointerId: e.pointerId
        };
        try { btn.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
        e.preventDefault();
      });

      pal.addEventListener('pointermove', function (e) {
        if (!drag) return;
        if (!drag.moved) {
          const dx = e.clientX - drag.startX;
          const dy = e.clientY - drag.startY;
          if (Math.sqrt(dx * dx + dy * dy) < THRESHOLD) return;
          drag.moved = true;
          drag.ghost = makeGhost(drag.btn);
          drag.btn.classList.add('is-dragging');
        }
        moveGhost(drag.ghost, e);

        /* 落とせる場所に来たら盤面を光らせる */
        const svg = $('board-canvas').querySelector('svg[data-board]');
        if (svg) svg.classList.toggle('is-drop-target', !!boardUnder(e));
        e.preventDefault();
      });

      pal.addEventListener('pointerup', function (e) {
        if (!drag) return;
        const current = drag;

        if (current.moved) {
          const svg = boardUnder(e);
          if (svg) {
            const p = BOARD.toBoardPoint(svg, e);
            BOARD.addMark(curPhase(), {
              kind: current.kind, ref: current.ref, team: current.team, x: p.x, y: p.y
            });
            commitBoard();
          }
          cleanup();
          refreshBoard();
          return;
        }

        /* 動かさずに離した = 選択。タップして置く方法も残す */
        cleanup();
        ui.armed = { kind: current.kind, ref: current.ref, team: current.team };
        ui.selectedMarkId = null;
        refreshBoard();
      });

      pal.addEventListener('pointercancel', function () {
        cleanup();
        refreshBoard();
      });
    });
  }

  /**
   * 盤面のポインタ操作。マウスとタッチの両方を pointer event で扱う。
   *
   * 「押して動かしたらドラッグ」「動かさずに離したらタップ」で判定する。
   * こうしないと、配置するものを選んだ状態のままだと
   * 既存のマークを掴めず、重ねて置いてしまう。
   *
   * ドラッグ中に盤面全体を描き直すと掴んでいる要素が差し替わって
   * 操作が切れるため、動かしている間は transform だけを書き換える。
   */
  function bindBoardCanvas() {
    const canvas = $('board-canvas');
    const THRESHOLD = 4;   // これ以上動いたらドラッグとみなす（px）
    let press = null;

    function svgEl() { return canvas.querySelector('svg[data-board]'); }

    /* 右クリックで消す。
       マークの上なら そのマーク、ルートの上なら そのルート、
       ルートを引いている途中なら 引きかけの線を取り消す。 */
    canvas.addEventListener('contextmenu', function (e) {
      if (!svgEl()) return;
      e.preventDefault();

      const markEl = e.target.closest('.board-mark');
      if (markEl) {
        BOARD.removeMark(curPhase(), markEl.dataset.mark);
        if (ui.selectedMarkId === markEl.dataset.mark) ui.selectedMarkId = null;
        commitBoard();
        refreshBoard();
        return;
      }

      const routeEl = e.target.closest('[data-route]');
      if (routeEl && routeEl.dataset.route !== 'draft') {
        BOARD.removeRoute(curPhase(), routeEl.dataset.route);
        commitBoard();
        refreshBoard();
        return;
      }

      if (ui.routeTeam) {
        ui.routeTeam = null;
        ui.draftRoute = [];
        refreshBoard();
        return;
      }

      /* 何も無いところなら、選択と「これから置くもの」を解除する */
      if (ui.armed || ui.selectedMarkId) {
        ui.armed = null;
        ui.selectedMarkId = null;
        refreshBoard();
      }
    });

    canvas.addEventListener('pointerdown', function (e) {
      if (!svgEl()) return;
      if (e.button) return;            // 左ボタン（とタッチ）だけ掴める
      const markEl = e.target.closest('.board-mark');
      press = {
        el: markEl || null,
        markId: markEl ? markEl.dataset.mark : null,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        pointerId: e.pointerId
      };
      if (markEl && !ui.routeTeam) {
        try { markEl.setPointerCapture(e.pointerId); } catch (err) { /* 未対応でも動く */ }
      }
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!press) return;

      if (!press.moved) {
        const dx = e.clientX - press.startX;
        const dy = e.clientY - press.startY;
        if (Math.sqrt(dx * dx + dy * dy) < THRESHOLD) return;
        press.moved = true;
        if (press.el) press.el.classList.add('is-dragging');
      }

      /* マークを掴んでいるときだけ動かす */
      if (!press.markId || ui.routeTeam) return;
      const svg = svgEl();
      if (!svg) return;

      const p = BOARD.toBoardPoint(svg, e);
      BOARD.moveMark(curPhase(), press.markId, p.x, p.y);
      const mark = BOARD.findMark(curPhase(), press.markId);
      if (mark) press.el.setAttribute('transform', 'translate(' + mark.x + ',' + mark.y + ')');
      e.preventDefault();
    });

    canvas.addEventListener('pointerup', function (e) {
      const svg = svgEl();
      const current = press;
      press = null;
      if (!svg || !current) return;

      if (current.el) {
        current.el.classList.remove('is-dragging');
        try { current.el.releasePointerCapture(current.pointerId); } catch (err) { /* noop */ }
      }

      /* 動かした = ドラッグ。位置を確定して終わり */
      if (current.moved && current.markId && !ui.routeTeam) {
        commitBoard();
        refreshBoard();
        return;
      }

      const p = BOARD.toBoardPoint(svg, e);

      /* ルート描画中はタップごとに点を足す */
      if (ui.routeTeam) {
        ui.draftRoute.push(p);
        U.renderBoardCanvas(ui);
        return;
      }

      /* 配置するものが選ばれていれば置く */
      if (ui.armed) {
        BOARD.addMark(curPhase(), {
          kind: ui.armed.kind,
          ref: ui.armed.ref,
          team: ui.armed.team,
          x: p.x,
          y: p.y
        });
        commitBoard();
        refreshBoard();
        return;
      }

      /* マークをタップした = 選択の切り替え */
      if (current.markId) {
        ui.selectedMarkId = ui.selectedMarkId === current.markId ? null : current.markId;
        refreshBoard();
        return;
      }

      /* 余白をタップしたら選択を解除 */
      if (ui.selectedMarkId) {
        ui.selectedMarkId = null;
        refreshBoard();
      }
    });

    /* 指が画面外に出るなどして中断された場合も、位置は確定させる */
    canvas.addEventListener('pointercancel', function () {
      const current = press;
      press = null;
      if (!current) return;
      if (current.el) current.el.classList.remove('is-dragging');
      if (current.moved && current.markId) commitBoard();
      refreshBoard();
    });
  }

  /* ================= 共有 ================= */
  function shareOpts() {
    const tac = currentTactic();
    if (!tac) return null;
    return {
      tactic: tac,
      map: S.state.match.map,
      side: S.sideForRound(S.currentRoundNumber()),
      analysis: ui.analysis
    };
  }

  /* ================= セットアップ画面 ================= */
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
      $('roster-ally-name').textContent = e.target.value || t('team.ally.default');
    });
    $('inp-enemy-team').addEventListener('input', function (e) {
      S.state.match.enemyTeam = e.target.value;
      S.save();
      $('roster-enemy-name').textContent = e.target.value || t('team.enemy.default');
    });
    $('inp-match-note').addEventListener('input', function (e) {
      S.state.match.note = e.target.value;
      S.save();
    });

    ['comp-bar-ally', 'comp-bar-enemy'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        const apply = e.target.closest('[data-comp-apply]');
        if (apply) {
          S.applyComp(apply.dataset.compTeam, apply.dataset.compApply);
          ui.analysis = null;
          ui.aiReview = null;
          renderAll();
          return;
        }
        const save = e.target.closest('[data-comp-save]');
        if (!save) return;
        const team = save.dataset.compSave;
        const roster = team === 'enemy' ? S.state.enemies : S.state.allies;
        const name = (prompt(t('comp.namePrompt'), suggestCompName(roster)) || '').trim();
        if (!name) return;
        if (!S.saveComp(name, roster.map(function (s2) { return s2.agent; }))) {
          U.toast(t('comp.limit', { n: S.MAX_COMPS }), 'err');
          return;
        }
        renderAll();
        U.toast(t('comp.saved', { name: name }), 'ok');
      });
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
      U.renderDeck(ui);
    });

    /* 検索。打つたびに絞り込む。件数が多くないので遅延は要らない */
    $('deck-query').addEventListener('input', function (e) {
      ui.deckQuery = e.target.value;
      $('btn-deck-clear').hidden = !ui.deckQuery;
      U.renderDeck(ui);
    });

    $('btn-deck-clear').addEventListener('click', function () {
      ui.deckQuery = '';
      $('deck-query').value = '';
      $('btn-deck-clear').hidden = true;
      U.renderDeck(ui);
      $('deck-query').focus();
    });

    /* 検索欄で Esc を押したら消す。入力欄から出ずに戻せるように */
    $('deck-query').addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !ui.deckQuery) return;
      e.stopPropagation();
      $('btn-deck-clear').click();
    });

    $('deck-group').addEventListener('change', function (e) {
      ui.deckGroup = e.target.value;
      U.renderDeck(ui);
    });

    $('deck-grid').addEventListener('click', function (e) {
      /* 配置盤ボタンが先。押した場所によって開くものが変わる */
      const boardBtn = e.target.closest('[data-board-for]');
      if (boardBtn) {
        e.stopPropagation();
        openBoardEditor(S.tacticById(boardBtn.dataset.boardFor));
        return;
      }
      const card = e.target.closest('.tcard');
      if (card) openTacticModal(card.dataset.id);
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
      U.renderDeck(ui);
      U.renderReady();
      U.toast(t('toast.sampleAdded'), 'ok');
    });

    $('btn-start').addEventListener('click', function () { goPhase('live'); });
  }

  /* ================= ライブ画面 ================= */
  function bindLive() {
    $('stage').addEventListener('click', function (e) {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;

      if (act === 'pick') {
        S.setPending(el.dataset.id, ui.economy);
        ui.analysis = null;
        ui.aiReview = null;
        runAnalysis();
        renderLive();
      } else if (act === 'result') {
        const rec = S.commitRound(el.dataset.result);
        if (rec) {
          U.toast(t('toast.roundRecorded', { n: rec.n, result: t('res.' + rec.result.toLowerCase()) }),
                  rec.result === 'WIN' ? 'ok' : 'err');
        }
        ui.analysis = null;
        ui.aiReview = null;
        renderLive();
      } else if (act === 'change') {
        S.clearPending();
        ui.analysis = null;
        ui.aiReview = null;
        renderLive();
      } else if (act === 'flip-side') {
        S.flipSideForRound(S.currentRoundNumber());
        if (ui.analysis) runAnalysis();
        renderLive();
      } else if (act === 'toggle-offside') {
        ui.includeOffSide = !ui.includeOffSide;
        renderLive();
      } else if (act === 'new-tactic') {
        openTacticModal(null);
      } else if (act === 'eco') {
        ui.economy = el.dataset.eco;
        renderLive();
      } else if (act === 'analyze') {
        runAnalysis();
        renderLive();
      } else if (act === 'ai-review') {
        runAiReview();
      } else if (act === 'share-x') {
        const opts = shareOpts();
        if (opts) SHARE.postToX(opts);
      } else if (act === 'share-copy') {
        const opts = shareOpts();
        if (opts) {
          SHARE.copyText(opts).then(function (ok) {
            U.toast(ok ? t('share.copied') : t('toast.exportFailed', { msg: 'clipboard' }), ok ? 'ok' : 'err');
          });
        }
      } else if (act === 'size-up' || act === 'size-down') {
        U.setBoardSizeIndex(U.boardSizeIndex() + (act === 'size-up' ? 1 : -1));
        renderLive();
      } else if (act === 'live-phase') {
        ui.livePhase = Number(el.dataset.phaseIndex) || 0;
        renderLive();
      } else if (act === 'edit-board') {
        openBoardEditor(currentTactic());
      } else if (act === 'share-post') {
        openPostModal(S.state.pending ? S.state.pending.tacticId : null);
      }
    });

    $('btn-undo').addEventListener('click', function () {
      const last = S.undoLastRound();
      if (!last) { U.toast(t('toast.noUndo'), 'err'); return; }
      ui.analysis = null;
      ui.aiReview = null;
      U.toast(t('toast.undone', { n: last.n }));
      renderLive();
    });

    /* 決着バナー内のボタンは再描画で作り直されるため、委譲で拾う */
    $('match-banner').addEventListener('click', function (e) {
      if (!e.target.closest('#btn-next-match')) return;
      if (!confirm(t('confirm.resetMatch'))) return;
      S.resetMatch();
      ui.analysis = null;
      ui.aiReview = null;
      renderLive();
      U.toast(t('toast.matchReset'));
    });

    $('btn-reset-match').addEventListener('click', function () {
      if (!confirm(t('confirm.resetMatch'))) return;
      S.resetMatch();
      ui.analysis = null;
      ui.aiReview = null;
      renderLive();
      U.toast(t('toast.matchReset'));
    });
  }

  /* ================= コミュニティ ================= */
  function loadPosts() {
    if (!C.enabled()) {
      U.renderPosts([], t('community.disabled'));
      return;
    }
    U.renderPosts([], t('common.loading'));
    C.listPosts({ sort: ui.postSort, map: ui.postMap }).then(function (rows) {
      ui.posts = Array.isArray(rows) ? rows : [];
      U.renderPosts(ui.posts);
    }, function (err) {
      U.renderPosts([], t('community.postFailed', { msg: err.message }));
    });
  }

  function openPostModal(tacticId) {
    if (!C.enabled()) { U.toast(t('community.disabled'), 'err'); return; }
    if (!S.state.tactics.length) { U.toast(t('toast.nameRequired'), 'err'); return; }
    ui.postTacticId = tacticId || S.state.tactics[0].id;
    U.renderPostForm(ui.postTacticId);
    $('post-author').value = C.displayName() || '';
    updatePostPreview();
    openModal('modal-post');
  }

  function updatePostPreview() {
    const tac = S.tacticById(ui.postTacticId);
    if (!tac) { U.renderPostPreview(null); return; }
    const analysis = ANALYST.analyze({
      tactic: tac,
      allies: S.state.allies,
      enemies: S.state.enemies,
      map: S.state.match.map,
      side: S.sideForRound(S.currentRoundNumber())
    });
    U.renderPostPreview(tac, analysis);
    return analysis;
  }

  function bindCommunity() {
    $('community-sort').addEventListener('click', function (e) {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      ui.postSort = chip.dataset.sort;
      $('community-sort').querySelectorAll('.chip').forEach(function (c) {
        c.classList.toggle('is-active', c === chip);
      });
      loadPosts();
    });

    $('community-map').addEventListener('change', function (e) {
      ui.postMap = e.target.value;
      loadPosts();
    });

    $('btn-open-post').addEventListener('click', function () { openPostModal(null); });

    $('community-account').addEventListener('click', function (e) {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      if (el.dataset.act === 'login') openModal('modal-login');
      else if (el.dataset.act === 'logout') {
        C.signOut().then(function () { renderCommunity(); });
      }
    });

    $('post-grid').addEventListener('click', function (e) {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const post = ui.posts.filter(function (p) { return String(p.id) === el.dataset.id; })[0];
      if (!post) return;

      if (el.dataset.act === 'like') {
        C.likePost(post.id).then(function (likes) {
          post.likes = typeof likes === 'number' ? likes : (post.likes || 0) + 1;
          U.renderPosts(ui.posts);
        }, function (err) { U.toast(err.message, 'err'); });
      } else if (el.dataset.act === 'import-post') {
        S.addTactic({
          name: post.name,
          side: post.side,
          site: post.site,
          kind: post.kind,
          note: post.note
        });
        U.toast(t('community.imported'), 'ok');
      }
    });

    $('post-tactic').addEventListener('change', function (e) {
      ui.postTacticId = e.target.value;
      updatePostPreview();
    });

    $('post-form').addEventListener('submit', function (e) {
      e.preventDefault();
      const tac = S.tacticById(ui.postTacticId);
      if (!tac) return;
      const analysis = updatePostPreview();

      C.createPost({
        name: tac.name,
        map: S.state.match.map,
        side: tac.side,
        site: tac.site,
        kind: tac.kind,
        note: tac.note,
        authorName: ($('post-author').value || '').trim() || 'ANONYMOUS',
        lang: I.get(),
        allyComp: S.state.allies.map(function (s) { return s.agent; }).filter(Boolean),
        enemyComp: S.state.enemies.map(function (s) { return s.agent; }).filter(Boolean),
        analysisScore: analysis && analysis.ready ? analysis.score : null
      }).then(function () {
        closeModal('modal-post');
        U.toast(t('community.posted'), 'ok');
        if (ui.view === 'community') loadPosts();
      }, function (err) {
        U.toast(t('community.postFailed', { msg: err.message }), 'err');
      });
    });

    $('btn-login-discord').addEventListener('click', function () {
      C.signInWithProvider('discord');
    });

    $('btn-login-email').addEventListener('click', function () {
      const email = ($('login-email').value || '').trim();
      if (!email) return;
      C.signInWithEmail(email).then(function () {
        closeModal('modal-login');
        U.toast(t('community.loginEmail') + ' ✓', 'ok');
      }, function (err) { U.toast(err.message, 'err'); });
    });
  }

  /* ================= エージェント / 戦術モーダル ================= */
  function bindAgentModal() {
    function refreshGrid() {
      const slot = ui.agentTarget ? rosterOf(ui.agentTarget.team)[ui.agentTarget.index] : { agent: '' };
      U.renderAgentGrid({ query: ui.agentQuery, role: ui.agentRole, current: slot.agent });
    }

    $('agent-search').addEventListener('input', function (e) {
      ui.agentQuery = e.target.value;
      refreshGrid();
    });

    $('role-filter').addEventListener('click', function (e) {
      const chip = e.target.closest('.role-chip');
      if (!chip) return;
      ui.agentRole = chip.dataset.role;
      U.renderRoleFilter(ui.agentRole);
      refreshGrid();
    });

    $('agent-grid').addEventListener('click', function (e) {
      const opt = e.target.closest('.agent-opt');
      if (!opt || !ui.agentTarget) return;
      const team = ui.agentTarget.team;
      const index = ui.agentTarget.index;
      const slot = rosterOf(team)[index];
      slot.agent = opt.dataset.agent;
      slot.player = $('agent-player').value.trim();
      S.save();
      ui.analysis = null;
      ui.aiReview = null;

      /* エージェントセレクトは 30 秒しかない。1 体ごとに閉じて開き直すのでは
         間に合わないので、空いている次のスロットへそのまま送る。
         全部埋まったら閉じる */
      const nextIndex = nextEmptySlot(team, index);
      if (nextIndex < 0) {
        closeModal('modal-agent');
        renderAll();
        return;
      }
      renderAll();
      openAgentModal(team, nextIndex);
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
      ui.analysis = null;
      closeModal('modal-agent');
      renderAll();
    });
  }

  function bindTacticModal() {
    ['t-side', 't-site'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        const btn = e.target.closest('button');
        if (btn) U.setSegActive($(id), btn.dataset.val);
      });
    });

    /* 入力内容を保存して、保存できた戦術を返す。保存できなければ null */
    function saveTacticForm(quiet) {
      const name = $('t-name').value.trim();
      if (!name) { U.toast(t('toast.nameRequired'), 'err'); return null; }
      const payload = {
        name: name,
        side: U.segValue($('t-side')) || 'BOTH',
        site: U.segValue($('t-site')) || '-',
        kind: $('t-kind').value,
        note: $('t-note').value.trim()
      };
      let tac;
      if (ui.editingTacticId) {
        S.updateTactic(ui.editingTacticId, payload);
        tac = S.tacticById(ui.editingTacticId);
        if (!quiet) U.toast(t('toast.tacticUpdated'), 'ok');
      } else {
        tac = S.addTactic(payload);
        if (!tac) {
          U.toast(t('tactic.limitReached', { n: S.tacticLimit() }), 'err');
          return null;
        }
        if (!quiet) U.toast(t('toast.tacticAdded'), 'ok');
      }
      ui.editingTacticId = null;
      ui.analysis = null;
      closeModal('modal-tactic');
      renderAll();
      return tac;
    }

    $('tactic-form').addEventListener('submit', function (e) {
      e.preventDefault();
      saveTacticForm(false);
    });

    /* 新規作成中はまだ戦術が存在しないので、先に保存してから配置盤を開く */
    $('btn-tactic-board').addEventListener('click', function () {
      const tac = saveTacticForm(true);
      if (tac) openBoardEditor(tac);
    });

    $('btn-delete-tactic').addEventListener('click', function () {
      if (!ui.editingTacticId) return;
      const tac = S.tacticById(ui.editingTacticId);
      if (!confirm(t('confirm.deleteTactic', { name: tac ? tac.name : '' }))) return;
      S.removeTactic(ui.editingTacticId);
      ui.editingTacticId = null;
      closeModal('modal-tactic');
      renderAll();
      U.toast(t('toast.tacticDeleted'));
    });
  }

  /* ================= 書き出し ================= */
  function exportFileName() {
    const map = D.mapById(S.state.match.map);
    return 'valorant-setup-card_' + (map ? map.name.toLowerCase() : 'match') + '.json';
  }

  function exportData() {
    const json = S.exportJSON();
    const filename = exportFileName();

    /* 公開ページ上ではビューアーに確認を出してから保存する */
    if (downloadsApi) {
      downloadsApi.save({ filename: filename, data: json }).then(function () {
        U.toast(t('toast.exported'), 'ok');
      }, function (err) {
        if (err && err.code === 'declined') U.toast(t('toast.exportCancelled'));
        else U.toast(t('toast.exportFailed', { msg: (err && err.message) || '' }), 'err');
      });
      return;
    }

    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    U.toast(t('toast.exported'), 'ok');
  }

  /* ================= 共通イベント ================= */
  function bindGlobal() {
    document.querySelectorAll('.phase-tab').forEach(function (tab) {
      tab.addEventListener('click', function () { goPhase(tab.dataset.phase); });
    });

    $('lang-select').addEventListener('change', function (e) {
      I.set(e.target.value);
    });

    I.onChange(function () {
      I.applyDom();
      U.renderLangPicker();
      renderAll();
    });

    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) closeAllModals();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        /* 配置盤では、まず選択やルート描画を解除する。
           いきなり閉じると描きかけが消えて戸惑う。 */
        if (!$('modal-board').hidden && (ui.armed || ui.routeTeam)) {
          ui.armed = null;
          ui.routeTeam = null;
          ui.draftRoute = [];
          refreshBoard();
          return;
        }
        closeAllModals();
        return;
      }

      /* 配置盤で選択中のマークは Delete で消せる */
      if (!$('modal-board').hidden && ui.selectedMarkId &&
          (e.key === 'Delete' || e.key === 'Backspace')) {
        BOARD.removeMark(curPhase(), ui.selectedMarkId);
        ui.selectedMarkId = null;
        commitBoard();
        refreshBoard();
        e.preventDefault();
        return;
      }

      const modalOpen = ['modal-agent', 'modal-tactic', 'modal-post', 'modal-login', 'modal-board', 'modal-cloud', 'modal-tree']
        .some(function (id) { return !$(id).hidden; });
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (modalOpen || typing || ui.view !== 'live') return;

      if (S.state.pending) {
        if (e.key === 'w' || e.key === 'W') {
          const rec = S.commitRound('WIN');
          ui.analysis = null; ui.aiReview = null;
          renderLive();
          if (rec) U.toast(t('toast.roundRecorded', { n: rec.n, result: t('res.win') }), 'ok');
        } else if (e.key === 'l' || e.key === 'L') {
          const rec = S.commitRound('LOSS');
          ui.analysis = null; ui.aiReview = null;
          renderLive();
          if (rec) U.toast(t('toast.roundRecorded', { n: rec.n, result: t('res.loss') }), 'err');
        }
      } else if (/^[1-9]$/.test(e.key)) {
        const picks = $('stage').querySelectorAll('.pick');
        const target = picks[Number(e.key) - 1];
        if (target) target.click();
      }
    });

    $('btn-export').addEventListener('click', exportData);

    $('btn-import').addEventListener('click', function () { $('file-import').click(); });
    $('file-import').addEventListener('change', function (e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function () {
        try {
          S.importJSON(String(reader.result));
          ui.view = S.state.phase;
          ui.analysis = null;
          renderAll();
          U.toast(t('toast.imported'), 'ok');
        } catch (err) {
          U.toast(t('toast.importFailed', { msg: err.message }), 'err');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    $('btn-reset-all').addEventListener('click', function () {
      if (!confirm(t('confirm.resetAll'))) return;
      S.resetAll();
      ui.deckFilter = 'ALL';
      ui.view = 'setup';
      ui.analysis = null;
      renderAll();
      U.toast(t('toast.resetAll'));
    });
  }

  /* ================= 起動 ================= */
  function init() {
    I.set(I.detect());
    I.applyDom();
    U.renderLangPicker();

    const restored = S.load();
    if (!restored && S.state.tactics.length === 0) {
      S.seedSamples();   // 初回起動時は雛形を入れて操作感を掴めるようにする
    }
    ui.view = S.state.phase === 'live' ? 'live' : 'setup';

    bindSetup();
    bindLive();
    bindCommunity();
    bindCloud();
    bindTree();
    bindBoardEditor();
    bindAgentModal();
    bindTacticModal();
    bindGlobal();
    renderAll();

    /* コミュニティが設定されていればセッションを復元する */
    if (C.enabled()) {
      C.init().then(function () { renderAll(); });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);

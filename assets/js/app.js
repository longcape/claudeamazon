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
  const ui = {
    view: 'setup',            // 'setup' | 'live' | 'community'
    deckFilter: 'ALL',
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

    /* 配置盤エディタ */
    boardTactic: null,        // 編集中の戦術
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
    ['modal-agent', 'modal-tactic', 'modal-post', 'modal-login', 'modal-board'].forEach(closeModal);
  }

  function rosterOf(team) { return team === 'ally' ? S.state.allies : S.state.enemies; }

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

  /* ================= 配置盤 ================= */
  function openBoardEditor(tactic) {
    if (!tactic) return;
    ui.boardTactic = tactic;
    ui.boardSide = S.sideForRound(S.currentRoundNumber());
    ui.armed = null;
    ui.selectedMarkId = null;
    ui.routeTeam = null;
    ui.draftRoute = [];
    BOARD.ensure(tactic);
    U.renderBoardEditor(ui);
    openModal('modal-board');
  }

  function refreshBoard() {
    U.renderBoardCanvas(ui);
    U.renderBoardTools(ui);
    U.renderBoardHint(ui);
    U.renderBoardPalette('ally', ui);
    U.renderBoardPalette('enemy', ui);
  }

  function commitBoard() {
    S.save();
    if (ui.view === 'live') renderLive();
  }

  function bindBoardEditor() {
    /* パレット: 押すと「これから置くもの」を選択する */
    ['board-palette-ally', 'board-palette-enemy'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        const btn = e.target.closest('[data-place-kind]');
        if (!btn) return;
        const next = {
          kind: btn.dataset.placeKind,
          ref: btn.dataset.placeRef,
          team: btn.dataset.placeTeam
        };
        /* トグルにすると、同じスキルを 2 つ置きたいとき
           2 回目の選択が解除になってしまう（オーメンのスモークなど）。
           選択は常に上書きし、解除は専用ボタンで行う。 */
        ui.armed = next;
        ui.selectedMarkId = null;
        refreshBoard();
      });
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
          BOARD.addRoute(ui.boardTactic, ui.routeTeam, ui.draftRoute);
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
        BOARD.bumpOrder(ui.boardTactic, ui.selectedMarkId, act === 'order-up' ? -1 : 1);
        commitBoard();
      } else if (act === 'delete-mark') {
        BOARD.removeMark(ui.boardTactic, ui.selectedMarkId);
        ui.selectedMarkId = null;
        commitBoard();
      }
      refreshBoard();
    });

    $('btn-board-clear').addEventListener('click', function () {
      if (!ui.boardTactic) return;
      if (!confirm(t('board.confirmClear'))) return;
      BOARD.clearBoard(ui.boardTactic);
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

    canvas.addEventListener('pointerdown', function (e) {
      if (!svgEl()) return;
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
      BOARD.moveMark(ui.boardTactic, press.markId, p.x, p.y);
      const mark = BOARD.findMark(ui.boardTactic, press.markId);
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
        BOARD.addMark(ui.boardTactic, {
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
      U.renderDeck(ui.deckFilter);
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
      const slot = rosterOf(ui.agentTarget.team)[ui.agentTarget.index];
      slot.agent = opt.dataset.agent;
      slot.player = $('agent-player').value.trim();
      S.save();
      ui.analysis = null;
      ui.aiReview = null;
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

    $('tactic-form').addEventListener('submit', function (e) {
      e.preventDefault();
      const name = $('t-name').value.trim();
      if (!name) { U.toast(t('toast.nameRequired'), 'err'); return; }
      const payload = {
        name: name,
        side: U.segValue($('t-side')) || 'BOTH',
        site: U.segValue($('t-site')) || '-',
        kind: $('t-kind').value,
        note: $('t-note').value.trim()
      };
      if (ui.editingTacticId) {
        S.updateTactic(ui.editingTacticId, payload);
        U.toast(t('toast.tacticUpdated'), 'ok');
      } else {
        const created = S.addTactic(payload);
        if (!created) {
          U.toast(t('tactic.limitReached', { n: S.tacticLimit() }), 'err');
          return;
        }
        U.toast(t('toast.tacticAdded'), 'ok');
      }
      ui.editingTacticId = null;
      ui.analysis = null;
      closeModal('modal-tactic');
      renderAll();
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

      const modalOpen = ['modal-agent', 'modal-tactic', 'modal-post', 'modal-login', 'modal-board']
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

/* =========================================================
   AGENT TACTICAL TRAITS
   相性判定エンジンが参照する、エージェントの戦術的な性質。
   「何ができるか(provides)」と「何に強いか(counters)」を
   タグとして持たせ、構成単位で集計する。
   ---------------------------------------------------------
   provides タグ:
     smoke      視界を切る（設置型スモーク）
     wall       進路を物理/視界的に封鎖する壁
     flash      閃光でピークを通す
     stun       スタン・デシベル等の妨害
     recon      索敵（相手位置の露出）
     molly      範囲ダメージによる地点排除
     entry      先陣を切って撃ち合う適性
     mobility   高速な移動・再配置
     trap       設置物による監視・足止め
     info       設置型の情報収集（カメラ等）
     heal       回復・蘇生
     postplant  設置後の地点維持に強い
     antitrap   相手の設置物を破壊しやすい
     antiutil   相手のアビリティを封じる
     teleport   瞬間移動による裏取り・撤退
     lineup     定点ユーティリティによる遠隔妨害
     opflex     オペレーター運用と相性が良い
     deceive    フェイク・欺瞞に使える手段
   ========================================================= */
(function (global) {
  'use strict';

  const TRAITS = {
    /* --- DUELIST --- */
    jett:      { provides: ['entry', 'mobility', 'smoke', 'opflex'], note: 'entry.jett' },
    phoenix:   { provides: ['entry', 'flash', 'molly', 'wall', 'heal'], note: 'entry.phoenix' },
    raze:      { provides: ['entry', 'molly', 'mobility', 'antitrap'], note: 'entry.raze' },
    reyna:     { provides: ['entry', 'flash', 'heal'], note: 'entry.reyna' },
    yoru:      { provides: ['entry', 'flash', 'teleport', 'deceive', 'recon'], note: 'entry.yoru' },
    neon:      { provides: ['entry', 'mobility', 'stun', 'wall'], note: 'entry.neon' },
    iso:       { provides: ['entry', 'mobility'], note: 'entry.iso' },
    waylay:    { provides: ['entry', 'mobility', 'flash'], note: 'entry.waylay' },

    /* --- INITIATOR --- */
    sova:      { provides: ['recon', 'molly', 'lineup'], note: 'init.sova' },
    breach:    { provides: ['flash', 'stun', 'molly'], note: 'init.breach' },
    skye:      { provides: ['flash', 'recon', 'heal'], note: 'init.skye' },
    kayo:      { provides: ['flash', 'molly', 'recon', 'antiutil'], note: 'init.kayo' },
    fade:      { provides: ['recon', 'stun', 'molly'], note: 'init.fade' },
    gekko:     { provides: ['flash', 'stun', 'recon', 'molly'], note: 'init.gekko' },
    tejo:      { provides: ['recon', 'molly', 'stun', 'lineup'], note: 'init.tejo' },

    /* --- CONTROLLER --- */
    brimstone: { provides: ['smoke', 'molly', 'postplant', 'lineup'], note: 'ctrl.brimstone' },
    omen:      { provides: ['smoke', 'flash', 'teleport', 'deceive'], note: 'ctrl.omen' },
    viper:     { provides: ['smoke', 'wall', 'molly', 'postplant', 'lineup'], note: 'ctrl.viper' },
    astra:     { provides: ['smoke', 'stun', 'wall', 'postplant'], note: 'ctrl.astra' },
    harbor:    { provides: ['smoke', 'wall', 'stun', 'postplant'], note: 'ctrl.harbor' },
    clove:     { provides: ['smoke', 'heal', 'entry'], note: 'ctrl.clove' },
    /* ミクス: 遠隔設置スモーク + バトルスティム + スタン/回復の切替 + ノックバックULT */
    miks:      { provides: ['smoke', 'heal', 'stun', 'lineup'], note: 'ctrl.miks' },

    /* --- SENTINEL --- */
    killjoy:   { provides: ['trap', 'molly', 'postplant', 'info'], note: 'sent.killjoy' },
    cypher:    { provides: ['trap', 'info', 'smoke', 'recon'], note: 'sent.cypher' },
    sage:      { provides: ['wall', 'heal', 'stun', 'postplant'], note: 'sent.sage' },
    chamber:   { provides: ['trap', 'teleport', 'opflex'], note: 'sent.chamber' },
    deadlock:  { provides: ['trap', 'wall', 'stun', 'info'], note: 'sent.deadlock' },
    vyse:      { provides: ['trap', 'wall', 'antiutil', 'info'], note: 'sent.vyse' },
    /* ヴィトー: 拘束トラップ + 設置点へのテレポート + アビリティ無効化 + 回復ULT */
    veto:      { provides: ['trap', 'antiutil', 'teleport', 'stun', 'heal'], note: 'sent.veto' }
  };

  /** 構成 5 体の provides タグを集計する */
  function aggregate(slots) {
    const counts = {};
    const agents = [];
    (slots || []).forEach(function (slot) {
      const id = slot && slot.agent;
      if (!id || !TRAITS[id]) return;
      agents.push(id);
      TRAITS[id].provides.forEach(function (tag) {
        counts[tag] = (counts[tag] || 0) + 1;
      });
    });

    const roleCounts = { duelist: 0, initiator: 0, controller: 0, sentinel: 0 };
    agents.forEach(function (id) {
      const agent = global.VCT_DATA.agentById(id);
      if (agent) roleCounts[agent.role]++;
    });

    return {
      agents: agents,
      has: function (tag) { return (counts[tag] || 0) > 0; },
      count: function (tag) { return counts[tag] || 0; },
      hasAgent: function (id) { return agents.indexOf(id) >= 0; },
      roles: roleCounts,
      size: agents.length
    };
  }

  global.VCT_TRAITS = { TRAITS: TRAITS, aggregate: aggregate };
})(window);

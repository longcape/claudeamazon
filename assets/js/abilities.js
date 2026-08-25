/* =========================================================
   AGENT ABILITIES
   ---------------------------------------------------------
   配置盤とスキルセットで使う、エージェントごとのアビリティ。
   スロット（C / Q / E / X）は仕様として安定しているが、
   名称は パッチや翻訳で変わりうる。

   `node tools/fetch-assets.mjs` を実行すると、公式 API から
   正式名称（日本語含む）を取得して official-assets.js が
   ここを上書きする。取得前は下の既定値が使われる。
   ========================================================= */
(function (global) {
  'use strict';

  /* fetch-assets.mjs が { 'jett:C': '雲隠れ', ... } を書き込む */
  const OFFICIAL_NAMES = {};

  /* スロットの表示順。X はアルティメット */
  const SLOTS = ['C', 'Q', 'E', 'X'];

  const ABILITIES = {
    /* --- DUELIST --- */
    jett:      { C: 'Cloudburst',      Q: 'Updraft',        E: 'Tailwind',       X: 'Blade Storm' },
    phoenix:   { C: 'Blaze',           Q: 'Curveball',      E: 'Hot Hands',      X: 'Run It Back' },
    raze:      { C: 'Boom Bot',        Q: 'Blast Pack',     E: 'Paint Shells',   X: 'Showstopper' },
    reyna:     { C: 'Leer',            Q: 'Devour',         E: 'Dismiss',        X: 'Empress' },
    yoru:      { C: 'Fakeout',         Q: 'Blindside',      E: 'Gatecrash',      X: 'Dimensional Drift' },
    neon:      { C: 'Fast Lane',       Q: 'Relay Bolt',     E: 'High Gear',      X: 'Overdrive' },
    iso:       { C: 'Contingency',     Q: 'Undercut',       E: 'Double Tap',     X: 'Kill Contract' },
    waylay:    { C: 'Refract',         Q: 'Lightspeed',     E: 'Saturate',       X: 'Convergent Paths' },

    /* --- INITIATOR --- */
    sova:      { C: 'Owl Drone',       Q: 'Shock Bolt',     E: 'Recon Bolt',     X: "Hunter's Fury" },
    breach:    { C: 'Aftershock',      Q: 'Flashpoint',     E: 'Fault Line',     X: 'Rolling Thunder' },
    skye:      { C: 'Regrowth',        Q: 'Trailblazer',    E: 'Guiding Light',  X: 'Seekers' },
    kayo:      { C: 'FRAG/ment',       Q: 'FLASH/drive',    E: 'ZERO/point',     X: 'NULL/cmd' },
    fade:      { C: 'Prowler',         Q: 'Seize',          E: 'Haunt',          X: 'Nightfall' },
    gekko:     { C: 'Mosh Pit',        Q: 'Wingman',        E: 'Dizzy',          X: 'Thrash' },
    tejo:      { C: 'Special Delivery', Q: 'Guided Salvo',  E: 'Stealth Drone',  X: 'Armageddon' },

    /* --- CONTROLLER --- */
    brimstone: { C: 'Stim Beacon',     Q: 'Incendiary',     E: 'Sky Smoke',      X: 'Orbital Strike' },
    omen:      { C: 'Shrouded Step',   Q: 'Paranoia',       E: 'Dark Cover',     X: 'From the Shadows' },
    viper:     { C: 'Snake Bite',      Q: 'Poison Cloud',   E: 'Toxic Screen',   X: "Viper's Pit" },
    astra:     { C: 'Gravity Well',    Q: 'Nova Pulse',     E: 'Nebula',         X: 'Cosmic Divide' },
    harbor:    { C: 'Cascade',         Q: 'Cove',           E: 'High Tide',      X: 'Reckoning' },
    clove:     { C: 'Pick-me-up',      Q: 'Meddle',         E: 'Ruse',           X: 'Not Dead Yet' },
    miks:      { C: 'M-Pulse',         Q: 'Harmonize',      E: 'Waveform',       X: 'Base Quake' },

    /* --- SENTINEL --- */
    killjoy:   { C: 'Nanoswarm',       Q: 'Alarmbot',       E: 'Turret',         X: 'Lockdown' },
    cypher:    { C: 'Trapwire',        Q: 'Cyber Cage',     E: 'Spycam',         X: 'Neural Theft' },
    sage:      { C: 'Barrier Orb',     Q: 'Slow Orb',       E: 'Healing Orb',    X: 'Resurrection' },
    chamber:   { C: 'Trademark',       Q: 'Headhunter',     E: 'Rendezvous',     X: 'Tour De Force' },
    deadlock:  { C: 'GravNet',         Q: 'Sonic Sensor',   E: 'Barrier Mesh',   X: 'Annihilation' },
    vyse:      { C: 'Shear',           Q: 'Arc Rose',       E: 'Razorvine',      X: 'Steel Garden' },
    veto:      { C: 'Chokehold',       Q: 'Crosscut',       E: 'Interceptor',    X: 'Evolution' }
  };

  /**
   * 同時に置ける数の上限。
   * オーメンのスモークのように「1 つずつしか出せない」ものは、
   * 配置盤で順番を意識する必要があるため上限を持たせる。
   * 未指定は 1（順番を気にせず置ける）。
   */
  const CHARGES = {
    'jett:C': 2, 'jett:Q': 2, 'jett:E': 3,
    'phoenix:C': 1, 'phoenix:Q': 2,
    'raze:Q': 2,
    'reyna:C': 2, 'reyna:Q': 4, 'reyna:E': 2,
    'yoru:C': 2, 'yoru:Q': 2,
    'neon:Q': 2,
    'iso:Q': 2,
    'sova:Q': 2, 'sova:E': 2,
    'breach:C': 2, 'breach:Q': 2,
    'skye:Q': 1, 'skye:E': 2,
    'kayo:C': 2, 'kayo:Q': 2,
    'fade:C': 2,
    'gekko:C': 1, 'gekko:Q': 1, 'gekko:E': 1,
    'brimstone:Q': 1, 'brimstone:E': 3,
    /* オーメンのスモークは 1 つずつしか展開できない */
    'omen:E': 1, 'omen:C': 2, 'omen:Q': 1,
    'viper:C': 2,
    'astra:E': 4,
    'harbor:C': 2, 'harbor:Q': 1,
    'clove:E': 2,
    'miks:E': 2,
    'killjoy:C': 2,
    'cypher:C': 2, 'cypher:Q': 2,
    'sage:C': 1, 'sage:Q': 2,
    'chamber:Q': 1,
    'deadlock:C': 1, 'deadlock:Q': 2,
    'vyse:Q': 1,
    'veto:C': 1
  };

  function forAgent(agentId) {
    return ABILITIES[agentId] || null;
  }

  /** 表示名。公式名が取得済みならそちらを優先する */
  function nameOf(agentId, slot) {
    const key = agentId + ':' + slot;
    if (OFFICIAL_NAMES[key]) return OFFICIAL_NAMES[key];
    const set = ABILITIES[agentId];
    return set ? (set[slot] || slot) : slot;
  }

  function chargesOf(agentId, slot) {
    return CHARGES[agentId + ':' + slot] || 1;
  }

  /** 配置盤の左右パレットに並べる一覧 */
  function listFor(agentId) {
    const set = ABILITIES[agentId];
    if (!set) return [];
    return SLOTS.filter(function (s) { return set[s]; }).map(function (slot) {
      return {
        slot: slot,
        ref: agentId + ':' + slot,
        name: nameOf(agentId, slot),
        charges: chargesOf(agentId, slot),
        ultimate: slot === 'X'
      };
    });
  }

  global.VCT_ABILITIES = {
    SLOTS: SLOTS,
    ABILITIES: ABILITIES,
    CHARGES: CHARGES,
    OFFICIAL_NAMES: OFFICIAL_NAMES,
    forAgent: forAgent,
    nameOf: nameOf,
    chargesOf: chargesOf,
    listFor: listFor
  };
})(window);

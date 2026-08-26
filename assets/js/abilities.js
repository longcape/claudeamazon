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

  /* 同じく、スロットごとの公式アイコンのパスを書き込む */
  const OFFICIAL_ICONS = {};

  /* スロットの表示順。X はアルティメット */
  const SLOTS = ['C', 'Q', 'E', 'X'];

  const ABILITIES = {
    /* --- DUELIST --- */
    jett:      { C: 'Cloudburst',      Q: 'Updraft',        E: 'Tailwind',       X: 'Blade Storm' },
    phoenix:   { C: 'Blaze', Q: 'Hot Hands', E: 'Curveball', X: 'Run it Back' },
    raze:      { C: 'Boom Bot',        Q: 'Blast Pack',     E: 'Paint Shells',   X: 'Showstopper' },
    reyna:     { C: 'Leer',            Q: 'Devour',         E: 'Dismiss',        X: 'Empress' },
    yoru:      { C: 'FAKEOUT', Q: 'BLINDSIDE', E: 'GATECRASH', X: 'DIMENSIONAL DRIFT' },
    neon:      { C: 'Fast Lane',       Q: 'Relay Bolt',     E: 'High Gear',      X: 'Overdrive' },
    iso:       { C: 'Contingency',     Q: 'Undercut',       E: 'Double Tap',     X: 'Kill Contract' },
    waylay:    { C: 'Saturate', Q: 'Lightspeed', E: 'Refract', X: 'Convergent Paths' },

    /* --- INITIATOR --- */
    sova:      { C: 'Owl Drone',       Q: 'Shock Bolt',     E: 'Recon Bolt',     X: "Hunter's Fury" },
    breach:    { C: 'Aftershock',      Q: 'Flashpoint',     E: 'Fault Line',     X: 'Rolling Thunder' },
    skye:      { C: 'Regrowth',        Q: 'Trailblazer',    E: 'Guiding Light',  X: 'Seekers' },
    kayo:      { C: 'FRAG/ment',       Q: 'FLASH/drive',    E: 'ZERO/point',     X: 'NULL/cmd' },
    fade:      { C: 'Prowler',         Q: 'Seize',          E: 'Haunt',          X: 'Nightfall' },
    gekko:     { C: 'Mosh Pit',        Q: 'Wingman',        E: 'Dizzy',          X: 'Thrash' },
    tejo:      { C: 'Stealth Drone', Q: 'Special Delivery', E: 'Guided Salvo', X: 'Armageddon' },

    /* --- CONTROLLER --- */
    brimstone: { C: 'Stim Beacon',     Q: 'Incendiary',     E: 'Sky Smoke',      X: 'Orbital Strike' },
    omen:      { C: 'Shrouded Step',   Q: 'Paranoia',       E: 'Dark Cover',     X: 'From the Shadows' },
    viper:     { C: 'Snake Bite',      Q: 'Poison Cloud',   E: 'Toxic Screen',   X: "Viper's Pit" },
    astra:     { C: 'Gravity Well', Q: 'Nova Pulse', E: 'Nebula  / Dissipate', X: 'Astral Form / Cosmic Divide' },
    harbor:    { C: 'Storm Surge', Q: 'High Tide', E: 'Cove', X: 'Reckoning' },
    clove:     { C: 'Pick-me-up',      Q: 'Meddle',         E: 'Ruse',           X: 'Not Dead Yet' },
    miks:      { C: 'M-pulse', Q: 'Harmonize', E: 'Waveform', X: 'Bassquake' },

    /* --- SENTINEL --- */
    killjoy:   { C: 'Nanoswarm', Q: 'ALARMBOT', E: 'TURRET', X: 'Lockdown' },
    cypher:    { C: 'Trapwire',        Q: 'Cyber Cage',     E: 'Spycam',         X: 'Neural Theft' },
    sage:      { C: 'Barrier Orb',     Q: 'Slow Orb',       E: 'Healing Orb',    X: 'Resurrection' },
    chamber:   { C: 'Trademark',       Q: 'Headhunter',     E: 'Rendezvous',     X: 'Tour De Force' },
    deadlock:  { C: 'Barrier Mesh', Q: 'Sonic Sensor', E: 'GravNet', X: 'Annihilation' },
    vyse:      { C: 'Razorvine', Q: 'Shear', E: 'Arc Rose', X: 'Steel Garden' },
    veto:      { C: 'Crosscut', Q: 'Chokehold', E: 'Interceptor', X: 'Evolution' }
  };

  /*
     同時展開数（チャージ）はパッチごとに変わるうえ、公式 API では
     配信されていない。手書きで持つと必ず古くなり、
     ネオンのリレーボルトのように誤った数を表示してしまう。
     配置盤では置いた数と使用順で意図が伝わるため、表示自体をやめている。
  */

  function forAgent(agentId) {
    return ABILITIES[agentId] || null;
  }

  /**
   * 表示名。公式名が取得済みならそちらを優先する。
   * OFFICIAL_NAMES は { ja: { 'jett:C': '...' }, en: {...} } の形。
   * 表示中の言語 → 英語 → 内蔵の既定値、の順に解決する。
   */
  function nameOf(agentId, slot) {
    const key = agentId + ':' + slot;
    const lang = global.VCT_I18N ? global.VCT_I18N.get() : 'en';

    const table = OFFICIAL_NAMES[lang] || OFFICIAL_NAMES[String(lang).split('-')[0]];
    if (table && table[key]) return table[key];
    if (OFFICIAL_NAMES.en && OFFICIAL_NAMES.en[key]) return OFFICIAL_NAMES.en[key];

    const set = ABILITIES[agentId];
    return set ? (set[slot] || slot) : slot;
  }

  /** 公式のアビリティアイコン。取得前は null */
  function iconOf(agentId, slot) {
    return OFFICIAL_ICONS[agentId + ':' + slot] || null;
  }

  function hasIcons() {
    return Object.keys(OFFICIAL_ICONS).length > 0;
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
        icon: iconOf(agentId, slot),
        ultimate: slot === 'X'
      };
    });
  }

  global.VCT_ABILITIES = {
    SLOTS: SLOTS,
    ABILITIES: ABILITIES,
    OFFICIAL_NAMES: OFFICIAL_NAMES,
    OFFICIAL_ICONS: OFFICIAL_ICONS,
    iconOf: iconOf,
    hasIcons: hasIcons,
    forAgent: forAgent,
    nameOf: nameOf,
    listFor: listFor
  };
})(window);

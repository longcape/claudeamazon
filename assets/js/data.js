/* =========================================================
   VALORANT TACTICAL SETUP CARD  /  static data
   エージェント・マップ・戦術タグなどのマスタデータ
   ========================================================= */
(function (global) {
  'use strict';

  /* ロール定義（カラーはボード全体のアクセントに使用） */
  const ROLES = {
    duelist:    { id: 'duelist',    label: 'DUELIST',    jp: 'デュエリスト',   color: '#FF4655' },
    initiator:  { id: 'initiator',  label: 'INITIATOR',  jp: 'イニシエーター', color: '#F5A623' },
    controller: { id: 'controller', label: 'CONTROLLER', jp: 'コントローラー', color: '#8B7BFF' },
    sentinel:   { id: 'sentinel',   label: 'SENTINEL',   jp: 'センチネル',     color: '#22D3A6' }
  };

  /* エージェント一覧（id / 表示名 / 略号 / ロール） */
  const AGENTS = [
    { id: 'jett',      name: 'JETT',      jp: 'ジェット',       abbr: 'JT', role: 'duelist' },
    { id: 'phoenix',   name: 'PHOENIX',   jp: 'フェニックス',   abbr: 'PX', role: 'duelist' },
    { id: 'raze',      name: 'RAZE',      jp: 'レイズ',         abbr: 'RZ', role: 'duelist' },
    { id: 'reyna',     name: 'REYNA',     jp: 'レイナ',         abbr: 'RY', role: 'duelist' },
    { id: 'yoru',      name: 'YORU',      jp: 'ヨル',           abbr: 'YR', role: 'duelist' },
    { id: 'neon',      name: 'NEON',      jp: 'ネオン',         abbr: 'NE', role: 'duelist' },
    { id: 'iso',       name: 'ISO',       jp: 'アイソ',         abbr: 'IS', role: 'duelist' },
    { id: 'waylay',    name: 'WAYLAY',    jp: 'ウェイレイ',     abbr: 'WL', role: 'duelist' },

    { id: 'sova',      name: 'SOVA',      jp: 'ソーヴァ',       abbr: 'SV', role: 'initiator' },
    { id: 'breach',    name: 'BREACH',    jp: 'ブリーチ',       abbr: 'BR', role: 'initiator' },
    { id: 'skye',      name: 'SKYE',      jp: 'スカイ',         abbr: 'SK', role: 'initiator' },
    { id: 'kayo',      name: 'KAY/O',     jp: 'ケイオー',       abbr: 'KO', role: 'initiator' },
    { id: 'fade',      name: 'FADE',      jp: 'フェイド',       abbr: 'FD', role: 'initiator' },
    { id: 'gekko',     name: 'GEKKO',     jp: 'ゲッコー',       abbr: 'GK', role: 'initiator' },
    { id: 'tejo',      name: 'TEJO',      jp: 'テホ',           abbr: 'TJ', role: 'initiator' },

    { id: 'brimstone', name: 'BRIMSTONE', jp: 'ブリムストーン', abbr: 'BS', role: 'controller' },
    { id: 'omen',      name: 'OMEN',      jp: 'オーメン',       abbr: 'OM', role: 'controller' },
    { id: 'viper',     name: 'VIPER',     jp: 'ヴァイパー',     abbr: 'VP', role: 'controller' },
    { id: 'astra',     name: 'ASTRA',     jp: 'アストラ',       abbr: 'AS', role: 'controller' },
    { id: 'harbor',    name: 'HARBOR',    jp: 'ハーバー',       abbr: 'HB', role: 'controller' },
    { id: 'clove',     name: 'CLOVE',     jp: 'クローヴ',       abbr: 'CV', role: 'controller' },

    { id: 'killjoy',   name: 'KILLJOY',   jp: 'キルジョイ',     abbr: 'KJ', role: 'sentinel' },
    { id: 'cypher',    name: 'CYPHER',    jp: 'サイファー',     abbr: 'CY', role: 'sentinel' },
    { id: 'sage',      name: 'SAGE',      jp: 'セージ',         abbr: 'SG', role: 'sentinel' },
    { id: 'chamber',   name: 'CHAMBER',   jp: 'チェンバー',     abbr: 'CH', role: 'sentinel' },
    { id: 'deadlock',  name: 'DEADLOCK',  jp: 'デッドロック',   abbr: 'DL', role: 'sentinel' },
    { id: 'vyse',      name: 'VYSE',      jp: 'ヴァイス',       abbr: 'VY', role: 'sentinel' }
  ];

  /* マップ（サイト構成つき／戦術のターゲット候補に使う） */
  const MAPS = [
    { id: 'ascent',  name: 'ASCENT',  sites: ['A', 'B'] },
    { id: 'bind',    name: 'BIND',    sites: ['A', 'B'] },
    { id: 'haven',   name: 'HAVEN',   sites: ['A', 'B', 'C'] },
    { id: 'split',   name: 'SPLIT',   sites: ['A', 'B'] },
    { id: 'icebox',  name: 'ICEBOX',  sites: ['A', 'B'] },
    { id: 'breeze',  name: 'BREEZE',  sites: ['A', 'B'] },
    { id: 'fracture',name: 'FRACTURE',sites: ['A', 'B'] },
    { id: 'pearl',   name: 'PEARL',   sites: ['A', 'B'] },
    { id: 'lotus',   name: 'LOTUS',   sites: ['A', 'B', 'C'] },
    { id: 'sunset',  name: 'SUNSET',  sites: ['A', 'B'] },
    { id: 'abyss',   name: 'ABYSS',   sites: ['A', 'B'] },
    { id: 'corrode', name: 'CORRODE', sites: ['A', 'B'] }
  ];

  /* 戦術タイプ */
  const KINDS = [
    { id: 'execute', label: 'EXECUTE',  jp: '定石エグゼキュート' },
    { id: 'default', label: 'DEFAULT',  jp: 'デフォルト' },
    { id: 'fast',    label: 'FAST',     jp: 'ファストプッシュ' },
    { id: 'split',   label: 'SPLIT',    jp: 'スプリットプッシュ' },
    { id: 'fake',    label: 'FAKE',     jp: 'フェイク' },
    { id: 'stack',   label: 'STACK',    jp: 'スタック' },
    { id: 'retake',  label: 'RETAKE',   jp: 'リテイク' },
    { id: 'aggro',   label: 'AGGRO',    jp: 'アグレッシブ' },
    { id: 'passive', label: 'PASSIVE',  jp: 'パッシブ / リテイク寄せ' },
    { id: 'eco',     label: 'ECO',      jp: 'エコ / フォース' }
  ];

  /* サイド */
  const SIDES = {
    ATK: { id: 'ATK', label: 'ATTACK',  jp: 'アタッカー', color: '#FF4655' },
    DEF: { id: 'DEF', label: 'DEFENSE', jp: 'ディフェンダー', color: '#22D3A6' }
  };

  /* ラウンドのバイ状況 */
  const ECONOMY = [
    { id: 'full',  label: 'FULL BUY' },
    { id: 'force', label: 'FORCE' },
    { id: 'eco',   label: 'ECO' },
    { id: 'bonus', label: 'BONUS' }
  ];

  /* 初期投入されるサンプル戦術（空デッキだと使い始めが分かりにくいため） */
  const SAMPLE_TACTICS = [
    { name: 'A ダブルスモーク エグゼ', side: 'ATK', site: 'A',   kind: 'execute', note: 'ユーティリティ全出し。ファーストブラッド取れなければ即リグループ。' },
    { name: 'B ファストラッシュ',      side: 'ATK', site: 'B',   kind: 'fast',    note: '開幕30秒で入る。フラッシュ2枚先行、デュエリストがエントリー。' },
    { name: 'ミッドコントロール',      side: 'ATK', site: 'MID', kind: 'default', note: 'ミッド取り切ってから両サイトへスプリット。残り40秒でコール。' },
    { name: 'A フェイク → B',          side: 'ATK', site: 'B',   kind: 'fake',    note: 'A に3枚見せてユーティリティを吐かせ、B へローテート。' },
    { name: 'A スタック',              side: 'DEF', site: 'A',   kind: 'stack',   note: '3枚 A 寄せ。B はリテイク前提で最低限のディレイ。' },
    { name: 'デフォルト 2-1-2',        side: 'DEF', site: 'MID', kind: 'default', note: '基本配置。情報取ってからローテーション。' },
    { name: 'アグレッシブ ミッド取り', side: 'DEF', site: 'MID', kind: 'aggro',   note: 'ミッドを先に取って相手の展開を潰す。失敗したら即引く。' }
  ];

  global.VCT_DATA = { ROLES, AGENTS, MAPS, KINDS, SIDES, ECONOMY, SAMPLE_TACTICS };

  /* 便利関数 */
  global.VCT_DATA.agentById = function (id) {
    return AGENTS.find(function (a) { return a.id === id; }) || null;
  };
  global.VCT_DATA.roleOf = function (agentId) {
    const a = global.VCT_DATA.agentById(agentId);
    return a ? ROLES[a.role] : null;
  };
  global.VCT_DATA.mapById = function (id) {
    return MAPS.find(function (m) { return m.id === id; }) || null;
  };
  global.VCT_DATA.kindById = function (id) {
    return KINDS.find(function (k) { return k.id === id; }) || KINDS[0];
  };
})(window);

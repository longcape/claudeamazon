/* =========================================================
   AGENT PORTRAITS
   ---------------------------------------------------------
   1) 公式画像がある場合
      tools/fetch-assets.mjs を実行すると、Riot の公式アセット
      （valorant-api.com 経由）から各エージェントのアイコンを取得し、
      このファイルの OFFICIAL を書き換える。以降はそちらが使われる。

   2) 公式画像が無い場合（既定）
      下の SIGNATURE 配色でエージェントごとに色分けした
      六角アイコンを描画する。ロールは外周のリングで示す。
   ========================================================= */
(function (global) {
  'use strict';

  /* fetch-assets.mjs が { agentId: 'data:image/webp;base64,...' } を書き込む */
  const OFFICIAL = {};

  /* エージェントごとの識別色。ロール色だけだと 8 体のデュエリストが
     すべて同じ赤になり見分けられないため、1 体ずつ固有色を割り当てる。 */
  const SIGNATURE = {
    /* DUELIST */
    jett:      '#9FE3F5',
    phoenix:   '#F4842A',
    raze:      '#FFB03B',
    reyna:     '#B14BE0',
    yoru:      '#3B5BF5',
    neon:      '#22D3FF',
    iso:       '#7A5CFF',
    waylay:    '#FFD54A',
    /* INITIATOR */
    sova:      '#3FA9F5',
    breach:    '#D9773A',
    skye:      '#6BBF59',
    kayo:      '#8FB3C9',
    fade:      '#6B5BA8',
    gekko:     '#9BE04F',
    tejo:      '#2FA8A0',
    /* CONTROLLER */
    brimstone: '#C4552A',
    omen:      '#6E72C4',
    viper:     '#3FD16B',
    astra:     '#8E5AC9',
    harbor:    '#2AA7C4',
    clove:     '#E05FA8',
    miks:      '#B8E62E',
    /* SENTINEL */
    killjoy:   '#F2D74E',
    cypher:    '#D8D3C8',
    sage:      '#6FE3C9',
    chamber:   '#E8C86A',
    deadlock:  '#9BB3C9',
    vyse:      '#A46BD8',
    veto:      '#D14A6B'
  };

  function official(agentId) {
    return OFFICIAL[agentId] || null;
  }

  function signature(agentId) {
    return SIGNATURE[agentId] || '#6B7F8C';
  }

  function hasOfficial() {
    return Object.keys(OFFICIAL).length > 0;
  }

  global.VCT_PORTRAITS = {
    official: official,
    signature: signature,
    hasOfficial: hasOfficial,
    OFFICIAL: OFFICIAL,
    SIGNATURE: SIGNATURE
  };
})(window);

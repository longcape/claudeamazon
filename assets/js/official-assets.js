/* =========================================================
   OFFICIAL ASSETS （自動生成されるファイル）
   ---------------------------------------------------------
   このファイルは既定では何もしない。
   `node tools/fetch-assets.mjs` を実行すると、Riot の公式アセットを
   取得して、このファイルを上書きする。
   実行後はエージェントアイコンとマップのミニマップが公式画像に差し替わる。

   ※ このリポジトリが動く環境では valorant-api.com への通信が
     ネットワークポリシーで遮断されているため、取得はローカルで行うこと。
   ========================================================= */
(function (global) {
  'use strict';
  /* 生成後はここに { agentId: 'assets/img/agents/xxx.png' } などが入る */
  const AGENTS = {};
  const MAPS = {};

  if (global.VCT_PORTRAITS) Object.assign(global.VCT_PORTRAITS.OFFICIAL, AGENTS);
  if (global.VCT_MAPS) Object.assign(global.VCT_MAPS.MINIMAP, MAPS);
})(window);

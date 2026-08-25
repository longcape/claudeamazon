/* =========================================================
   MATCHUP ANALYST
   戦術 × 味方構成 × 敵構成 から相性を判定する。
   出力は言語非依存のキー + パラメータで返し、表示側で翻訳する。
   ---------------------------------------------------------
   finding: { key, params, tone: 'good'|'bad'|'warn', weight, cat }
     cat = 'ally'(自陣の実行力) | 'enemy'(相手の対抗策) | 'map'
   ========================================================= */
(function (global) {
  'use strict';

  const T = global.VCT_TRAITS;

  /* ユーティリティ依存度が高い戦術タイプ */
  const UTIL_HEAVY = ['execute', 'split', 'fast'];

  function analyze(opts) {
    const tactic = opts.tactic;
    const ally = T.aggregate(opts.allies);
    const enemy = T.aggregate(opts.enemies);
    const mapId = opts.map;
    const side = tactic.side === 'BOTH' ? (opts.side || 'ATK') : tactic.side;
    const kind = tactic.kind;
    const findings = [];

    function add(key, tone, weight, params, cat) {
      findings.push({ key: key, tone: tone, weight: weight, params: params || {}, cat: cat || 'ally' });
    }

    /* ============ 1. 自陣の実行力 ============ */

    if (kind === 'execute') {
      const smoke = ally.count('smoke');
      if (smoke >= 2) add('f.smokeEnough', 'good', 8, { n: smoke });
      else add('f.smokeShort', 'bad', -14, { n: smoke });

      if (ally.count('flash') + ally.count('stun') === 0) add('f.noFlash', 'bad', -12);
      else add('f.flashReady', 'good', 5, { n: ally.count('flash') + ally.count('stun') });

      if (!ally.has('entry')) add('f.noEntry', 'bad', -10);
    }

    if (kind === 'fast') {
      if (ally.count('flash') === 0) add('f.noFlashRush', 'bad', -13);
      else add('f.flashRush', 'good', 7, { n: ally.count('flash') });

      if (!ally.has('entry')) add('f.noEntryRush', 'bad', -12);
      if (ally.count('mobility') >= 2) add('f.mobilityRush', 'good', 7, { n: ally.count('mobility') });
    }

    if (kind === 'split') {
      if (ally.count('smoke') < 2) add('f.smokeShortSplit', 'bad', -11, { n: ally.count('smoke') });
      if (ally.has('mobility') || ally.has('teleport')) add('f.splitMobility', 'good', 6);
      if (!ally.has('recon')) add('f.splitNoRecon', 'warn', -7);
    }

    if (kind === 'fake') {
      if (!ally.has('recon') && !ally.has('deceive')) add('f.fakeNoTool', 'bad', -12);
      if (ally.has('deceive')) add('f.fakeTool', 'good', 8);
      if (ally.count('mobility') >= 2) add('f.fakeRotate', 'good', 6);
    }

    if (kind === 'default') {
      if (ally.count('recon') >= 2) add('f.defaultRecon', 'good', 8, { n: ally.count('recon') });
      else if (!ally.has('recon')) add('f.defaultNoRecon', 'bad', -10);
    }

    if (kind === 'stack') {
      if (ally.has('trap')) add('f.stackTrap', 'good', 7);
      else add('f.stackNoTrap', 'bad', -9);
    }

    if (kind === 'retake' || kind === 'passive') {
      if (ally.has('molly')) add('f.retakeMolly', 'good', 8, { n: ally.count('molly') });
      else add('f.retakeNoMolly', 'bad', -11);
      if (ally.has('smoke')) add('f.retakeSmoke', 'good', 5);
      if (ally.has('heal')) add('f.retakeHeal', 'good', 4);
    }

    if (kind === 'aggro') {
      if (ally.has('flash') || ally.has('recon')) add('f.aggroReady', 'good', 7);
      else add('f.aggroBlind', 'bad', -10);
      if (ally.has('opflex')) add('f.aggroOp', 'good', 5);
    }

    if (kind === 'eco') {
      if (ally.count('flash') >= 2) add('f.ecoFlash', 'good', 7, { n: ally.count('flash') });
      if (ally.has('mobility')) add('f.ecoMobility', 'good', 5);
    }

    /* ============ 2. 相手の対抗策 ============ */

    /* アビリティ封じ */
    if (enemy.has('antiutil') && UTIL_HEAVY.indexOf(kind) >= 0) {
      const names = enemyNames(enemy, ['kayo', 'vyse']);
      add('f.enemyAntiUtil', 'bad', -11, { agents: names }, 'enemy');
    }

    /* 索敵が厚い → フェイクが通らない */
    if (kind === 'fake' && enemy.count('recon') >= 2) {
      add('f.enemyRecon', 'bad', -14, { n: enemy.count('recon') }, 'enemy');
    }

    /* 設置物 → 速攻が止まる。1 枚でもラッシュのテンポは崩れる */
    const enemyTraps = enemy.count('trap');
    if (enemyTraps >= 1 && (kind === 'fast' || kind === 'split')) {
      const magnitude = Math.min(enemyTraps, 3) * 6;
      if (ally.has('antitrap')) add('f.trapButClear', 'warn', -Math.round(magnitude / 2), { n: enemyTraps }, 'enemy');
      else add('f.enemyTraps', 'bad', -magnitude, { n: enemyTraps }, 'enemy');
    }

    /* 情報を取らずに速く入ると、待ち構えられたときに何もできない */
    if ((kind === 'fast' || kind === 'execute') && !ally.has('recon') && enemyTraps >= 1) {
      add('f.rushNoInfo', 'bad', -8, {}, 'ally');
    }

    /* 地点排除が厚いと速攻でも押し込まれる */
    if (kind === 'fast' && enemy.count('molly') >= 2) {
      add('f.enemyMollyRush', 'warn', -6, { n: enemy.count('molly') }, 'enemy');
    }

    /* 遠隔ユーティリティ（定点）は設置後に効いてくる */
    if (side === 'ATK' && enemy.count('lineup') >= 2) {
      add('f.enemyLineup', 'warn', -6, { n: enemy.count('lineup') }, 'enemy');
    }

    /* 壁でラッシュが止まる */
    if (enemy.has('wall') && (kind === 'fast' || kind === 'execute')) {
      add('f.enemyWall', 'warn', -7, { agents: enemyNames(enemy, ['sage', 'viper', 'harbor', 'deadlock', 'vyse', 'astra']) }, 'enemy');
    }

    /* 設置後の解除・維持が強い（アタック側視点） */
    if (side === 'ATK' && enemy.count('postplant') >= 2) {
      add('f.enemyPostplant', 'bad', -10, { n: enemy.count('postplant') }, 'enemy');
    }

    /* 地点排除が厚い → エグゼキュートが刺さりにくい */
    if (kind === 'execute' && enemy.count('molly') >= 3) {
      add('f.enemyMolly', 'bad', -9, { n: enemy.count('molly') }, 'enemy');
    }

    /* センチネル不在 → 速攻が通る */
    if (side === 'ATK' && enemy.roles.sentinel === 0) {
      add('f.enemyNoSentinel', 'good', 12, {}, 'enemy');
    }

    /* 相手デュエリスト過多 → 受けが刺さる */
    if (enemy.roles.duelist >= 3) {
      if (kind === 'retake' || kind === 'passive' || kind === 'stack') {
        add('f.enemyAggroPunish', 'good', 11, { n: enemy.roles.duelist }, 'enemy');
      } else if (side === 'DEF') {
        add('f.enemyAggroRisk', 'warn', -6, { n: enemy.roles.duelist }, 'enemy');
      }
    }

    /* 相手コントローラー不在 → ディフェンス側の視界が通る */
    if (side === 'DEF' && enemy.count('smoke') === 0) {
      add('f.enemyNoSmoke', 'good', 10, {}, 'enemy');
    }

    /* 相手にオペレーター運用 → 開けた進行が危険 */
    if (side === 'ATK' && enemy.has('opflex') && (kind === 'fast' || kind === 'default')) {
      add('f.enemyOp', 'warn', -7, { agents: enemyNames(enemy, ['jett', 'chamber']) }, 'enemy');
    }

    /* 相手の回復・蘇生 */
    if (enemy.has('heal') && (kind === 'execute' || kind === 'fast')) {
      add('f.enemyHeal', 'warn', -5, { agents: enemyNames(enemy, ['sage', 'skye', 'phoenix', 'reyna', 'clove']) }, 'enemy');
    }

    /* ============ 3. マップ ============ */
    const map = global.VCT_DATA.mapById(mapId);
    if (map) {
      if (map.sites.length >= 3 && kind === 'stack') {
        add('f.mapThreeSiteStack', 'bad', -9, { map: map.name }, 'map');
      }
      if (map.sites.length >= 3 && (kind === 'fake' || kind === 'default')) {
        add('f.mapThreeSiteRotate', 'good', 7, { map: map.name }, 'map');
      }
      if (['breeze', 'icebox', 'abyss'].indexOf(map.id) >= 0) {
        if (ally.has('opflex')) add('f.mapOpenOp', 'good', 6, { map: map.name }, 'map');
        else add('f.mapOpenNoOp', 'warn', -6, { map: map.name }, 'map');
      }
      if (['split', 'fracture', 'lotus'].indexOf(map.id) >= 0 && ally.count('smoke') < 2) {
        add('f.mapTightSmoke', 'bad', -8, { map: map.name }, 'map');
      }

      /* サミット: 横に広い 3 レーン構成でミッドの攻防が勝敗を分ける */
      if (map.id === 'summit') {
        if (kind === 'default' || kind === 'split' || kind === 'fake') {
          add('f.mapMidCentric', 'good', 8, { map: map.name }, 'map');
        }
        if (!ally.has('recon') && (kind === 'default' || kind === 'split')) {
          add('f.mapMidNoRecon', 'bad', -8, { map: map.name }, 'map');
        }
        /* 展開可能な壁でラウンド中に射線と経路が変わる */
        if (kind === 'execute' || kind === 'fake') {
          add('f.mapMovingWalls', 'warn', -5, { map: map.name }, 'map');
        }
      }
    }

    /* ============ 集計 ============ */
    let score = 50;
    findings.forEach(function (f) { score += f.weight; });
    score = Math.max(0, Math.min(100, Math.round(score)));

    const verdict = score >= 66 ? 'strong' : (score <= 38 ? 'weak' : 'even');

    findings.sort(function (a, b) { return Math.abs(b.weight) - Math.abs(a.weight); });

    return {
      score: score,
      verdict: verdict,
      side: side,
      findings: findings,
      strengths: findings.filter(function (f) { return f.weight > 0; }),
      weaknesses: findings.filter(function (f) { return f.weight < 0; }),
      ready: ally.size === 5 && enemy.size === 5
    };
  }

  /** 相手構成に含まれる該当エージェント名を並べる */
  function enemyNames(comp, candidates) {
    const hit = candidates.filter(function (id) { return comp.hasAgent(id); });
    return hit.map(function (id) {
      const a = global.VCT_DATA.agentById(id);
      return a ? a.name : id;
    }).join(' / ');
  }

  global.VCT_ANALYST = { analyze: analyze };
})(window);

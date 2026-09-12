/* =========================================================
   TACTIC ADVISOR
   直前のラウンド結果から「次のラウンドに置く戦術」を採点する
   ---------------------------------------------------------
   この数値が何なのか（重要）:

   **ルールベースの「推奨度（いまの状況への合い方）」であり、
     成功確率でも勝率の予測でもない。** 統計モデルも学習も使っていない。
   基準点 50 から、下に並べた固定の加点・減点を足し引きして 0-100 に丸めるだけ。
   同じ状態なら必ず同じ数値になる（決定論的）。

   加点・減点はすべて WEIGHTS に集めてある。画面にもこの内訳をそのまま出すので、
   数字を変えるときは「なぜその重みなのか」を添えること。

   考え方:
   - 勝った戦術は相手が対応してくるまで継続する価値がある（+）
   - ただし同じ戦術の連投は読まれる（連投数に応じて -）
   - 負けた直後の同じ戦術は基本避ける（-）
   - まだ使っていない戦術は情報アドバンテージがある（+）
   - 通算勝率は素直に加点 / 減点（ただし「その試合の中の」実績にすぎない）

   ラウンド評価（exec / reasons）はここでは使っていない。
   サンプルが貯まっていない段階で推奨度へ混ぜると、
   根拠のない数字に見た目だけの説得力が付いてしまうため。
   ========================================================= */
(function (global) {
  'use strict';

  const S = global.VCT_STORE;

  /* 色の境目。緑＝いまの状況に合っている / 黄＝ふつう / 赤＝いまは優先度が低い。
     成功率の色ではない。テストもこの値を読むので、ここを唯一の正本にする */
  const BASE_SCORE = 50;
  const TONE_GOOD = 66;   /* これ以上が緑 */
  const TONE_BAD = 38;    /* これ以下が赤 */

  /* 加点・減点の重み。画面の内訳表示もテストもここを参照する */
  const WEIGHTS = {
    winRateFactor: 0.7,   /* (勝率 - 50) × これ */
    unused: 14,
    lastWin: 10,
    lastLoss: -22,
    streakPerRound: -8,
    recentUse: -6,
    longUnused: 8,
    targetChange: 7,
    rhythmChange: 4,
    sideMismatch: -30,
    openingKind: 6
  };

  /**
   * 次ラウンド候補の採点。
   * @param {Object} opts { side: 'ATK'|'DEF', includeOffSide: boolean }
   * @returns {Array} [{ tactic, stats, score, reasons: [{key, params, delta, tone}], tone }]
   *   reasons は「なぜこの数値なのか」の内訳。delta が実際の加点・減点。
   */
  function rank(opts) {
    opts = opts || {};
    const side = opts.side;
    const includeOffSide = !!opts.includeOffSide;
    const last = S.lastRound();
    const rounds = S.state.rounds;

    const list = S.state.tactics.filter(function (t) {
      if (includeOffSide || !side) return true;
      return t.side === 'BOTH' || t.side === side;
    });

    const scored = list.map(function (t) {
      const st = S.statsFor(t.id);
      let score = BASE_SCORE;
      const reasons = [];

      /* 足し引きは必ずここを通す。画面に出す内訳と実際の計算がずれないようにするため */
      function apply(delta, key, params, tone) {
        const d = Math.round(delta);
        if (!d) return;
        score += d;
        reasons.push({ key: key, params: params || {}, delta: d, tone: tone || 'neutral' });
      }

      /* 通算勝率。あくまで「この試合の中で」の実績で、確率の推定ではない */
      if (st.used > 0) {
        const delta = (st.winRate - 50) * WEIGHTS.winRateFactor;
        if (st.used >= 2 && st.winRate >= 60) {
          apply(delta, 'reason.winrateGood', { n: st.winRate }, 'good');
        } else if (st.used >= 2 && st.winRate <= 40) {
          apply(delta, 'reason.winrateBad', { n: st.winRate }, 'bad');
        } else {
          /* 1 回しか使っていない、または五分に近い。数字は動くので黙らせない */
          apply(delta, 'reason.winrateThin', { n: st.winRate, used: st.used }, 'neutral');
        }
      }

      /* 未使用ボーナス（相手に情報を与えていない） */
      if (st.used === 0) {
        apply(WEIGHTS.unused, 'reason.unused', null, 'good');
      }

      /* 直前ラウンドとの関係 */
      if (last) {
        const isSame = last.tacticId === t.id;
        if (isSame && last.result === 'WIN') {
          apply(WEIGHTS.lastWin, 'reason.lastWin', null, 'good');
        }
        if (isSame && last.result === 'LOSS') {
          apply(WEIGHTS.lastLoss, 'reason.lastLoss', null, 'bad');
        }
        /* 連投による「読まれ」ペナルティ */
        if (st.streak >= 2) {
          apply(WEIGHTS.streakPerRound * st.streak, 'reason.streak', { n: st.streak }, 'warn');
        }
        /* 直近3ラウンド以内に使用 */
        if (!isSame && st.roundsSinceUse !== null && st.roundsSinceUse <= 3) {
          apply(WEIGHTS.recentUse, 'reason.recentUse', { n: st.roundsSinceUse }, 'warn');
        }
        /* 久しぶりの戦術は刺さりやすい */
        if (st.roundsSinceUse !== null && st.roundsSinceUse >= 6) {
          apply(WEIGHTS.longUnused, 'reason.longUnused', { n: st.roundsSinceUse }, 'good');
        }
      }

      /* 直前が敗北なら、リズムを変えるタイプに寄せる */
      if (last && last.result === 'LOSS') {
        const lastT = S.tacticById(last.tacticId);
        if (lastT && lastT.site && t.site && lastT.site !== t.site && t.site !== '-') {
          apply(WEIGHTS.targetChange, 'reason.targetChange',
            { from: lastT.site, to: t.site }, 'good');
        }
        if (t.kind === 'fake' || t.kind === 'split') {
          apply(WEIGHTS.rhythmChange, 'reason.rhythmChange', null, 'good');
        }
      }

      /* サイド不一致（表示だけ許可した場合）は大きく減点 */
      if (side && t.side !== 'BOTH' && t.side !== side) {
        apply(WEIGHTS.sideMismatch, 'reason.sideMismatch', { side: t.side }, 'bad');
      }

      /* ピストル / 序盤は勝率データが無いので素の並びを尊重 */
      if (rounds.length === 0) {
        score = BASE_SCORE;
        reasons.length = 0;
        reasons.push({ key: 'reason.firstRound', params: {}, delta: 0, tone: 'neutral' });
        if (t.kind === 'execute' || t.kind === 'default') {
          apply(WEIGHTS.openingKind, 'reason.openingKind', null, 'neutral');
        }
      }

      score = Math.max(0, Math.min(100, Math.round(score)));
      return {
        tactic: t,
        stats: st,
        score: score,
        base: BASE_SCORE,
        reasons: reasons,
        tone: score >= TONE_GOOD ? 'good' : (score <= TONE_BAD ? 'bad' : 'warn')
      };
    });

    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.tactic.name.localeCompare(b.tactic.name, 'ja');
    });
    return scored;
  }

  /** 選択画面ヘッダーに出す一言。表示側で翻訳できるようキーで返す */
  function headline() {
    const last = S.lastRound();
    if (!last) {
      return { titleKey: 'headline.first.title', textKey: 'headline.first.text', params: {} };
    }
    const t = S.tacticById(last.tacticId);
    const params = { n: last.n, name: t ? t.name : '-' };
    if (last.result === 'WIN') {
      return { titleKey: 'headline.win.title', textKey: 'headline.win.text', params: params };
    }
    return { titleKey: 'headline.loss.title', textKey: 'headline.loss.text', params: params };
  }

  global.VCT_ADVISOR = {
    rank: rank,
    headline: headline,
    BASE_SCORE: BASE_SCORE,
    TONE_GOOD: TONE_GOOD,
    TONE_BAD: TONE_BAD,
    WEIGHTS: WEIGHTS
  };
})(window);

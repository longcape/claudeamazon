/* =========================================================
   TACTIC ADVISOR
   直前のラウンド結果から「次のラウンドに置く戦術」を採点する
   ---------------------------------------------------------
   考え方:
   - 勝った戦術は相手が対応してくるまで継続する価値がある（+）
   - ただし同じ戦術の連投は読まれる（連投数に応じて -）
   - 負けた直後の同じ戦術は基本避ける（-）
   - まだ使っていない戦術は情報アドバンテージがある（+）
   - 通算勝率は素直に加点 / 減点
   ========================================================= */
(function (global) {
  'use strict';

  const S = global.VCT_STORE;

  /**
   * 次ラウンド候補の採点。
   * @param {Object} opts { side: 'ATK'|'DEF', includeOffSide: boolean }
   * @returns {Array} [{ tactic, stats, score, reasons: [{text, tone}] , tone }]
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
      let score = 50;
      const reasons = [];

      /* 通算勝率 */
      if (st.used > 0) {
        const delta = Math.round((st.winRate - 50) * 0.7);
        score += delta;
        if (st.used >= 2 && st.winRate >= 60) {
          reasons.push({ key: 'reason.winrateGood', params: { n: st.winRate }, tone: 'good' });
        } else if (st.used >= 2 && st.winRate <= 40) {
          reasons.push({ key: 'reason.winrateBad', params: { n: st.winRate }, tone: 'bad' });
        }
      }

      /* 未使用ボーナス（相手に情報を与えていない） */
      if (st.used === 0) {
        score += 14;
        reasons.push({ key: 'reason.unused', tone: 'good' });
      }

      /* 直前ラウンドとの関係 */
      if (last) {
        const isSame = last.tacticId === t.id;
        if (isSame && last.result === 'WIN') {
          score += 10;
          reasons.push({ key: 'reason.lastWin', tone: 'good' });
        }
        if (isSame && last.result === 'LOSS') {
          score -= 22;
          reasons.push({ key: 'reason.lastLoss', tone: 'bad' });
        }
        /* 連投による「読まれ」ペナルティ */
        if (st.streak >= 2) {
          const pen = 8 * st.streak;
          score -= pen;
          reasons.push({ key: 'reason.streak', params: { n: st.streak }, tone: 'warn' });
        }
        /* 直近3ラウンド以内に使用 */
        if (!isSame && st.roundsSinceUse !== null && st.roundsSinceUse <= 3) {
          score -= 6;
        }
        /* 久しぶりの戦術は刺さりやすい */
        if (st.roundsSinceUse !== null && st.roundsSinceUse >= 6) {
          score += 8;
          reasons.push({ key: 'reason.longUnused', params: { n: st.roundsSinceUse }, tone: 'good' });
        }
      }

      /* 直前が敗北なら、リズムを変えるタイプに寄せる */
      if (last && last.result === 'LOSS') {
        const lastT = S.tacticById(last.tacticId);
        if (lastT && lastT.site && t.site && lastT.site !== t.site && t.site !== '-') {
          score += 7;
          reasons.push({ key: 'reason.targetChange', params: { from: lastT.site, to: t.site }, tone: 'good' });
        }
        if (t.kind === 'fake' || t.kind === 'split') {
          score += 4;
        }
      }

      /* サイド不一致（表示だけ許可した場合）は大きく減点 */
      if (side && t.side !== 'BOTH' && t.side !== side) {
        score -= 30;
        reasons.push({ key: 'reason.sideMismatch', params: { side: t.side }, tone: 'bad' });
      }

      /* ピストル / 序盤は勝率データが無いので素の並びを尊重 */
      if (rounds.length === 0) {
        score = 50 + (t.kind === 'execute' || t.kind === 'default' ? 6 : 0);
        reasons.length = 0;
        reasons.push({ key: 'reason.firstRound', tone: 'neutral' });
      }

      score = Math.max(0, Math.min(100, Math.round(score)));
      return {
        tactic: t,
        stats: st,
        score: score,
        reasons: reasons,
        tone: score >= 66 ? 'good' : (score <= 38 ? 'bad' : 'warn')
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

  global.VCT_ADVISOR = { rank: rank, headline: headline };
})(window);

/* =========================================================
   SHARE
   戦術カードを X (Twitter) に投稿する / テキストをコピーする。
   API キーは不要で、Web Intent を新規タブで開くだけ。
   ========================================================= */
(function (global) {
  'use strict';

  const D = global.VCT_DATA;
  const I = global.VCT_I18N;

  const HASHTAGS = ['VALORANT', 'TacticalSetupCard'];
  const MAX_LEN = 260;   // 280 からハッシュタグと余白を引いた実用上限

  /**
   * 投稿本文を組み立てる。
   * @param {Object} opts { tactic, map, side, analysis }
   */
  function buildText(opts) {
    const t = opts.tactic;
    const map = D.mapById(opts.map);
    const side = opts.side === 'DEF' ? I.t('side.defense') : I.t('side.attack');
    const analysis = opts.analysis;

    let verdict = '-';
    let score = '-';
    if (analysis) {
      verdict = I.t('analyst.' + analysis.verdict);
      score = analysis.score;
    }

    let note = (t.note || '').replace(/\s+/g, ' ').trim();

    let text = I.t('share.text', {
      name: t.name,
      map: map ? map.name : '-',
      side: side,
      site: t.site || '-',
      verdict: verdict,
      score: score,
      note: note
    });

    /* 長すぎる場合は詳細から削っていく */
    if (text.length > MAX_LEN && note) {
      const overflow = text.length - MAX_LEN;
      note = note.slice(0, Math.max(0, note.length - overflow - 1)) + '…';
      text = I.t('share.text', {
        name: t.name,
        map: map ? map.name : '-',
        side: side,
        site: t.site || '-',
        verdict: verdict,
        score: score,
        note: note
      });
    }
    return text.trim();
  }

  /**
   * 試合が終わったあとの要約。
   * ラウンド中に投稿する人はいないので、X へ出すのはこちらだけにしている。
   * 戦術 1 枚より「どう回して何点取ったか」の方が読む側に意味がある。
   * @param {Object} opts { map, score, rounds, tactics }
   */
  function buildMatchText(opts) {
    const map = D.mapById(opts.map);
    const used = {};
    opts.rounds.forEach(function (r) {
      const rec = used[r.tacticId] = used[r.tacticId] || { win: 0, loss: 0 };
      if (r.result === 'WIN') rec.win++; else rec.loss++;
    });

    /* 使った回数が多い順。全部並べると長すぎるので上位だけ */
    const lines = Object.keys(used).map(function (id) {
      const tac = opts.tactics.filter(function (x) { return x.id === id; })[0];
      const r = used[id];
      return {
        n: r.win + r.loss,
        text: (tac ? tac.name : '-') + ' ' + r.win + 'W' + r.loss + 'L'
      };
    }).sort(function (a, b) { return b.n - a.n; });

    let body = I.t('share.matchText', {
      map: map ? map.name : '-',
      ally: opts.score.ally,
      enemy: opts.score.enemy
    });

    for (let i = 0; i < lines.length; i++) {
      const next = body + '\n' + lines[i].text;
      if (next.length > MAX_LEN) break;
      body = next;
    }
    return body.trim();
  }

  function postMatchToX(opts) {
    openIntent(buildMatchText(opts));
  }

  function openIntent(text) {
    const url = 'https://x.com/intent/tweet'
      + '?text=' + encodeURIComponent(text)
      + '&hashtags=' + encodeURIComponent(HASHTAGS.join(','));
    global.open(url, '_blank', 'noopener,noreferrer');
  }

  /** X の Web Intent を開く */
  function postToX(opts) {
    const text = buildText(opts);
    const url = 'https://x.com/intent/tweet'
      + '?text=' + encodeURIComponent(text)
      + '&hashtags=' + encodeURIComponent(HASHTAGS.join(','));
    global.open(url, '_blank', 'noopener,noreferrer');
  }

  /** クリップボードにコピー。失敗時は false を返す */
  function copyText(opts) {
    const text = buildText(opts) + '\n#' + HASHTAGS.join(' #');
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      return global.navigator.clipboard.writeText(text).then(function () { return true; },
                                                            function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  /* clipboard API が使えない環境向け */
  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  global.VCT_SHARE = {
    buildText: buildText,
    buildMatchText: buildMatchText,
    postToX: postToX,
    postMatchToX: postMatchToX,
    copyText: copyText
  };
})(window);

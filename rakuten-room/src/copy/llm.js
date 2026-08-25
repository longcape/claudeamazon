/* =========================================================
   LLM（任意） — 紹介文の自然化
   ---------------------------------------------------------
   ルールベースの文は構造としては正しいが、量産すると
   語尾が揃って機械臭が出る。ANTHROPIC_API_KEY がある時だけ、
   「誰の・どんな悩みが・どう変わるか」を保ったまま
   言い回しだけを整える。キーが無ければ何もしない。
   ========================================================= */
'use strict';

const log = require('../util/log');

const MODEL = 'claude-sonnet-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

function available() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function buildPrompt(posts, strategy) {
  const items = posts.map(function (p, i) {
    return [
      '## ' + (i + 1),
      '役割: ' + p.role + '（bait=クリックと回遊が目的・売り込まない / cv=成約が目的 / traffic=楽天市場への送客が目的）',
      '商品: ' + p.cleanName,
      '価格: ' + p.price + '円　評価: ★' + p.reviewAverage.toFixed(2) + '（' + p.reviewCount + '件）',
      '誰の: ' + p.copy.parts.who,
      'どんな悩み: ' + p.copy.parts.problem,
      'どう変わる: ' + p.copy.parts.change,
      '現在の文:',
      p.copy.body
    ].join('\n');
  }).join('\n\n');

  return [
    'あなたは楽天ROOMの投稿文を整える編集者です。以下の各投稿について、文を自然な日本語に整えてください。',
    '',
    '厳守事項:',
    '- 「誰の・どんな悩みが・どう変わるか」の3要素を必ず残す',
    '- ' + strategy.copy.maxLength + '文字以内（ハッシュタグは含めない）',
    '- 次の表現は使わない: ' + strategy.copy.banPhrases.join('、'),
    '- 商品名の言い換えや、事実にない効能の追加をしない',
    '- 役割ごとの目的を守る（baitは売り込まない、cvは背中を押す、trafficはページで選ばせる）',
    '- 語尾を投稿ごとに変え、同じ言い回しを繰り返さない',
    '',
    '出力形式: 各投稿の本文だけを、番号付きで1件ずつ。前置きや説明は書かない。',
    '',
    items
  ].join('\n');
}

function parseResponse(text, count) {
  const out = new Array(count).fill(null);
  /* 「## 3」「3.」「【3】」いずれの番号付けでも拾う */
  const re = /(?:^|\n)\s*(?:##\s*|【)?(\d{1,3})(?:】|[.)．、:：])?\s*\n?([\s\S]*?)(?=(?:\n\s*(?:##\s*|【)?\d{1,3}(?:】|[.)．、:：])?\s*\n)|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const idx = Number(m[1]) - 1;
    if (idx >= 0 && idx < count) out[idx] = m[2].trim();
  }
  return out;
}

async function refine(posts, strategy) {
  if (!available()) return posts;

  const batchSize = 10;
  const result = posts.slice();

  for (let start = 0; start < posts.length; start += batchSize) {
    const batch = posts.slice(start, start + batchSize);
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 2000,
          messages: [{ role: 'user', content: buildPrompt(batch, strategy) }]
        })
      });
    } catch (e) {
      log.warn('紹介文の自然化をスキップしました（接続失敗）: ' + e.message);
      return result;
    }

    if (!res.ok) {
      log.warn('紹介文の自然化をスキップしました（HTTP ' + res.status + '）');
      return result;
    }

    const json = await res.json();
    const text = (json.content || []).map(function (c) { return c.text || ''; }).join('\n');
    const bodies = parseResponse(text, batch.length);

    bodies.forEach(function (body, i) {
      if (!body) return;
      const post = result[start + i];
      const trimmed = body.slice(0, strategy.copy.maxLength);
      /* 3要素が消えていたら採用しない。整形は改善であって改変ではない */
      const keepsParts = trimmed.length >= strategy.copy.minLength;
      if (!keepsParts) return;
      post.copy = Object.assign({}, post.copy, {
        body: trimmed,
        text: trimmed + '\n' + post.copy.hashtags.join(' '),
        refined: true
      });
    });
  }

  return result;
}

module.exports = { refine, available, buildPrompt, parseResponse, MODEL };

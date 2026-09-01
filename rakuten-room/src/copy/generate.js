/* =========================================================
   COPY — 紹介文の生成
   ---------------------------------------------------------
   NG:「便利な収納ラック」＝商品名＋感想だけの自己満日記。
   OK:「キッチンの置き場問題が一瞬で消える収納ラック」
   誰の / どんな悩みが / どう変わるか を必ず1文に入れる。
   さらに役割ごとに文の仕事を変える。
     bait    … クリックと回遊を取りにいく（売り込まない）
     cv      … 成約を取りにいく（根拠と背中押しを入れる）
     traffic … 楽天市場のページへ送る（選ばせる）
   ========================================================= */
'use strict';

const T = require('../util/text');

/* 同じ商品なら毎回同じ文、違う商品なら違う文になるよう
   乱数ではなく商品コードのハッシュで選ぶ（再現性のため） */
function pick(list, seed, offset) {
  if (!list || !list.length) return '';
  const h = parseInt(T.hash(String(seed) + ':' + (offset || 0)).slice(0, 6), 36);
  return list[h % list.length];
}

/* 商品名と説明文から「この商品の効き所」を特定する。
   説明文は宣伝文句が多く、関係ない語も並ぶ。保存容器の説明に
   「伸縮」と書いてあるだけで伸縮商品として売ってしまうと文が
   商品と噛み合わなくなるので、商品名での一致を必ず優先する。 */
function extractFeature(item, lexicon) {
  /* 説明文は使わない。シーリングライトの説明文にある「折りたたみ」を拾って
     「たたんで隙間に収まる」と書く誤検出が実データで起きた。
     説明文には設置手順や別商品の宣伝まで混ざるため、名前とキャッチコピーだけを見る */
  const haystack = item.cleanName + ' ' + item.catchcopy;
  for (const rule of lexicon.featureRules) {
    const hit = rule.match.find(function (m) { return haystack.indexOf(m) >= 0; });
    if (hit) return { problem: rule.problem, change: rule.change, matched: hit };
  }
  return null;
}

/* その商品が実際に置かれる棚札を返す。
   primarySubTheme は「その商品を連れてきた検索キーワード」であって、
   商品の属性ではない。プチギフト1000円で検索して出てきた3,240円の商品に
   「1,000〜2,000円」の棚札が付く事故が実データで起きた。
   価格帯の棚札は実売価格から引き直す。 */
function shelfIdFor(item, strategy) {
  const bands = (strategy.gift && strategy.gift.priceBands) || [];
  const price = Number(item.price) || 0;
  const band = bands.find(function (b) { return price >= b.min && price <= b.max; });
  if (band) {
    const byLabel = strategy.genre.subThemes.find(function (t) { return t.label === band.label; });
    if (byLabel) return byLabel.id;
  }
  return item.primarySubTheme;
}

function personaFor(item, lexicon, seed) {
  const table = lexicon.personas[item.shelfId || item.primarySubTheme] || lexicon.personas._default;
  return pick(table, seed, 1);
}

/* 特徴が拾えないとき悩みと変化を別々に選ぶと
   「片づけても戻る散らかりが、定位置が決まって探す時間が消える」のように
   主語がねじれた文が出る。対で持っている fallbackPairs から1組を選ぶ */
function fallbackPair(lexicon, seed) {
  const pairs = lexicon.fallbackPairs;
  if (!pairs || !pairs.length) return null;
  return pick(pairs, seed, 2);
}

function problemFor(item, lexicon, feature, seed) {
  if (feature) return feature.problem;
  const pair = fallbackPair(lexicon, seed);
  if (pair) return pair.problem;
  const table = lexicon.problems[item.shelfId || item.primarySubTheme] || lexicon.problems._default;
  return pick(table, seed, 2);
}

function changeFor(item, lexicon, feature, seed) {
  if (feature) return feature.change;
  const cpair = fallbackPair(lexicon, seed);
  if (cpair) return cpair.change;
  /* 特徴が拾えなかった場合でも、動詞を必ず含む言い切りにする */
  return pick(lexicon.fallbackChanges, seed, 3);
}

function proofFor(item) {
  const bits = ['★' + item.reviewAverage.toFixed(1) + '（' + item.reviewCount + '件）'];
  if (item.pointRate >= 2) bits.push('ポイント' + item.pointRate + '倍');
  if (item.postageFree) bits.push('送料無料');
  return bits.join(' / ');
}

function hashtags(item, strategy, trend) {
  /* 棚札は giftCollections（実売価格と商品名から決まる）を優先する。
     検索キーワード由来の primarySubTheme をそのまま使うと、
     「プチギフト 1000円」で見つかった3,240円の商品に
     「#1,000〜2,000円」が付く事故が起きる */
  const collections = item.giftCollections || [];
  const tags = [];
  if (collections.length) {
    tags.push(String(collections[0]).replace(/\s/g, ''));
  } else {
    const sub = strategy.genre.subThemes.find(function (t) { return t.id === shelfIdFor(item, strategy); });
    if (sub) tags.push(sub.label.replace(/\s/g, ''));
  }
  const rising = (trend.rising || []).filter(function (w) {
    return (item.cleanName + (item.caption || '').slice(0, 300)).indexOf(w) >= 0;
  });
  rising.slice(0, 1).forEach(function (w) { tags.push(w.replace(/\s/g, '')); });
  if (strategy.room.themeTag) tags.push(String(strategy.room.themeTag).replace(/\s/g, ''));
  return Array.from(new Set(tags)).slice(0, 3).map(function (t) { return '#' + t; });
}

function linkLine(item, lexicon, seed) {
  if (!item.linkPrev) return '';
  return pick(lexicon.linkPhrases, seed, 4).replace('{prev}', T.coreName(item.linkPrev, 12));
}

function compose(item, strategy, lexicon, trend) {
  const seed = item.itemCode || item.name;
  const feature = extractFeature(item, lexicon);
  const who = personaFor(item, lexicon, seed);
  const problem = problemFor(item, lexicon, feature, seed);
  const change = changeFor(item, lexicon, feature, seed);
  const core = T.coreName(item.name, 22);
  const link = linkLine(item, lexicon, seed);

  let lines = [];

  if (item.role === 'bait') {
    /* 売り込まない。見せて、他も見たくさせる */
    const hook = pick(lexicon.baitHooks, seed, 5).replace('{price}', item.price.toLocaleString('ja-JP'));
    lines = [
      hook,
      who + 'へ。' + problem + 'が、' + change + '。',
      link
    ];
  } else if (item.role === 'cv') {
    /* 直前の評価取りで温まった状態を、そのまま成約に流す */
    const hook = pick(lexicon.cvHooks, seed, 6);
    lines = [
      who + 'へ。' + problem + 'が、' + change + '。',
      hook + ' ' + proofFor(item),
      link
    ];
  } else {
    const hook = pick(lexicon.trafficHooks, seed, 7);
    const cta = pick(lexicon.trafficCta, seed, 8);
    lines = [
      who + 'へ。' + problem + 'が、' + change + '。',
      hook,
      cta
    ];
  }

  const body = lines.filter(Boolean).join('\n');
  const tags = hashtags(item, strategy, trend);
  const text = body + '\n' + tags.join(' ');

  return {
    text: text,
    body: body,
    hashtags: tags,
    parts: { who: who, problem: problem, change: change, core: core, feature: feature ? feature.matched : null, proof: proofFor(item), link: link }
  };
}

/* 生成物がNG条件に当たっていないかを機械的に検査する */
function validateCopy(copy, strategy) {
  const cfg = strategy.copy;
  const issues = [];
  const body = copy.body;

  if (cfg.requireWho && !copy.parts.who) issues.push('「誰の」が入っていない');
  if (cfg.requireProblem && !copy.parts.problem) issues.push('「どんな悩みが」が入っていない');
  if (cfg.requireChange && !copy.parts.change) issues.push('「どう変わるか」が入っていない');
  if (body.length < cfg.minLength) issues.push('短すぎる（' + body.length + '字 / 下限' + cfg.minLength + '）');
  if (body.length > cfg.maxLength) issues.push('長すぎる（' + body.length + '字 / 上限' + cfg.maxLength + '）');

  cfg.banPhrases.forEach(function (p) {
    if (body.indexOf(p) >= 0) issues.push('禁止表現「' + p + '」');
  });

  return { ok: issues.length === 0, issues: issues, length: body.length };
}

/* 上限を超えた場合の切り詰め。導線行を先に落とす */
function fit(copy, strategy) {
  const max = strategy.copy.maxLength;
  if (copy.body.length <= max) return copy;
  const lines = copy.body.split('\n');
  while (lines.length > 2 && lines.join('\n').length > max) lines.pop();
  const body = lines.join('\n');
  return Object.assign({}, copy, { body: body, text: body + '\n' + copy.hashtags.join(' ') });
}

function generateAll(seq, strategy, lexicon, trend) {
  return seq.map(function (raw) {
    const item = Object.assign({}, raw, { shelfId: shelfIdFor(raw, strategy) });
    const copy = fit(compose(item, strategy, lexicon, trend), strategy);
    const check = validateCopy(copy, strategy);
    return Object.assign({}, item, { copy: copy, copyCheck: check });
  });
}

module.exports = { generateAll, compose, validateCopy, extractFeature, fit, pick, hashtags };

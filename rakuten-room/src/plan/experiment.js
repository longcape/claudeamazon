/* =========================================================
   EXPERIMENT — 時間帯クロスオーバー実験
   ---------------------------------------------------------
   旧設計では 0:20 枠が bait / traffic、21〜22時枠が cv を含んでいた。
   時間帯と投稿役割が同時に変わるため、結果に差が出ても
   それが時間帯によるものか役割によるものか判定できない。交絡である。

   ここでは両方の枠へ同じ構成を置く。

     12投稿 / 4クラスター / 1日3投稿
     1クラスター = bait + cv + traffic の3投稿（買い物目的でまとまった関連商品）
     2クラスターを21〜22時、2クラスターを0〜1時へ
     → どちらの枠も bait 2 / cv 2 / traffic 2 で揃う

   次の実験では割当を反転する（クロスオーバー）。同じクラスターを
   逆の時間帯へ置くことで、商品の当たり外れと時間帯の効果を分離できる。

   0時台の投稿は暦日では翌日になるが、運用上は前夜の続きなので
   sessionDate で前夜へ紐づける。これが無いと、同じ晩の投稿が
   別々の日として集計され、1日あたりの成績が二重に割れる。

   実験中は時刻のゆらぎ（jitter）を入れない。比較条件を汚すため。
   ========================================================= */
'use strict';

const facetsLib = require('../pipeline/facets');
const time = require('../util/time');

const ROLES = ['bait', 'cv', 'traffic'];

/* 予告文に使うカテゴリ名。商品名から判定した productCategory をそのまま日本語にするだけで、
   商品ページに無いことは足さない */
const CATEGORY_JA = {
  sweets: 'お菓子', beverage: '飲みもの', flower: '花', cosmetic: 'コスメ',
  bath: 'バス用品', towel: 'タオル', tableware: '食器', message: '名入れ・メッセージもの',
  food: '食べもの', other: '次の一品'
};

/* 次の投稿の予告。煽らず、何を出すかだけを言う */
function teaserFor(nextItem) {
  if (!nextItem) return null;
  const cat = CATEGORY_JA[(nextItem.facets || {}).productCategory] || CATEGORY_JA.other;
  const price = Number(nextItem.price) || 0;
  return '次は、これと一緒に渡せる' + cat + 'を出します。';
}

function slotNames(strategy) {
  return Object.keys((strategy.experiment || {}).slots || {});
}

/* 役割別に上位分位のプールを作る。
   実験は「良い商品同士を、条件だけ変えて比べる」ためのものなので、
   最初から下位の商品を混ぜない。ただし絶対下限は割らない。 */
function rolePool(scored, strategy, role) {
  const sel = strategy.selection || {};
  const floor = sel.absoluteFloor !== undefined ? sel.absoluteFloor : 0;
  const ratio = (sel.quantile || {}).experiment || 0.25;

  const eligible = scored.filter(function (i) {
    return i.total >= floor && i.roles && i.roles[role] !== undefined;
  }).sort(function (a, b) { return b.roles[role] - a.roles[role]; });

  const cut = Math.max(1, Math.ceil(eligible.length * ratio));
  return eligible.slice(0, cut).map(function (i) {
    return Object.assign({}, i, { bestRole: role });
  });
}

/* 4クラスターを作る。1クラスターは bait / cv / traffic の3件で、
   互いに関連していること（facets の関連度が閾値以上）を要求する。 */
function buildExperimentClusters(scored, strategy) {
  const cfg = strategy.experiment || {};
  const want = cfg.clusters || 4;
  const roles = cfg.rolesPerCluster || ROLES;

  const pools = {};
  roles.forEach(function (r) { pools[r] = rolePool(scored, strategy, r); });

  /* seed は bait 側の上位から。関連相手は各役割のプールから探す */
  const combined = pools[roles[0]].concat(
    roles.slice(1).reduce(function (a, r) { return a.concat(pools[r]); }, [])
  );

  const base = {
    count: want,
    size: roles.length,
    roles: roles,
    maxPerShop: (strategy.portfolio || {}).maxPerShop || 4
  };

  /* まず「別カテゴリの補完がある束」だけで組む。
     同じカテゴリを3つ並べても、次に何を欲しくなるかの導線にならない。
     それだけで本数が足りない場合は補完なしも許すが、束に印を残して
     運用者が入れ替えを判断できるようにする */
  const strict = facetsLib.buildClusters(combined, strategy,
    Object.assign({}, base, { requireComplementary: true }));
  if (strict.length >= want) return strict;

  const loose = facetsLib.buildClusters(combined, strategy, base);
  return loose;
}

/* クラスターを時間帯へ割り当てる。reverse=true で反転（クロスオーバー） */
function assignSlots(clusters, strategy, reverse) {
  const names = slotNames(strategy);
  if (names.length < 2) return clusters.map(function (c) { return Object.assign({}, c, { slotVariant: names[0] || 'control' }); });

  const order = reverse ? [names[1], names[0]] : [names[0], names[1]];
  const half = Math.ceil(clusters.length / 2);
  return clusters.map(function (c, i) {
    return Object.assign({}, c, { slotVariant: i < half ? order[0] : order[1] });
  });
}

/* 実験の投稿一覧を作る。1日1クラスター、3投稿。 */
function buildPosts(clusters, strategy, startDateKey) {
  const cfg = strategy.experiment || {};
  const slots = cfg.slots || {};
  const cutover = cfg.sessionCutoverHour === undefined ? 4 : cfg.sessionCutoverHour;
  const posts = [];
  let order = 0;

  clusters.forEach(function (cluster, dayIndex) {
    const sessionDate = time.addDaysToKey(startDateKey, dayIndex);
    const times = slots[cluster.slotVariant] || [];

    cluster.members.forEach(function (member, i) {
      /* 同じ束の次の商品。次にROOMを見る理由を作るために予告へ使う */
      const next = cluster.members[i + 1] || null;
      const timeJst = times[i] || times[times.length - 1];
      const hour = Number(String(timeJst).split(':')[0]);
      /* 0時台はセッションの翌暦日に出る */
      const date = hour < cutover ? time.addDaysToKey(sessionDate, 1) : sessionDate;
      order += 1;

      posts.push(Object.assign({}, member, {
        order: order,
        role: member.clusterRole,
        clusterId: cluster.id,
        slotVariant: cluster.slotVariant,
        date: date,
        sessionDate: sessionDate,
        timeJst: timeJst,
        scheduledAt: time.jstAt(date, timeJst).toISOString(),
        /* 実験中はゆらぎを入れない */
        jitterMinutes: 0,
        /* 1投稿で完結させない。次に何を出すかを予告して再訪の理由を作る */
        nextRelatedProduct: next ? {
          itemCode: next.itemCode,
          name: next.cleanName,
          role: next.clusterRole,
          productCategory: (next.facets || {}).productCategory,
          price: next.price
        } : null,
        nextPostTeaser: teaserFor(next),
        /* 送客役は「関連商品だから」では動かない。ページでしか分からないことを示す */
        marketplaceClickReasons: member.marketplaceClickReasons || []
      }));
    });
  });

  return posts;
}

function create(scored, strategy, opts) {
  const options = opts || {};
  const cfg = strategy.experiment || {};
  const startDate = options.startDate || time.dateKey();
  const clusters = assignSlots(buildExperimentClusters(scored, strategy), strategy, !!options.reverse);
  const posts = buildPosts(clusters, strategy, startDate);

  const bySlot = {};
  posts.forEach(function (p) {
    const s = bySlot[p.slotVariant] || { count: 0, roles: {} };
    s.count += 1;
    s.roles[p.role] = (s.roles[p.role] || 0) + 1;
    bySlot[p.slotVariant] = s;
  });

  return {
    experimentId: options.id || ('EXP-' + startDate + (options.reverse ? '-R' : '')),
    createdAt: new Date().toISOString(),
    startDate: startDate,
    reverse: !!options.reverse,
    target: { posts: cfg.posts || 12, clusters: cfg.clusters || 4, postsPerDay: cfg.postsPerDay || 3 },
    clusters: clusters.map(function (c) {
      return { id: c.id, slotVariant: c.slotVariant, cohesion: c.cohesion,
        complementary: c.complementary, facets: c.facets };
    }),
    posts: posts,
    bySlot: bySlot,
    /* 勝者判定はまだできない。何件たまれば判定できるかを添える */
    winnerReadyAt: cfg.minPostsPerSlotForWinner || 12,
    note: '時間帯と役割を分離した比較実験。両枠の役割構成は同一。次回は割当を反転する。'
  };
}

/* 実験が比較として成立しているかの検査 */
function audit(experiment, strategy) {
  const issues = [];
  const cfg = strategy.experiment || {};
  const slots = Object.keys(experiment.bySlot);

  if (experiment.posts.length !== (cfg.posts || 12)) {
    issues.push('投稿数が ' + experiment.posts.length + ' 件（想定 ' + (cfg.posts || 12) + ' 件）');
  }
  if (slots.length !== 2) {
    issues.push('時間帯が ' + slots.length + ' 種類（2枠で比較する設計）');
  } else {
    const a = experiment.bySlot[slots[0]];
    const b = experiment.bySlot[slots[1]];
    if (a.count !== b.count) issues.push('枠ごとの投稿数が揃っていない: ' + a.count + ' / ' + b.count);
    const roles = new Set(Object.keys(a.roles).concat(Object.keys(b.roles)));
    roles.forEach(function (r) {
      if ((a.roles[r] || 0) !== (b.roles[r] || 0)) {
        issues.push('役割 ' + r + ' の構成が枠間で違う: ' + (a.roles[r] || 0) + ' / ' + (b.roles[r] || 0));
      }
    });
  }
  experiment.posts.forEach(function (p) {
    if (p.jitterMinutes !== 0) issues.push('#' + p.order + ' にゆらぎが入っている');
  });

  return { ok: issues.length === 0, issues: issues };
}

module.exports = { create, audit, buildExperimentClusters, assignSlots, buildPosts, rolePool, slotNames, teaserFor, CATEGORY_JA, ROLES };

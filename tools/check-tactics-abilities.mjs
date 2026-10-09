/* =========================================================
   戦術の手順が、いまのスキル構成と食い違っていないかを見る
   ---------------------------------------------------------
   スキルは作り直されることがある（ハーバーは壁とスモークのスロットが入れ替わった）。
   戦術の手順に書いたスロット（C/Q/E/X）が古い構成のままだと、盤面に別のスキルの
   アイコンが出る。エージェント知識（knowledge/agents/<id>.json）の `kind` と、
   手順の文面（壁・スモーク・フラッシュ…）を突き合わせて、合わないものを挙げる。

     node tools/check-tactics-abilities.mjs          # 一覧を出す
     node tools/check-tactics-abilities.mjs --fix    # 文面から一意に決まるものだけスロットを直す

   文面からの推定なので、--fix が直すのは「その種類のスキルをそのエージェントが
   1 つしか持たない」場合だけ。それ以外は一覧に残すので人が見る。
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { knowledgePath } from './kb-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KNOW = path.join(ROOT, 'knowledge');
const fix = process.argv.includes('--fix');

/* 手順の文面に出る言葉 → スキルの種類（複数ありうる） */
const WORDS = [
  { re: /スモーク|煙|ケージ|オーブ/, kinds: ['smoke', 'vision-denial'] },
  { re: /スロー|スロウ/, kinds: ['slow'] },
  { re: /ショック/, kinds: ['damage'] },
  { re: /壁|ウォール|ファストレーン/, kinds: ['wall', 'vision-denial'] },
  { re: /フラッシュ/, kinds: ['flash', 'blind'] },
  { re: /リコン|索敵|ドローン|ホウント/, kinds: ['recon'] },
  { re: /モロ|焼/, kinds: ['molly', 'damage'] },
  { re: /スタン|コンカス/, kinds: ['stun'] },
  { re: /ワイヤー|罠|トラップ|アラーム|タレット|カメラ/, kinds: ['trap', 'recon'] },
  { re: /テレポ/, kinds: ['teleport', 'mobility'] },
  { re: /フェイク|デコイ/, kinds: ['decoy'] }
];

const agents = {};
fs.readdirSync(path.join(KNOW, 'agents')).filter((f) => /^[a-z]+\.json$/.test(f)).forEach((f) => {
  const a = JSON.parse(fs.readFileSync(path.join(KNOW, 'agents', f), 'utf8'));
  agents[a.id] = {};
  (a.abilities || []).forEach((ab) => { agents[a.id][ab.slot] = { kind: ab.kind, name: ab.name_ja || ab.name_en }; });
});

let issues = 0, fixed = 0, steps = 0;
fs.readdirSync(knowledgePath('tactics')).filter((f) => /^[a-z]+\.json$/.test(f)).sort().forEach((f) => {
  const file = knowledgePath('tactics', f);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = false;
  data.tactics.forEach((t) => {
    (t.steps || []).forEach((s) => {
      const kit = agents[s.agent];
      if (!kit || !kit[s.ability]) return;
      steps++;
      /* 文面には複数の言葉が出る（「壁が割れたらスロー」）。どれか 1 つでも今のスキルの種類と合えば問題なし */
      const hits = WORDS.filter((w) => w.re.test(s.action_ja || ''));
      if (!hits.length) return;
      if (hits.some((w) => w.kinds.indexOf(kit[s.ability].kind) >= 0)) return;
      const word = hits[0];
      /* 文面の言葉が指す種類のスキルを、このエージェントがちょうど 1 つ持っていれば、それが正しいスロット */
      const cands = Object.keys(kit).filter((slot) => word.kinds.indexOf(kit[slot].kind) >= 0);
      if (!cands.length) return;                    /* その種類を持たない＝文面が別のことを言っている。触らない */
      issues++;
      const where = t.key + ' — ' + s.agent + ':' + s.ability + '（' + kit[s.ability].name + ' / ' + kit[s.ability].kind + '）「' + String(s.action_ja).slice(0, 34) + '」';
      if (fix && cands.length === 1 && hits.length === 1) {
        s.ability = cands[0]; changed = true; fixed++;
        console.log('  fixed → ' + cands[0] + ': ' + where);
      } else {
        console.log('  ? ' + where + ' → 候補 ' + cands.join('/'));
      }
    });
  });
  if (changed) fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
});

console.log('スキルつきの手順 ' + steps + ' 件 / 食い違い ' + issues + ' 件' + (fix ? ' / 直した ' + fixed + ' 件' : ''));

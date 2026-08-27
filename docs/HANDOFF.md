# ローカル環境への引き継ぎ

このアプリの開発を、自分の PC の Claude Code に引き継ぐ手順。
Windows を前提に書いている（Mac の場合は各所の読み替えを併記）。

所要 15〜20 分。Node.js は画像取得のときに入れたものがそのまま使える。

---

## 何を引き継ぐのか

| もの | 引き継がれ方 |
| --- | --- |
| コード | GitHub のブランチから clone する |
| これまでの経緯・決定事項 | `CLAUDE.md` に書いてある。ローカルの Claude Code が自動で読む |
| 公式画像 | リポジトリに入っているのでそのまま付いてくる |
| 動作確認 | `tools/smoke-test.mjs` |
| 登録した戦術データ | **引き継がれない**（後述） |

これまでの会話ログそのものは移せない。代わりに、
**判断の理由を `CLAUDE.md` に残してある**ので、ローカルの Claude Code は
「なぜチャージ数を表示しないのか」「なぜ ES モジュールを使わないのか」を
最初から把握した状態で作業を始められる。

---

## [1] Git を入れる

コードを取ってきて、変更を保存・共有するために要る。

https://git-scm.com/downloads

インストーラーの選択肢はすべて既定のままで問題ない。

> 既に GitHub Desktop を使っているなら、それでも構わない。
> その場合は [2] を「GitHub Desktop で clone」に読み替える。

入ったか確認する。黒い画面（`Win`+`R` → `cmd` → Enter）で:

```
git --version
```

`git version 2.x.x` と出れば成功。

---

## [2] コードを取ってくる

作業場所を決める。ここでは `C:\dev` とする。

```
mkdir C:\dev
cd /d C:\dev
git clone -b claude/valorant-tactical-setup-card-iiiog3 https://github.com/longcape/claudeamazon.git valorant-setup-card
cd valorant-setup-card
```

> `-b claude/valorant-tactical-setup-card-iiiog3` を**必ず付けること**。
> コードは作業ブランチにしか入っていない。付け忘れると中身が空になる。

初回は GitHub のログインを求められる。ブラウザが開くので許可する。

Mac の場合:

```
mkdir -p ~/dev && cd ~/dev
git clone -b claude/valorant-tactical-setup-card-iiiog3 https://github.com/longcape/claudeamazon.git valorant-setup-card
cd valorant-setup-card
```

### 動くか確かめる

フォルダの中の `index.html` をダブルクリック。
ブラウザでアプリが開き、エージェントの顔アイコンとマップが出れば成功。

---

## [3] Claude Code を入れる

https://claude.com/claude-code

インストール後、**[2] で作ったフォルダを開いた状態で**起動する。
ここが重要で、別のフォルダで起動すると `CLAUDE.md` を読んでくれない。

黒い画面から起動する場合:

```
cd /d C:\dev\valorant-setup-card
claude
```

起動したら最初にこう聞くと、引き継げているか確認できる。

```
CLAUDE.md を読んで、このプロジェクトの現状と残っている作業を教えて
```

`CLAUDE.md` の内容を要約して返してくれば引き継ぎ成功。

---

## [4] 開発の進め方

### 直したら

`assets/` や `index.html` を触ったら、`index.html` をブラウザで再読み込み
（`Ctrl` + `F5`）するだけで反映される。ビルドは要らない。

### 配布ファイルを作り直す

単一 HTML 版（人に配るファイル、公開ページ用）を更新するとき:

```
node build.js
```

`assets/` を触ったのに `dist/` を作り直し忘れる、というのが一番ありがちな
取りこぼし。**コミットする前に必ず実行する。**

### 動作確認

過去に実際に壊れた箇所を 26 項目チェックする。

```
npm install -D playwright
npx playwright install chromium
node tools/smoke-test.mjs
```

`playwright` の導入は初回だけ（200MB ほどダウンロードする）。
`node_modules/` は Git の管理外なので、コミットには入らない。

```
26 件 ok / 0 件 NG
```

と出れば健全。

### 保存して共有する

```
git add -A
git commit -m "変更内容を一行で"
git push
```

Claude Code に「コミットして」と頼めばこの 3 つをやってくれる。

---

## [5] 公式画像を更新する（新エージェント / 新マップが出たとき）

`画像を取得.bat` をダブルクリックするだけ。Mac は `画像を取得.command`。

ローカル環境なら valorant-api.com に繋がるので、**そのまま取得できる**。
（クラウド上の Claude Code からは回線が塞がれていて取得できなかった。
これがローカルに移す実利のひとつ。）

新エージェントや新マップが API 側にあってアプリに未登録だと、
実行時に警告が出る。その一覧を Claude Code に渡せば追加してもらえる。

新マップを足したときは `assets/js/maps-layout.js` の `ROTATION` にも
向きの補正角を足す必要がある（詳細は `CLAUDE.md`）。

---

## 戦術データについて

登録した戦術は **ブラウザごとの `localStorage`** に入っている。
公開 URL 版で作ったデータは、ローカルの `index.html` には引き継がれない
（別のサイト扱いになるため）。

移したい場合:

1. 公開 URL 版を開く → 右上の **書き出し** → JSON ファイルが落ちる
2. ローカルの `index.html` を開く → 右上の **読み込み** → その JSON を選ぶ

逆向きも同じ手順でできる。

---

## つまずいたら

| 症状 | 対処 |
| --- | --- |
| `git` が見つからない | [1] をやり直す。インストール後は黒い画面を開き直すこと |
| clone したのに中身が空 | `-b claude/valorant-tactical-setup-card-iiiog3` を付け忘れている |
| 画像が出ない | `index.html` を直接開いているか確認。`dist/` の方ではない |
| Claude Code が経緯を知らない | プロジェクトのフォルダで起動できていない。`CLAUDE.md` がある階層で起動する |
| `node` が見つからない | https://nodejs.org/ja から推奨版を入れる |
| smoke-test が全部飛ばされる | `npm install -D playwright` がまだ。プロジェクトのフォルダで実行する |
| push できない | ブランチが違う可能性。`git branch --show-current` で確認する |

---

## 公開 URL について

現在の公開ページはこのセッションから発行したもので、
**ローカルからは更新できない**。ローカルで続けた変更を公開したい場合は、
ホスティング先を用意することになる。

`dist/valorant-tactical-setup-card.html` は依存ゼロの HTML 1 枚なので、
どこにでも置ける。GitHub Pages / Cloudflare Pages / Netlify あたりが
無料で、ファイルを置くだけで動く。必要になったら Claude Code に
「GitHub Pages で公開したい」と頼めば設定してもらえる。

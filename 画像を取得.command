#!/bin/bash
# Mac 用。ダブルクリックで実行できる
cd "$(dirname "$0")" || exit 1

echo "============================================================"
echo "  公式画像の取得"
echo "============================================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[エラー] Node.js が見つかりません。"
  echo "  https://nodejs.org/ja から「推奨版 (LTS)」をインストールしてから"
  echo "  もう一度このファイルをダブルクリックしてください。"
  echo
  read -r -p "Enter キーで閉じます..."
  exit 1
fi

if [ ! -d node_modules/sharp ]; then
  echo "画像を縮小するための sharp を導入します (初回のみ)..."
  echo
  npm install sharp --no-audit --no-fund
  echo
fi

echo "公式画像を取得しています..."
echo
node tools/fetch-assets.mjs || { echo; echo "取得に失敗しました。"; read -r -p "Enter キーで閉じます..."; exit 1; }

echo
echo "配布ファイルを作り直しています..."
echo
node build.js

echo
echo "============================================================"
echo "  完了しました"
echo "  index.html をダブルクリックすると確認できます"
echo "============================================================"
echo
read -r -p "Enter キーで閉じます..."

@echo off
chcp 65001 >nul
cd /d "%~dp0"
title VALORANT TACTICAL SETUP CARD - 公式画像の取得

echo ============================================================
echo   公式画像の取得
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [エラー] Node.js が見つかりません。
  echo.
  echo   https://nodejs.org/ja から「推奨版 ^(LTS^)」をインストールしてから
  echo   もう一度このファイルをダブルクリックしてください。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\sharp" (
  echo 画像を縮小するための sharp を導入します ^(初回のみ・1分ほどかかります^)...
  echo.
  call npm install sharp --no-audit --no-fund
  echo.
)

echo 公式画像を取得しています...
echo.
call node tools\fetch-assets.mjs
if errorlevel 1 (
  echo.
  echo 取得に失敗しました。上のメッセージを確認してください。
  echo.
  pause
  exit /b 1
)

echo.
echo 配布ファイルを作り直しています...
echo.
call node build.js

echo.
echo ============================================================
echo   完了しました
echo   index.html をダブルクリックすると確認できます
echo ============================================================
echo.
pause

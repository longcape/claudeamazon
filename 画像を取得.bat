@echo off
cd /d "%~dp0"
title VALORANT TACTICAL SETUP CARD

echo ============================================================
echo   公式画像の取得
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NONODE

if not exist "node_modules\sharp" (
  echo 画像を縮小する sharp を導入します。初回のみ、1分ほどかかります。
  echo.
  call npm install sharp --no-audit --no-fund
  echo.
)

echo 公式画像を取得しています...
echo.
call node tools\fetch-assets.mjs
if errorlevel 1 goto FAILED

echo.
echo 配布ファイルを作り直しています...
echo.
call node build.js

echo.
echo ============================================================
echo   完了しました
echo.
echo   index.html をダブルクリックすると確認できます
echo   assets\img\maps\summit.png が増えていれば成功です
echo ============================================================
goto END

:NONODE
echo [エラー] Node.js が見つかりません。
echo.
echo   https://nodejs.org/ja から推奨版をインストールしてから
echo   もう一度このファイルをダブルクリックしてください。
goto END

:FAILED
echo.
echo 取得に失敗しました。上に出ているメッセージを確認してください。
goto END

:END
echo.
pause

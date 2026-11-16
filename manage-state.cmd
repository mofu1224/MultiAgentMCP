@echo off
chcp 65001 >nul
rem --no-warnings: node:sqliteの実験的機能の警告で表示が埋もれないようにする
node --no-warnings "%~dp0src\manage-state.mjs" %*
echo.
pause

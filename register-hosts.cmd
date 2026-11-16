@echo off
rem Codex / Claude Code / OpenCode へユーザー単位で登録する（VS Code Copilotにも登録する場合は --vscode）。
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 24以上が見つかりません。インストールしてから再実行してください。& echo. & pause & exit /b 1)
node "%~dp0src\register-hosts.mjs" %*
echo.
pause

@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0src\select-models.mjs" %*
echo.
pause

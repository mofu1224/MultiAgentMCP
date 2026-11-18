@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
node "%~dp0src\select-models.mjs" %*
set "result=%errorlevel%"
popd
if not "%~1"=="" exit /b %result%
echo.
if not "%result%"=="0" echo Exit code: %result%
pause
exit /b %result%

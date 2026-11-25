@echo off
rem Starts the OpenCommander agent in a visible terminal that shows every call. Close the window to stop.
title OpenCommander Agent
cd /d "%~dp0"
set OC_PRETTY=1
rem Stop any older hidden copy first (two copies with one token fight each other).
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'agent[\\/]src[\\/]cli\.ts run' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
:loop
call npm run agent --silent -- run
set CODE=%ERRORLEVEL%
if "%CODE%"=="0" goto end
if "%CODE%"=="2" (echo. & echo Token rejected or device revoked. Re-pair: npm run agent -- pair CODE & goto end)
echo Agent stopped unexpectedly [exit %CODE%]. Restarting in 5 s...
timeout /t 5 /nobreak >nul
goto loop
:end
echo.
pause

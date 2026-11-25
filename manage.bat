@echo off
rem OpenCommander management console: plugin name, logo, tools, connections, passphrase, 2FA, gateway, devices.
title OpenCommander Manage
cd /d "%~dp0"
call npm run manage --silent
echo.
pause

@echo off
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "voice-contractun-handshake.ps1"
echo.
pause

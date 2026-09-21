@echo off
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "voice-contract\run-handshake.ps1"
echo.
pause

@echo off
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "voice-contractun-conversation.ps1"
echo.
pause

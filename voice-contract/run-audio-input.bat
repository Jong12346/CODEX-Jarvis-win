@echo off
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "voice-contractun-audio-input.ps1"
echo.
pause

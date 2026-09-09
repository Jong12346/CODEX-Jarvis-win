@echo off
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "voice-contract\run-audio-input.ps1"
echo.
pause

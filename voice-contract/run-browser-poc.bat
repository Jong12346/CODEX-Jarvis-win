@echo off
cd /d "%~dp0.."
npm run voice:dev -- --open /browser-poc.html
pause

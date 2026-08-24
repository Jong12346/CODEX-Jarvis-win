$ErrorActionPreference = "Stop"

# 无论从哪里运行，先切到项目根目录，避免相对路径找不到模块
Set-Location -Path (Join-Path $PSScriptRoot "..")

Write-Host "=== Doubao Duplex audio input check ===" -ForegroundColor Cyan
Write-Host "Paste your API Key below (input is hidden, never displayed)." -ForegroundColor Yellow
$secure = Read-Host "API Key" -AsSecureString
if ($null -eq $secure -or $secure.Length -eq 0) {
    Write-Error "API Key must not be empty."
    exit 1
}
$env:DOUBAO_API_KEY = [System.Net.NetworkCredential]::new("", $secure).Password
node voice-contract/audio-input-check.mjs
exit $LASTEXITCODE

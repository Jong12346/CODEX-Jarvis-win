$ErrorActionPreference = "Stop"

Write-Host "=== Doubao Duplex handshake check ===" -ForegroundColor Cyan
Write-Host "Paste your API Key below (input is hidden, never displayed)." -ForegroundColor Yellow
$secure = Read-Host "API Key" -AsSecureString
if ($null -eq $secure -or $secure.Length -eq 0) {
    Write-Error "API Key must not be empty."
    exit 1
}
$env:DOUBAO_API_KEY = [System.Net.NetworkCredential]::new("", $secure).Password
node voice-contract/handshake-check.mjs
exit $LASTEXITCODE

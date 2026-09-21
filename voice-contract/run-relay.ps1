$ErrorActionPreference = 'Stop'

Write-Host '=== Doubao localhost WebSocket relay ===' -ForegroundColor Cyan
Write-Host 'Paste your API Key below (input is hidden, never displayed).' -ForegroundColor Yellow
$secureKey = Read-Host 'API Key' -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

try {
    $env:DOUBAO_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    node (Join-Path $PSScriptRoot 'relay-server.mjs')
}
finally {
    Remove-Item Env:DOUBAO_API_KEY -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
}

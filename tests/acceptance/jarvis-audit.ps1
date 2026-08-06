<#
.SYNOPSIS
Jarvis 只读实机取证脚本：汇总结构化日志、输出脱敏配置摘要、抓取进程树与系统信息。

.DESCRIPTION
只读取证，不修改任何文件。可指定 -OutputPath 将报告写入文件。
运行示例：
  powershell -ExecutionPolicy Bypass -File tests/acceptance/jarvis-audit.ps1
  powershell -ExecutionPolicy Bypass -File tests/acceptance/jarvis-audit.ps1 -OutputPath before.txt -SkipProcess
#>
[CmdletBinding()]
param(
    [string]$LogPath,
    [string]$SettingsPath,
    [string]$OutputPath,
    [switch]$SkipProcess
)

$ErrorActionPreference = 'SilentlyContinue'
$report = New-Object System.Collections.Generic.List[string]

function Write-Report {
    param([string]$Text)
    $report.Add($Text)
}

function Find-Latest {
    param([string]$FileName)
    $candidates = @(
        Get-ChildItem -Path $env:APPDATA -Recurse -File -Filter $FileName -ErrorAction SilentlyContinue
        Get-ChildItem -Path $env:LOCALAPPDATA -Recurse -File -Filter $FileName -ErrorAction SilentlyContinue
    )
    # 日志文件名本身是 Jarvis 专属；settings.json 则只认路径含 jarvis 的，
    # 绝不回退到其他应用的配置。
    if ($FileName -eq 'settings.json') {
        $candidates = $candidates | Where-Object {
            $_.FullName -match 'jarvis' -and $_.FullName -notmatch '\\Codex\\'
        }
    }
    return ($candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}

function Redact-Text {
    param([string]$Text)
    $out = $Text
    $out = $out -replace '(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+', '$1<redacted>'
    $out = $out -replace '(?i)(sk-)[A-Za-z0-9_-]+', 'sk-<redacted>'
    $out = $out -replace '(?i)(://[^/:@]+:)[^@/]+@', '$1<redacted>@'
    $out = $out -replace '(?i)((TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|CREDENTIAL|AUTH)[A-Za-z0-9_]*=)[^\s;,&]+', '$1<redacted>'
    $out = $out -replace '(?i)([\\/]Users[\\/])[^\\/]+', '$1<user>'
    $out = $out -replace '(?i)([\\/]home[\\/])[^\\/]+', '$1<user>'
    return $out
}

function Get-Tree {
    param(
        [object[]]$All,
        [int]$ParentId,
        [int]$Depth
    )
    $children = $All | Where-Object { $_.ParentProcessId -eq $ParentId }
    foreach ($child in $children) {
        $indent = '  ' * $Depth
        $line = '{0}pid={1}  name={2}  ppid={3}' -f $indent, $child.ProcessId, $child.Name, $child.ParentProcessId
        if ($child.ExecutablePath) { $line += '  path=' + $child.ExecutablePath }
        Write-Report (Redact-Text $line)
        Get-Tree -All $All -ParentId $child.ProcessId -Depth ($Depth + 1)
    }
}

Write-Report '=== Jarvis 实机取证 ==='
Write-Report ('时间: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

# ---- 日志定位 ----
if (-not $LogPath) { $LogPath = Find-Latest -FileName 'jarvis-runtime.jsonl' }
Write-Report ('日志: ' + $LogPath)
if ($LogPath -and (Test-Path $LogPath)) {
    $lines = Get-Content -LiteralPath $LogPath
    Write-Report ('日志行数: ' + $lines.Count)

    $voice = $lines | Select-String -Pattern 'voice\.state_transition'
    Write-Report ('--- Voice 状态迁移 (共 ' + $voice.Count + ' 条，最近 12) ---')
    $voice | Select-Object -Last 12 | ForEach-Object { Write-Report (Redact-Text $_.Line) }

    $stop = $lines | Select-String -Pattern 'stop_sequence\.action'
    Write-Report ('--- STOP 序列 (共 ' + $stop.Count + ' 条，最近 12) ---')
    $stop | Select-Object -Last 12 | ForEach-Object { Write-Report (Redact-Text $_.Line) }

    $wake = $lines | Select-String -Pattern 'wake\.protocol'
    Write-Report ('--- 唤醒协议日志 (共 ' + $wake.Count + ' 条，最近 5) ---')
    $wake | Select-Object -Last 5 | ForEach-Object { Write-Report (Redact-Text $_.Line) }
} else {
    Write-Report '未找到 jarvis-runtime.jsonl（应用可能尚未启动或日志目录不同）。'
}

# ---- 配置摘要（脱敏） ----
if (-not $SettingsPath) { $SettingsPath = Find-Latest -FileName 'settings.json' }
Write-Report ('配置: ' + $SettingsPath)
if ($SettingsPath -and (Test-Path $SettingsPath)) {
    Write-Report '--- settings.json（已脱敏） ---'
    try {
        $settings = Get-Content -LiteralPath $SettingsPath -Raw
        Write-Report (Redact-Text $settings)
    } catch {
        Write-Report 'settings.json 无法读取（可能已损坏）。'
    }
} else {
    Write-Report '未找到 settings.json（首次运行会创建）。'
}

# ---- 进程树 ----
if (-not $SkipProcess) {
    Write-Report '--- 相关进程树 ---'
    $all = Get-CimInstance Win32_Process
    $roots = $all | Where-Object { $_.Name -match '^codex\.exe$|^JarvisWakeListener\.exe$|^jarvis-codex\.exe$' }
    if ($roots) {
        foreach ($root in $roots) {
            Write-Report ('root pid=' + $root.ProcessId + '  name=' + $root.Name + '  ppid=' + $root.ParentProcessId)
            Get-Tree -All $all -ParentId $root.ProcessId -Depth 1
        }
    } else {
        Write-Report '未发现 codex.exe / JarvisWakeListener 进程。'
    }
}

# ---- 系统与 WebView2 ----
Write-Report '--- 系统信息 ---'
$os = Get-CimInstance Win32_OperatingSystem
if ($os) {
    Write-Report ('系统: ' + $os.Caption + '  ' + $os.Version)
    Write-Report ('架构: ' + $env:PROCESSOR_ARCHITECTURE)
}
$webview = Get-ItemProperty -Path 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -Name pv -ErrorAction SilentlyContinue
Write-Report ('WebView2: ' + $(if ($webview) { $webview.pv } else { '未找到（可能缺失）' }))

Write-Report '=== 取证结束 ==='

$output = $report -join "`r`n"
$output
if ($OutputPath) {
    $output | Set-Content -LiteralPath $OutputPath -Encoding UTF8
    Write-Report ('报告已写入: ' + $OutputPath)
}

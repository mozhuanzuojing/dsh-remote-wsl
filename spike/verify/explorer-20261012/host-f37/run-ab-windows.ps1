#!/usr/bin/env pwsh
# run-ab-windows.ps1 —— F-37 根因确认：逐形态枚举"可见窗口/终端宿主"，全程 Hidden + 重定向（观测本身不弹窗）。
# 每个形态：snap A → 起 runner（Hidden）→ sleep → snap B（存活期）→ 等 runner 退出 → sleep → snap C。
# 判据（可复算）：∆A→B 里新增的 WindowsTerminal/conhost 窗口进程；∆B→C 里关闭的。
[CmdletBinding()]
param([string[]]$Variants, [int]$ProbeMs = 3500, [int]$SettleMs = 2500)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$node = 'C:\Users\l\AppData\Local\mise\shims\node.exe'

function Snap([string]$label) {
  $wins = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
      [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle; start = $_.StartTime.ToString('HH:mm:ss.fff') }
    })
  # 终端宿主/包装层：WindowsTerminal（WT 接管控制台）+ conhost/OpenConsole（经典控制台）+ 所有 wsl.exe
  $hosts = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -in @('WindowsTerminal.exe', 'conhost.exe', 'OpenConsole.exe', 'wsl.exe') } |
      ForEach-Object {
        [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; created = "$($_.CreationDate)" }
      })
  return [pscustomobject]@{ label = $label; at = (Get-Date).ToString('HH:mm:ss.fff'); wins = $wins; hosts = $hosts }
}

function Delta($a, $b, [string]$kind) {
  $ak = @($a.$kind | ForEach-Object { $_.pid })
  return @($b.$kind | Where-Object { $ak -notcontains $_.pid })
}

$results = @()
foreach ($v in $Variants) {
  Write-Host "`n================ variant: $v ================"
  $A = Snap 'A'
  $log = Join-Path $Root "out-ab-$v.log"
  $err = "$log.err"
  # ★ 观测本身不许弹窗：Hidden + 重定向
  $pr = Start-Process -FilePath $node -ArgumentList @("`"$Root\variant-runner.mjs`"", $v, 'debian-u8-1') `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError $err
  Start-Sleep -Milliseconds $ProbeMs
  $B = Snap 'B'
  $pr.WaitForExit(30000) | Out-Null
  Start-Sleep -Milliseconds $SettleMs
  $C = Snap 'C'

  $newWins = Delta $A $B 'wins'
  $newHosts = Delta $A $B 'hosts'
  $goneHosts = @($B.hosts | Where-Object { @($C.hosts | ForEach-Object { $_.pid }) -notcontains $_.pid })

  Write-Host "  A: wins=$($A.wins.Count) hosts=$($A.hosts.Count)"
  Write-Host "  B: wins=$($B.wins.Count) hosts=$($B.hosts.Count)"
  Write-Host "  C: wins=$($C.wins.Count) hosts=$($C.hosts.Count)"
  Write-Host "  runner: $(if (Test-Path $log) { (Get-Content $log -Raw).Trim() } else { '(no output)' })"
  if ($newWins.Count) { Write-Host "  ⚠ ∆A→B 新增**带窗口**进程:"; $newWins | ForEach-Object { Write-Host "      pid=$($_.pid) $($_.name) title=$($_.title) start=$($_.start)" } }
  if ($newHosts.Count) { Write-Host "  ∆A→B 新增终端宿主/包装层进程:"; $newHosts | ForEach-Object { Write-Host "      pid=$($_.pid) ppid=$($_.ppid) $($_.name) created=$($_.created)" } }
  if ($goneHosts.Count) { Write-Host "  ∆B→C 消失:"; $goneHosts | ForEach-Object { Write-Host "      pid=$($_.pid) $($_.name)" } }
  Write-Host "  ⇒ 窗口出现: $(if ($newWins.Count -or ($newHosts | Where-Object { $_.name -in @('WindowsTerminal.exe','conhost.exe','OpenConsole.exe') }).Count) { 'YES（有窗）' } else { 'NO（无窗）' })"

  $results += [pscustomobject]@{
    variant       = $v
    winDeltaAB    = $newWins.Count
    hostDeltaAB   = $newHosts.Count
    terminalDelta = @($newHosts | Where-Object { $_.name -in @('WindowsTerminal.exe', 'conhost.exe', 'OpenConsole.exe') }).Count
    windowAppeared = [bool]($newWins.Count -or @($newHosts | Where-Object { $_.name -in @('WindowsTerminal.exe', 'conhost.exe', 'OpenConsole.exe') }).Count)
    runner = $(if (Test-Path $log) { (Get-Content $log -Raw).Trim() } else { '' })
    newWins = $newWins
    newHosts = $newHosts
  }
}

$json = Join-Path $Root 'out-ab-summary.json'
($results | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $json -Encoding utf8
Write-Host "`n================ 汇总 ================"
$results | Select-Object variant, winDeltaAB, hostDeltaAB, terminalDelta, windowAppeared | Format-Table -AutoSize
Write-Host "JSON -> $json"

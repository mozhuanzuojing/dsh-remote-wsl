#!/usr/bin/env pwsh
# red-check.ps1 —— 两条约束的紧凑断言（给基线/故意红三次跑同一套判据）。
# 判据：① 宿主存活期窗口 ∆=0（约束 a）② 宿主**退出后**握手仍 ok 且 pid 不变（约束 b）③ notes 里的启动方式/告警
[CmdletBinding()]
param([int]$Port = 8912, [string]$Label = 'baseline')
$ErrorActionPreference = 'Stop'
$node = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
$Root = $PSScriptRoot
$probe = 'D:\project\net1\_t15-f37\probe-f37.ts'
$ka = Join-Path (Split-Path $PSScriptRoot -Parent) 'host-f37\keepalive-launcher.ts'   # T59：位置无关（原来硬编码到仓外 _t15-f37）

function Snap {
  $wins = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.Id })
  $wt = @(Get-CimInstance Win32_Process -Filter "Name='WindowsTerminal.exe'" -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessId })
  return [pscustomobject]@{ wins = $wins; wt = $wt }
}
function Probe([string[]]$e) {
  $log = Join-Path $Root "tmp-red-$Label-probe.log"
  $a = @("`"$probe`"") + $e
  $pr = Start-Process -FilePath $node -ArgumentList $a -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $pr.WaitForExit(120000) | Out-Null
  return $(if (Test-Path $log) { Get-Content $log -Raw } else { '' })
}
function Res([string]$t) { $m = [regex]::Match($t, '(?m)^RESULT (.*)$'); if ($m.Success) { return ($m.Groups[1].Value | ConvertFrom-Json) } return $null }

$A = Snap
$log = Join-Path $Root "tmp-red-$Label-host.log"
$hostProc = Start-Process -FilePath $node -ArgumentList @("`"$ka`"", "$Port", '8000', 'fresh') -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
Start-Sleep -Milliseconds 4500
$B = Snap
$hs1 = Res (Probe @('--mode', 'handshake', '--port', "$Port"))
$hostTxt = $(if (Test-Path $log) { Get-Content $log -Raw } else { '' })
$resLine = ([regex]::Match($hostTxt, '(?m)^LAUNCHED .*$')).Value
$winD = @($B.wins | Where-Object { $A.wins -notcontains $_ }).Count + @($B.wt | Where-Object { $A.wt -notcontains $_ }).Count
$newWt = @($B.wt | Where-Object { $A.wt -notcontains $_ })
$hostProc.WaitForExit(60000) | Out-Null
Start-Sleep -Milliseconds 2500
$hs2 = Res (Probe @('--mode', 'handshake', '--port', "$Port"))
$survived = ($hs2.ok -eq $true) -and ($hs2.pid -eq $hs1.pid)
$warn = ($hostTxt -match '未能由 systemd 托管') -or ($hostTxt -match '告警')
$systemd = ($hostTxt -match 'systemd-run')
Write-Host "[$Label] ① 窗口∆=$winD $(if($newWt.Count){"（新 WT: $($newWt -join ',')）"})  ② 宿主退出后存活=$survived (hs1.pid=$($hs1.pid) hs2.pid=$($hs2.pid))  ③ systemd标记=$systemd 回退告警=$warn"
Write-Host "       宿主首行: $resLine"
$json = [pscustomobject]@{ label = $Label; windowDelta = $winD; newWt = $newWt; survivedHostExit = $survived; hs1 = $hs1.pid; hs2 = $hs2.pid; systemdPath = $systemd; fallbackWarned = $warn }
($json | ConvertTo-Json -Compress) | Set-Content -LiteralPath (Join-Path $Root "out-red-$Label.json") -Encoding utf8
# 收尾：停我自己的守护
& $node $probe --mode stop --port $Port | Out-Null
exit 0

#!/usr/bin/env pwsh
# int-20261010/verify-port-conflict.ps1 —— task-4 #2：端口静默冲突（缺陷 #11）是否真的修好。
#   A) Windows 侧先占 8756（守护的 cfg.daemonPort）⇒ 期望：**快速**判定 + 换端口 + 可读说明（不是挂死）
#   B) Windows 侧把 8756/8757/8758 全占（daemonPortTries=3）⇒ 期望：**可读报错**且总耗时远小于 300s
# 只占我自己选的端口；结束即释放。
[CmdletBinding()]
param([int]$Base = 8756)
$ErrorActionPreference = 'Stop'
$P = $PSScriptRoot
$node = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
$probe = Join-Path $P 'probe.ts'
function Say($m) { Write-Host $m }
function Occupy([int]$port, [string]$tag) {
  $f = Join-Path $P "occupy-$tag.state"
  Remove-Item -LiteralPath $f -ErrorAction SilentlyContinue
  $j = Start-Job -ScriptBlock {
    param($p, $f)
    try {
      $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('127.0.0.1'), $p)
      $l.Start()
      "WINDOWS_BOUND $p" | Set-Content -LiteralPath $f
      Start-Sleep -Seconds 120
      $l.Stop()
    } catch { "WINDOWS_BIND_FAILED $p : $($_.Exception.Message)" | Set-Content -LiteralPath $f }
  } -ArgumentList $port, $f
  for ($i = 0; $i -lt 30 -and -not (Test-Path $f); $i++) { Start-Sleep -Milliseconds 300 }
  $state = ''
  for ($i = 0; $i -lt 20 -and -not $state; $i++) { $state = [string](Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue); if (-not $state) { Start-Sleep -Milliseconds 200 } }
  return [pscustomobject]@{ Job = $j; Port = $port; State = $state }
}
function TcpProbe([int]$p) {
  try { $c = [Net.Sockets.TcpClient]::new(); $c.Connect('127.0.0.1', $p); $ok = $c.Connected; $c.Close(); return "windows_tcp_connected=$ok" }
  catch { return "windows_tcp_REFUSED($($_.Exception.InnerException.Message))" }
}
function RunProbe([string[]]$a, [string]$log) {
  $q = foreach ($x in $a) { if ($x -match '[\s"]') { '"' + $x.Replace('"', '\"') + '"' } else { $x } }
  $cmd = '"' + $probe + '" ' + ($q -join ' ')
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $node -ArgumentList $cmd -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $p.WaitForExit(); $sw.Stop()
  return [pscustomobject]@{ Exit = $p.ExitCode; Ms = $sw.ElapsedMilliseconds }
}

Say "################ 前置：确保没有别的槽位可被复用（否则会直接复用而非走冲突路径）################"
$st = RunProbe @('--mode', 'daemon', '--action', 'status', '--port', "$Base") (Join-Path $P 'out-11a-precheck-status.txt')
Get-Content (Join-Path $P 'out-11a-precheck-status.txt') | ForEach-Object { Say "  $_" }

Say "`n################ A) Windows 先占 $Base（单端口）################"
$o1 = Occupy $Base 'a'
Say "  Windows 侧监听: $($o1.State.Trim())  |  $((TcpProbe $Base))"
$logA = Join-Path $P 'out-11b-conflict-fallback.txt'
$rA = RunProbe @('--mode', 'daemon', '--action', 'start', '--port', "$Base") $logA
Say "  probe exit=$($rA.Exit) 耗时=$($rA.Ms)ms"
Get-Content -LiteralPath $logA | ForEach-Object { Say "  $_" }
Say "  WSL 侧监听 8756/8757: $((& wsl.exe -d debian-u8-1 -u g -- bash -c 'ss -ltn | grep -E ":(8756|8757) " | tr "\n" ";"' 2>&1) -join '')"
Say "  --- 清理 A（停掉刚才在回退端口起的守护）---"
$rStopA = RunProbe @('--mode', 'daemon', '--action', 'stop', '--port', '8757') (Join-Path $P 'out-11c-stop-fallback.txt')
Get-Content (Join-Path $P 'out-11c-stop-fallback.txt') | ForEach-Object { Say "  $_" }
Stop-Job $o1.Job -ErrorAction SilentlyContinue; Remove-Job $o1.Job -Force -ErrorAction SilentlyContinue

Say "`n################ B) Windows 先占 $Base/$($Base+1)/$($Base+2)（三个回退端口全占）################"
$occ = @(); foreach ($p in @($Base, $Base + 1, $Base + 2)) { $occ += Occupy $p "b$p" }
foreach ($o in $occ) { Say "  $(($o.State -as [string]).Trim())  |  $((TcpProbe $o.Port))" }
$logB = Join-Path $P 'out-11d-conflict-hard-error.txt'
$rB = RunProbe @('--mode', 'daemon', '--action', 'start', '--port', "$Base") $logB
Say "  probe exit=$($rB.Exit) 耗时=$($rB.Ms)ms  （对比：旧形态默认 timeoutMs=300000ms 假死）"
Get-Content -LiteralPath $logB | ForEach-Object { Say "  $_" }
foreach ($o in $occ) { Stop-Job $o.Job -ErrorAction SilentlyContinue; Remove-Job $o.Job -Force -ErrorAction SilentlyContinue }
Say "`n################ 释放后核对 ################"
foreach ($p in @($Base, $Base + 1, $Base + 2)) { Say "  port $p : $((TcpProbe $p))" }


#!/usr/bin/env pwsh
# win-audit.ps1 —— T16 窗口归属的可复算工具（dot-source 使用）。
# 方法（lead 定稿）：① 账本 (pid,启动,父pid) ② 枚举可见窗口 (pid,标题,启动,父pid,父链) ③ 归属=父链可达我的账本 pid ④ 与 daemon.log 的 peer=win-pid-<pid> 交叉。不许凭标题猜。
#
# ⚠️ 仪器自查教训（T16，两次假结果都出在我自己的仪器上）：
#   v1 `Get-WinSnap` 抛 "Argument types do not match" 并静默返回空 → before=0/after=0 看起来像"Δ=0 绿"。
#   v2 用 `return , $res.ToArray()` → 多一层嵌套 → 7 个窗口被算成 `Count=1` → **假 Δ=5 红**。
#   现在：不用 List/不用 IntPtr cast/不用逗号包裹，纯 `$rows += [pscustomobject]@{…}` + `return $rows`。
#   `Test-WinInstrument` 要求本机可见窗口 ≥1，否则判 INSTRUMENT-FAIL（**不得当绿，也不得当红**）。

function Get-LedgerPath { param([string]$Dir = $PSScriptRoot) return (Join-Path $Dir 'out-90-ledger.tsv') }

function Add-Ledger {
  param([int]$ProcId, [string]$What, [int]$ParentPid = 0, [string]$Dir = $PSScriptRoot)
  $start = ''
  try { $start = (Get-Process -Id $ProcId -ErrorAction Stop).StartTime.ToString('yyyy-MM-dd HH:mm:ss') } catch { $start = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') }
  if (-not $ParentPid) { try { $ParentPid = [int](Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" -ErrorAction Stop).ParentProcessId } catch { $ParentPid = 0 } }
  $line = "$ProcId`t$start`t$ParentPid`t$What"
  Add-Content -LiteralPath (Get-LedgerPath $Dir) -Value $line -Encoding utf8
  return $line
}

function Get-WinSnap {
  param([int[]]$Ledger = @())
  $parent = @{}
  foreach ($ci in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    try { $parent[[int]$ci.ProcessId] = [int]$ci.ParentProcessId } catch { }
  }
  $rows = @()
  foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
    $title = ''
    try { $title = [string]$p.MainWindowTitle } catch { $title = '' }
    if ([string]::IsNullOrEmpty($title)) { continue }
    $start = 'n/a'
    try { $start = $p.StartTime.ToString('yyyy-MM-dd HH:mm:ss') } catch { $start = 'n/a' }
    $wid = [int]$p.Id
    $pp = 0
    if ($parent.ContainsKey($wid)) { $pp = $parent[$wid] }
    $chain = @(); $cur = $pp; $g = 0
    while ($cur -gt 0 -and $g -lt 8) { $chain += $cur; if ($parent.ContainsKey($cur)) { $cur = $parent[$cur] } else { $cur = 0 }; $g++ }
    $mine = $false
    foreach ($x in $chain) { if ($Ledger -contains $x) { $mine = $true; break } }
    $isWT = (($p.ProcessName -eq 'WindowsTerminal') -or ($title -match 'wsl\.exe'))
    $rows += [pscustomobject]@{
      pid = $wid; name = [string]$p.ProcessName; title = $title; start = $start
      ppid = $pp; chain = ($chain -join '<-'); mine = $mine; isWT = $isWT
    }
  }
  return $rows
}

function Test-WinInstrument {
  param([string]$Dir = $PSScriptRoot)
  $s = @(Get-WinSnap -Ledger @())
  $ok = ($s.Count -ge 1)
  if (-not $ok) { Write-Host '  ⚠️ INSTRUMENT-FAIL：枚举为 0 —— 本机至少有用户窗口（Code/Cursor/…）⇒ 仪器问题，不得当绿/红' }
  return [pscustomobject]@{ ok = $ok; count = $s.Count; list = (@($s | ForEach-Object { "$($_.name)#$($_.pid)" }) -join ' | ') }
}

function Win-Summary { param($Snap)
  $a = @($Snap)
  return [pscustomobject]@{
    count = $a.Count
    wt    = @($a | Where-Object { $_.isWT }).Count
    mine  = @($a | Where-Object { $_.mine }).Count
    list  = (@($a | ForEach-Object { "$($_.name)#$($_.pid)@$($_.start)" }) -join ' | ')
  }
}

function Win-Delta { param($Before, $After)
  $bp = @($Before | ForEach-Object { $_.pid })
  return @($After | Where-Object { $bp -notcontains $_.pid })
}

function Invoke-WinRound {
  param([string]$Label, [scriptblock]$Action, [int[]]$Ledger = @(), [string]$Dir = $PSScriptRoot)
  $before = @(Get-WinSnap -Ledger $Ledger)
  $t0 = Get-Date
  $rc = 0; $err = $null
  try { & $Action } catch { $err = $_.Exception.Message; $rc = -1 }
  Start-Sleep -Milliseconds 1400
  $after = @(Get-WinSnap -Ledger $Ledger)
  $delta = @(Win-Delta -Before $before -After $after)
  $valid = ($before.Count -ge 1 -and $after.Count -ge 1)
  return [pscustomobject]@{
    label = $Label; at = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); valid = $valid
    beforeCount = $before.Count; afterCount = $after.Count; delta = $delta.Count
    beforeWT = @($before | Where-Object { $_.isWT }).Count; afterWT = @($after | Where-Object { $_.isWT }).Count
    deltaList = (@($delta | ForEach-Object { "$($_.name)#$($_.pid) start=$($_.start) ppid=$($_.ppid) title=$($_.title) mine=$($_.mine) WT=$($_.isWT)" }) -join ' ;; ')
    actionError = $err; actionRc = $rc
  }
}

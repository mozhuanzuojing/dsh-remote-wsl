#!/usr/bin/env pwsh
<#
.SYNOPSIS
  占用探针（squatter）—— INJ-D 的夹具：按需占住 8971–8980 里的某些端口，用完**只按自己记录的 pid** 回收。

.DESCRIPTION
  支持两个位置：
    -Where wsl     → 在 WSL 里 listen（更贴近"守护端口被占"的真实形态：daemon.ts:589-601）
    -Where windows → 在 Windows 侧 listen（用来复验 mirrored 网络命名空间是否也占住 WSL 侧）

  纪律：
   · 必须带 -Go；
   · 端口必须落在 8971–8980，**拒绝** 19387 / 9910；
   · pid 一律记进 out-D-00-squatter-pids.json；-Stop **只**杀这些 pid（绝不全局 pkill/taskkill）；
   · 每次动作前后复验 19387 的 listener pid 未变（基线 47564）。

.EXAMPLE
  pwsh ./occupy-ports.ps1 -Ports 8972,8973,8974 -Where wsl -Go      # 造 F8（全占）
  node ../probe-ground-truth.ts --mode daemon --action start --port 8972   # 期望：throw 全被占用
  pwsh ./occupy-ports.ps1 -Stop -Go                                 # 回收
#>
[CmdletBinding()]
param(
  [int[]]$Ports = @(8975),
  [ValidateSet('wsl', 'windows')]
  [string]$Where = 'wsl',
  [string]$Distro = 'debian-u8-1',
  [switch]$Stop,
  [switch]$Go
)

$ErrorActionPreference = 'Stop'
$Dir = $PSScriptRoot
$PidFile = Join-Path $Dir 'out-D-00-squatter-pids.json'
$LiveHostPort = 19387
$LiveHostPidBaseline = 47564

function Assert-Ports {
  $bad = @()
  foreach ($p in $Ports) {
    if ($p -lt 8971 -or $p -gt 8980) { $bad += "端口 $p 不在 8971–8980" }
    if ($p -eq $LiveHostPort) { $bad += "端口 $p 是用户宿主，绝对禁止" }
    if ($p -eq 9910) { $bad += "端口 $p 是 proxy，绝对禁止" }
  }
  if ($bad.Count) { throw "拒跑：`n - " + ($bad -join "`n - ") }
}

function Assert-LiveHostUntouched([string]$when) {
  $c = Get-NetTCPConnection -LocalPort $LiveHostPort -State Listen -ErrorAction SilentlyContinue
  # ⚠ `$pid` 是 PowerShell **只读**自动变量 ⇒ 必须换名（否则运行时 "无法覆盖变量 PID"）。
  $listenerPid = if ($c) { [int]$c.OwningProcess } else { $null }
  Add-Content -Path (Join-Path $Dir 'out-D-00-livehost.txt') -Value "$(Get-Date -Format o) [$when] 19387 pid=$listenerPid baseline=$LiveHostPidBaseline" -Encoding utf8
  if ($listenerPid -ne $LiveHostPidBaseline) { throw "用户宿主 pid 变了（$LiveHostPidBaseline → $listenerPid）：停止实验。" }
}

Assert-Ports
if (-not $Go) {
  @"
占用探针计划（未执行；加 -Go 才动作）
  -Where $Where   端口 $($Ports -join ', ')   发行版 $Distro
  用途：F6（占 8971 → 宿主起不来）/ F7（占 8972 → 守护回退到 8973）/ F8（占 8972-8974 → 全占即 throw）
  回收：pwsh ./occupy-ports.ps1 -Stop -Go   （只杀本脚本记录的 pid）
  记账：$PidFile
"@ | Write-Host
  exit 0
}

Assert-LiveHostUntouched 'start'

if ($Stop) {
  if (-not (Test-Path $PidFile)) { Write-Host '没有记账文件 ⇒ 没有我起的占用进程（不动任何别的东西）'; exit 0 }
  $rec = Get-Content $PidFile -Raw | ConvertFrom-Json
  $stopped = @()
  foreach ($e in @($rec.entries)) {
    if (-not $e) { continue }
    if ($e.where -eq 'windows') {
      $proc = Get-Process -Id $e.pid -ErrorAction SilentlyContinue
      if ($proc) { Stop-Process -Id $e.pid -Force; $stopped += "windows pid=$($e.pid) port=$($e.port)" }
    } else {
      & wsl.exe -d $Distro -- bash -lc "kill $($e.pid) 2>/dev/null; exit 0" | Out-Null
      $stopped += "wsl pid=$($e.pid) port=$($e.port)"
    }
  }
  $stopped | Set-Content -Path (Join-Path $Dir 'out-D-99-cleanup.txt') -Encoding utf8
  Write-Host "已按记录回收 $($stopped.Count) 个占用进程（只这些）"
  $stopped | ForEach-Object { Write-Host "  - $_" }
  Remove-Item $PidFile -Force
  Assert-LiveHostUntouched 'end'
  exit 0
}

$entries = @()
foreach ($port in $Ports) {
  if ($Where -eq 'windows') {
    $child = @"
`$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
`$l.Start()
Write-Output "squatter listening 127.0.0.1:$port pid=`$PID"
Start-Sleep -Seconds 7200
"@
    $tmp = Join-Path $env:TEMP "rw-squatter-$port.ps1"
    Set-Content -Path $tmp -Value $child -Encoding utf8
    $p = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-File', $tmp) -PassThru -WindowStyle Hidden
    $entries += [ordered]@{ where = 'windows'; port = $port; pid = $p.Id; script = $tmp }
    Write-Host "  占住(windows) 127.0.0.1:$port pid=$($p.Id)"
  } else {
    # WSL 侧：用 python3 起一个只 bind 不发包的监听；把 pid 打到 stdout 以便记账
    $py = "import socket,time,sys;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',$port));s.listen(8);print('squatter',s.getsockname(),flush=True);time.sleep(7200)"
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($py))
    $out = & wsl.exe -d $Distro -- bash -lc "nohup python3 -c `"import base64;exec(base64.b64decode('$b64'))`" >/tmp/rw-squatter-$port.log 2>&1 & echo `$!" 2>&1
    $wslPid = ("$out" -replace '\D', '')
    $entries += [ordered]@{ where = 'wsl'; port = $port; pid = $wslPid; distro = $Distro; log = "/tmp/rw-squatter-$port.log" }
    Write-Host "  占住(wsl) 127.0.0.1:$port pid=$wslPid（日志 /tmp/rw-squatter-$port.log）"
  }
}
[ordered]@{ at = (Get-Date -Format o); where = $Where; entries = $entries } | ConvertTo-Json -Depth 6 | Set-Content -Path $PidFile -Encoding utf8

# 自证：占住的端口确实在 listen（否则后面的注入是空实验）
Start-Sleep -Milliseconds 700
foreach ($e in $entries) {
  $ok = if ($e.where -eq 'windows') {
    [bool](Get-NetTCPConnection -LocalPort $e.port -State Listen -ErrorAction SilentlyContinue)
  } else {
    (("$( & wsl.exe -d $Distro -- bash -lc "ss -ltn 2>/dev/null | grep -c ':$($e.port) '" 2>&1)" -replace '\D', '')) -ne '0'
  }
  Write-Host "  自证 port $($e.port) listening=$ok"
  if (-not $ok) { Write-Host "  ⚠ 未占住 ⇒ 相关注入实验判 UNKNOWN（不许当通过）" }
}

Assert-LiveHostUntouched 'end'
Write-Host "占用已就绪；回收：pwsh ./occupy-ports.ps1 -Stop -Go"

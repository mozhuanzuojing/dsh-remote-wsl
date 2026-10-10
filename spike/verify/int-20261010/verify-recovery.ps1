#!/usr/bin/env pwsh
# int-20261010/verify-recovery.ps1 —— task-4 #6：kill 守护后的恢复语义（不许静默丢上下文）。
#   A) 同进程：第 1 轮建会话 → 外部 kill -TERM 守护 → 同进程第 2 轮 ⇒ 应自动恢复 + 明确告知"会话已重置"
#   B) 跨进程：第 1 轮建会话 → 外部 kill -KILL 守护（元数据残留）→ **新进程** 第 2 轮 ⇒ 应自动恢复 + 明确告知
# 只 kill 我自己槽位、且 /proc/<pid>/cmdline 命中 daemon.ts 的进程（先验身份再杀）。
[CmdletBinding()]
param(
  [int]$Port = 8755,
  [string]$Distro = 'debian-u8-1'
)
$ErrorActionPreference = 'Stop'
$P = $PSScriptRoot
$node = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
$probe = Join-Path $P 'probe.ts'
$meta = "\\wsl.localhost\$Distro\home\g\.dsh\remote-wsl\daemon.$Port.json"
function Say($m) { Write-Host $m }
function Wsl([string]$b) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($b))
  return @((& wsl.exe -d $Distro -u g -- bash -c "echo $b64 | base64 -d | bash" 2>&1) | ForEach-Object { "$_" })
}
function DaemonPid {
  try { return (Get-Content -LiteralPath $meta -Raw | ConvertFrom-Json).pid } catch { return $null }
}
function KillVerified($targetPid, [string]$sig) {
  if (-not $targetPid) { return 'NO_PID_IN_META' }
  $r = Wsl "if [ -r /proc/$targetPid/cmdline ] && tr '\0' ' ' < /proc/$targetPid/cmdline | grep -q 'daemon\.ts'; then kill -s $sig $targetPid; echo IDENTITY_OK-$sig; else echo IDENTITY_MISMATCH; fi"
  return ($r -join ' ').Trim()
}
function TokenPath { "\\wsl.localhost\$Distro\home\g\.dsh\remote-wsl\daemon.$Port.token" }
function RunProbe([string[]]$a, [string]$log) {
  $q = foreach ($x in $a) { if ($x -match '[\s"]') { '"' + $x.Replace('"', '\"') + '"' } else { $x } }
  $cmd = '"' + $probe + '" ' + ($q -join ' ')
  $p = Start-Process -FilePath $node -ArgumentList $cmd -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  return $p
}

Say "################ A) 同进程：kill -TERM 守护后恢复 ################"
$flag = Join-Path $P 'kill-done.flag'
Remove-Item -LiteralPath $flag -ErrorAction SilentlyContinue
$logA = Join-Path $P 'out-10a-recover-inproc.txt'
$pA = RunProbe @('--mode', 'recover-inproc', '--port', "$Port", '--key', 'rkey-1', '--flag', $flag) $logA
for ($i = 0; $i -lt 300; $i++) {
  Start-Sleep -Milliseconds 300
  if ((Test-Path $logA) -and ((Get-Content $logA -Raw) -match '等待外部 kill')) { break }
}
Say "  第 1 轮已产出；杀守护前状态："
Say "  meta.pid=$(DaemonPid)"
Say "  wsl: $((Wsl 'pgrep -af -- "(^|/)daemon\.ts --port 8755" | cut -c1-100') -join ' | ')"
$dpid = DaemonPid
Say "  kill -TERM $dpid => $(KillVerified $dpid 'TERM')"
Start-Sleep -Seconds 2
Say "  kill 后 profile/daemon: $((Wsl 'echo daemon_ts=$(pgrep -f -- "daemon\.t[s]" | wc -l); echo listen8755=$(ss -ltn | grep -c ":8755 "); echo profile_sdk=$(pgrep -f -- "profile sd[k]" | wc -l)') -join '  ')"
New-Item -ItemType File -Path $flag -Force | Out-Null
$pA.WaitForExit()
Say "  ---- 同进程探针原始输出 ----"
Get-Content -LiteralPath $logA | ForEach-Object { Say "  $_" }
Say "  ---- 探针退出码=$($pA.ExitCode) ----"

Say "`n################ B) 跨进程：kill -KILL 守护（元数据残留）后新进程恢复 ################"
$logB1 = Join-Path $P 'out-10b-recover-newproc-turn1.txt'
$pB1 = RunProbe @('--mode', 'agent', '--port', "$Port", '--key', 'rkey-2', '--task', '记住数字 41。只回复 ACK') $logB1
$pB1.WaitForExit()
Get-Content -LiteralPath $logB1 | ForEach-Object { Say "  [turn1] $_" }
$dpid2 = DaemonPid
Say "  turn1 后 meta.pid=$dpid2"
Say "  kill -KILL $dpid2 => $(KillVerified $dpid2 'KILL')"
Start-Sleep -Seconds 2
Say "  残留元数据: $((Test-Path -LiteralPath $meta))  token: $((Test-Path -LiteralPath (TokenPath)))"
Say "  kill 后 wsl: $((Wsl 'echo daemon_ts=$(pgrep -f -- "daemon\.t[s]" | wc -l); echo listen8755=$(ss -ltn | grep -c ":8755 "); echo profile_sdk=$(pgrep -f -- "profile sd[k]" | wc -l)') -join '  ')"
$logB2 = Join-Path $P 'out-10b-recover-newproc-turn2.txt'
$pB2 = RunProbe @('--mode', 'agent', '--port', "$Port", '--key', 'rkey-2', '--task', '刚才让你记的数字？只回数字') $logB2
$pB2.WaitForExit()
Say "  ---- 新进程第 2 轮原始输出 ----"
Get-Content -LiteralPath $logB2 | ForEach-Object { Say "  $_" }
Say "`n恢复后现场: $((Wsl 'echo daemon_ts=$(pgrep -f -- "daemon\.t[s]" | wc -l); echo listen8755=$(ss -ltn | grep -c ":8755 ")') -join '  ')"

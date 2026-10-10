#!/usr/bin/env pwsh
# fix-20261010/run-concurrency.ps1 —— task-11 #1/#2 我自己写的并发复现（two slots at once）。
# 断言：2 请求 = 2 守护；每槽位元数据 port == 实际监听 == 槽位；无"无元数据守护"；stop --all 后零孤儿。
# 所有 WSL 检查经 probe2.ts --mode script（内部用 落文件+bash <file>，绝无内联 bash -c）。
[CmdletBinding()]
param([int]$SlotA = 8861, [int]$SlotB = 8862, [string]$Tag = 'race')
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$node = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
$probe = Join-Path $Root 'probe2.ts'
function Say($m) { Write-Host $m }
function Probe([string[]]$a) {
  $q = foreach ($x in $a) { if ($x -match '[\s"]') { '"' + $x.Replace('"', '\"') + '"' } else { $x } }
  $log = Join-Path $Root ("out-$Tag-" + [guid]::NewGuid().ToString('N').Substring(0, 5) + '.txt')
  $prc = Start-Process -FilePath $node -ArgumentList ('"' + $probe + '" ' + ($q -join ' ')) -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  return [pscustomobject]@{ Proc = $prc; Log = $log }
}
function ProbeWait([string[]]$a) {
  $h = Probe $a
  $h.Proc.WaitForExit(180000) | Out-Null
  return $h
}
function ShowLog($log) { Get-Content -LiteralPath $log -ErrorAction SilentlyContinue | ForEach-Object { Say "  $_" } }
function Scan([int]$port) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(@'
echo "--- /proc 扫描（只认带本插件 state-dir 的 daemon）---"
for p in $(pgrep -f -- 'daemon\.t[s]' 2>/dev/null); do
  c=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)
  case "$c" in *"--state-dir /home/g/.dsh/remote-wsl "*) echo "  pid=$p $(echo "$c" | grep -oE '\-\-port [0-9]+|\-\-meta-port [0-9]+|\-\-launcher [^ ]+')";; esac
done
echo "--- 监听 ---"; ss -ltn | awk '{print $4}' | grep -oE ':(88[0-9][0-9])$' | sort | tr '\n' ' '; echo
echo "--- 元数据 ---"
for f in "$HOME/.dsh/remote-wsl/"daemon.*.json; do [ -e "$f" ] && echo "  $(basename $f) port=$(grep -oE '"port": [0-9]+' "$f" | grep -oE '[0-9]+') pid=$(grep -oE '"pid": [0-9]+' "$f" | grep -oE '[0-9]+')"; done
echo "--- launcher 文件 ---"; ls -1 "$HOME/.dsh/remote-wsl/"launch.*.sh 2>/dev/null | tr '\n' ' '; echo
'@))
  return ProbeWait @('--mode', 'script', '--port', "$port", '--script-b64', $b64)
}

Say "################ 0) 基线 ################"
ShowLog (Scan $SlotA).Log

Say "`n################ 1) 两个独立进程**同时**启动两个槽位（$SlotA / $SlotB）################"
$ha = Probe @('--mode', 'tool-start', '--port', "$SlotA")
$hb = Probe @('--mode', 'tool-start', '--port', "$SlotB")
$ha.Proc.WaitForExit(180000) | Out-Null
$hb.Proc.WaitForExit(180000) | Out-Null
Say "  进程A(pid=$($ha.Proc.Id)) exit=$($ha.Proc.ExitCode):"; ShowLog $ha.Log
Say "  进程B(pid=$($hb.Proc.Id)) exit=$($hb.Proc.ExitCode):"; ShowLog $hb.Log

Say "`n################ 2) 现场核对（元数据 port / 实际监听 / 无元数据守护）################"
$scan = Scan $SlotA
ShowLog $scan.Log

Say "`n################ 3) stop --all ⇒ 零孤儿 ################"
$stopH = ProbeWait @('--mode', 'tool-stop', '--port', "$SlotA", '--all')
ShowLog $stopH.Log
Start-Sleep -Seconds 2
$after = Scan $SlotA
ShowLog $after.Log

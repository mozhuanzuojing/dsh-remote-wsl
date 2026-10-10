#!/usr/bin/env pwsh
# verify/verify-kill.ps1 —— README §8 把"守护被 kill 后的恢复/残留"列为**未验证**。
# 这里把两种 kill 的差别测出来：
#   SIGTERM：daemon.ts 有 handler → reapAll 应把运行时一起收掉
#   SIGKILL：node 拦不住 → 运行时（detached 进程组）是否变孤儿、继续占着 session 与配额？
[CmdletBinding()]
param(
  [string]$Distro = 'debian-u8-1',
  [string]$Version = '0.2.0-rc.2',
  [string]$Cwd = '/home/g',
  [string]$NodeExe = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
)
$ErrorActionPreference = 'Stop'
$VerifyDir = $PSScriptRoot
$SpikeDir = Split-Path $VerifyDir -Parent
$ClientTs = Join-Path $SpikeDir 'client.ts'
$DaemonTs = Join-Path $SpikeDir 'daemon.ts'
function Say($m) { Write-Host $m }
function Wsl([string]$b) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($b))
  return @((& wsl.exe -d $Distro -u g -- bash -c "echo $b64 | base64 -d | bash" 2>&1) | ForEach-Object { "$_" })
}
function WslPath([string]$p) {
  $full = (Resolve-Path -LiteralPath $p).Path
  $d = $full.Substring(0, 1).ToLower(); $r = $full.Substring(2).Replace('\', '/')
  return "/mnt/$d$r"
}
$DaemonWsl = WslPath $DaemonTs
$PATHX = 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"'
function RuntimePids { return (((Wsl "$PATHX`npgrep -f -- 'profile sd[k]' | sort -n | tr '\n' ','") -join '')).Trim() }
function DaemonPids { return (((Wsl "$PATHX`npgrep -f -- 'spike/daemon.t[s]' | sort -n | tr '\n' ','") -join '')).Trim() }
function Start-Daemon([int]$p, [int]$idle, [string]$tag) {
  $sh = "$PATHX`nexec mise exec -- node $DaemonWsl --port $p --version $Version --cwd $Cwd --idle-ms $idle`n"
  $shWin = Join-Path $VerifyDir "kill-$tag-$p.sh"
  [IO.File]::WriteAllText($shWin, $sh.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
  $o = Join-Path $VerifyDir "kill-$tag-$p.out.log"; $e = Join-Path $VerifyDir "kill-$tag-$p.err.log"
  Remove-Item -LiteralPath $o, $e -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'g', '--', 'bash', (WslPath $shWin)) -RedirectStandardOutput $o -RedirectStandardError $e -PassThru -WindowStyle Hidden
  return [pscustomobject]@{ Proc = $proc; Out = $o; Err = $e }
}
function Client([string[]]$ca) {
  $quoted = foreach ($a in $ca) { if ($a -match '[\s"]') { '"' + $a.Replace('"', '\"') + '"' } else { $a } }
  $out = Join-Path $VerifyDir ("kill-client-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + ".txt")
  $err = "$out.err"
  $p = Start-Process -FilePath $NodeExe -ArgumentList ('"' + $ClientTs + '" ' + ($quoted -join ' ')) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  return [pscustomobject]@{ Exit = $p.ExitCode; Raw = ((Get-Content -LiteralPath $out -Raw) -as [string]).Trim() }
}
function WaitReady([int]$p, $d) {
  for ($i = 1; $i -le 60; $i++) {
    Start-Sleep -Milliseconds 750
    $r = Client @('--port', "$p", '--status')
    if ($r.Exit -eq 0) { return ($r.Raw | ConvertFrom-Json) }
    if ($d.Proc.HasExited) { return $null }
  }
  return $null
}

foreach ($sig in @('TERM', 'KILL')) {
  $port = if ($sig -eq 'TERM') { 8737 } else { 8738 }
  Say "################ 守护启动 → prompt 一轮 → kill -s $sig ################"
  $d = Start-Daemon $port 600000 "sig$sig"
  $st = WaitReady $port $d
  if ($null -eq $st) { Say "  [FAIL] daemon 未就绪"; continue }
  Say "  daemonPid=$($st.daemonPid) port=$port"
  $r = Client @('--host', '127.0.0.1', '--port', "$port", '--key', 'k1', '--text', '只回复 ACK')
  Say "  prompt → $($r.Raw)"
  $j = $r.Raw | ConvertFrom-Json
  Say "  runtimePid=$($j.runtimePid)"
  $rtPid = [int]$j.runtimePid
  Say "  杀掉前: runtime_pids=[$(RuntimePids)] daemon_pids=[$(DaemonPids)]"
  $k = Wsl "$PATHX`nkill -s $sig $($st.daemonPid) 2>&1; echo kill_rc=`$?"
  Say "  kill -s $sig $($st.daemonPid) → $($k -join ' ')"
  Start-Sleep -Seconds 4
  Say "  杀掉后: runtime_pids=[$(RuntimePids)] daemon_pids=[$(DaemonPids)]"
  $d1 = Client @('--port', "$port", '--status', '--timeout-ms', '5000')
  Say "  客户端 --status: exit=$($d1.Exit) raw=$($d1.Raw)"
  if ($sig -eq 'TERM') {
    if ([string]::IsNullOrWhiteSpace((RuntimePids))) { Say '  [PASS] SIGTERM：运行时被 reapAll 一起收掉（无孤儿）' }
    else { Say "  [FAIL] SIGTERM：仍有残留 [$(RuntimePids)]" }
  } else {
    if (-not [string]::IsNullOrWhiteSpace((RuntimePids))) { Say "  [FINDING] SIGKILL：运行时变**孤儿**仍在跑 [$(RuntimePids)]（daemon 已死、无人回收、仍占 session/模型配额）" }
    else { Say '  [PASS] SIGKILL：无孤儿' }
  }
  Say "  --- 清理本次残留（自作用域：只回收本次 prompt 的运行时进程组 + 本次 daemon pid）---"
  # 不做 `pkill -f 'profile sd[k]'`：共享 WSL 宿主上会误伤别的 agent/会话正在跑的运行时。
  # 本次要收的 pid 是已知的：daemon 的 $($st.daemonPid) 与它那个运行时的 $rtPid（detached 进程组组长）。
  $kill = "$PATHX`n"
  if ($null -ne $rtPid -and $rtPid -gt 0) {
    $kill += "kill -TERM -- -$rtPid 2>/dev/null; kill -TERM $rtPid 2>/dev/null; sleep 1; kill -KILL -- -$rtPid 2>/dev/null; kill -KILL $rtPid 2>/dev/null`n"
  }
  $kill += "kill -KILL $([int]$st.daemonPid) 2>/dev/null`n"
  $kill += "true"
  Wsl $kill | Out-Null
  if (-not $d.Proc.HasExited) { try { Stop-Process -Id $d.Proc.Id -Force -ErrorAction SilentlyContinue } catch {} }
  Start-Sleep -Seconds 3
  Say "  清理后: runtime_pids=[$(RuntimePids)] daemon_pids=[$(DaemonPids)]"
  Say ''
}

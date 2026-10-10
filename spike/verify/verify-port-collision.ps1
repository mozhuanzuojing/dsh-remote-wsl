#!/usr/bin/env pwsh
# verify/verify-port-collision.ps1 —— 加码：README §7.3 提到"端口被占要有回退/发现机制"，
# 但只测了 WSL 侧自占（EADDRINUSE）。这里测**Windows 侧已占同一端口**的两种情况：
#   情况 1：Windows 先占 → 再起 WSL daemon
#   情况 2：WSL daemon 先起 → Windows 再占
# 判据：谁在 Windows 客户端眼里接客？daemon 会不会静默成功？
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
function TcpProbe([int]$p) {
  try { $c = [Net.Sockets.TcpClient]::new(); $c.Connect('127.0.0.1', $p); $ok = $c.Connected; $c.Close(); return "windows_tcp_connect=connected:$ok" }
  catch { return "windows_tcp_connect=REFUSED($($_.Exception.InnerException.Message))" }
}
function ClientStatus([int]$p) {
  $out = Join-Path $VerifyDir "collide-client-$p.txt"
  Start-Process -FilePath $NodeExe -ArgumentList @('"' + $ClientTs + '"', '--port', "$p", '--status', '--timeout-ms', '6000') -NoNewWindow -Wait -RedirectStandardOutput $out -RedirectStandardError (Join-Path $VerifyDir "collide-client-$p.err") | Out-Null
  return (Get-Content -LiteralPath $out -Raw).Trim()
}
function Start-Daemon([int]$p, [int]$idle, [string]$tag) {
  $sh = "export PATH=`"`$HOME/.local/bin:`$HOME/.local/share/mise/shims:`$PATH`"`nexec mise exec -- node $DaemonWsl --port $p --version $Version --cwd $Cwd --idle-ms $idle`n"
  $shWin = Join-Path $VerifyDir "collide-$tag-$p.sh"
  [IO.File]::WriteAllText($shWin, $sh.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
  $o = Join-Path $VerifyDir "collide-$tag-$p.out.log"; $e = Join-Path $VerifyDir "collide-$tag-$p.err.log"
  Remove-Item -LiteralPath $o, $e -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'g', '--', 'bash', (WslPath $shWin)) -RedirectStandardOutput $o -RedirectStandardError $e -PassThru -WindowStyle Hidden
  return [pscustomobject]@{ Proc = $proc; Out = $o; Err = $e }
}
function Ports() {
  Say ("  " + ((Wsl 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
echo "wsl_listen_8735=$(ss -ltn | grep -c ":8735 ")"
echo "wsl_listen_8736=$(ss -ltn | grep -c ":8736 ")"') -join '  '))
}

$P1 = 8735; $P2 = 8736
Say "################ 情况 1：Windows 先占 $P1，再起 WSL daemon ################"
$f1 = Join-Path $VerifyDir 'collide-job1.state'
Remove-Item -LiteralPath $f1 -ErrorAction SilentlyContinue
$job1 = Start-Job -ScriptBlock {
  param($p, $f)
  try {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('127.0.0.1'), $p)
    $l.Start()
    "WINDOWS_BOUND" | Set-Content -LiteralPath $f
    Start-Sleep -Seconds 40
    $l.Stop()
  } catch { "WINDOWS_BIND_FAILED: $($_.Exception.Message)" | Set-Content -LiteralPath $f }
} -ArgumentList $P1, $f1
for ($i = 0; $i -lt 20 -and -not (Test-Path $f1); $i++) { Start-Sleep -Milliseconds 500 }
Say "  Windows 侧监听结果: $(Get-Content -LiteralPath $f1 -Raw -ErrorAction SilentlyContinue)"
Say "  $(TcpProbe $P1)   （先证明 Windows 侧监听确实在接客）"
$d1 = Start-Daemon $P1 600000 'winfirst'
Start-Sleep -Seconds 5
$e1 = Get-Content -LiteralPath $d1.Err -Raw -ErrorAction SilentlyContinue
Say "  WSL daemon stdout = $((Get-Content -LiteralPath $d1.Out -Raw -ErrorAction SilentlyContinue))"
Say "  WSL daemon stderr = $($e1.Trim())"
Say "  daemon 进程 HasExited=$($d1.Proc.HasExited)"
Say "  WSL 侧监听: $((Wsl 'ss -ltn | grep -c ":8735 "').Trim())"
$stD1 = ClientStatus $P1
Say "  Windows 客户端 --status = $stD1"
$d1Pid = 0
try { $d1Pid = [int](($stD1.Trim() | ConvertFrom-Json).daemonPid) } catch { $d1Pid = 0 }
Say "  $(TcpProbe $P1)"
Say '  --- 结论观察：daemon 是否静默成功 / Windows 客户端是否连得上 ---'
$null = ClientStatus $P1
Stop-Job $job1 -ErrorAction SilentlyContinue; Remove-Job $job1 -Force -ErrorAction SilentlyContinue
if (-not $d1.Proc.HasExited) { try { Stop-Process -Id $d1.Proc.Id -Force -ErrorAction SilentlyContinue } catch {} }
# 自作用域回收：只 kill 刚才 status 里报出来的守护 pid（不做 pkill spike/daemon —— 别人可能有同名进程）
if ($d1Pid -gt 0) {
  Wsl "kill -TERM $d1Pid 2>/dev/null; sleep 1; kill -KILL $d1Pid 2>/dev/null; true" | Out-Null
} else {
  Say '  （情况 1 里 Windows 先占端口 ⇒ WSL daemon 没起来，没有自己的 pid 需要回收）'
}
Start-Sleep -Seconds 2

Say "`n################ 情况 2：WSL daemon 先占 $P2，Windows 再占同一端口 ################"
$d2 = Start-Daemon $P2 600000 'wslfirst'
Start-Sleep -Seconds 4
Say "  daemon stderr = $((Get-Content -LiteralPath $d2.Err -Raw -ErrorAction SilentlyContinue).Trim())"
$stD2 = ClientStatus $P2
Say "  daemon 就绪（客户端视角）= $stD2"
$d2Pid = 0
try { $d2Pid = [int](($stD2.Trim() | ConvertFrom-Json).daemonPid) } catch { $d2Pid = 0 }
$f2 = Join-Path $VerifyDir 'collide-job2.state'
Remove-Item -LiteralPath $f2 -ErrorAction SilentlyContinue
$job2 = Start-Job -ScriptBlock {
  param($p, $f)
  try {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('127.0.0.1'), $p)
    $l.Start()
    "WINDOWS_BOUND" | Set-Content -LiteralPath $f
    Start-Sleep -Seconds 40
    $l.Stop()
  } catch { "WINDOWS_BIND_FAILED: $($_.Exception.Message)" | Set-Content -LiteralPath $f }
} -ArgumentList $P2, $f2
for ($i = 0; $i -lt 20 -and -not (Test-Path $f2); $i++) { Start-Sleep -Milliseconds 500 }
Say "  Windows 侧在 WSL 已监听 $P2 时的绑定结果: $(Get-Content -LiteralPath $f2 -Raw -ErrorAction SilentlyContinue)"
Say "  Windows 客户端 --status = $(ClientStatus $P2)"
Say "  $(TcpProbe $P2)"
Stop-Job $job2 -ErrorAction SilentlyContinue; Remove-Job $job2 -Force -ErrorAction SilentlyContinue
$null = ClientStatus $P2
if (-not $d2.Proc.HasExited) { try { Stop-Process -Id $d2.Proc.Id -Force -ErrorAction SilentlyContinue } catch {} }
# 自作用域回收：只 kill 自己这次起的守护 pid
if ($d2Pid -gt 0) { Wsl "kill -TERM $d2Pid 2>/dev/null; sleep 1; kill -KILL $d2Pid 2>/dev/null; true" | Out-Null }
Start-Sleep -Seconds 2
Say "`n################ 收尾 ################"
$tail = Wsl @'
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
echo "profile_sdk_procs=$(pgrep -f -- 'profile sd[k]' | wc -l)"
echo "daemon_procs=$(pgrep -f -- 'spike/daemon.t[s]' | wc -l)"
echo "listen_8735=$(ss -ltn | grep -c ':8735 ')"
echo "listen_8736=$(ss -ltn | grep -c ':8736 ')"
echo "tmp_dsh=$(find /tmp -maxdepth 1 -name 'dsh-rwsl-*' | wc -l)"
'@
$tail | ForEach-Object { Say "  $_" }

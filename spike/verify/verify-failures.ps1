#!/usr/bin/env pwsh
# verify/verify-failures.ps1 —— 独立验证 #4：三种失败模式
#   ① 守护未起时 client 输出什么（要可读）
#   ② 端口被占时 daemon 输出什么（WSL 侧占 / Windows 侧占 两种）
#   ③ 两个 client 同时对**同一** key 发 prompt 的行为
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
$script:Fails = @()
function Say($m) { Write-Host $m }
function Check([bool]$c, [string]$m) { if ($c) { Say "  [PASS] $m" } else { Say "  [FAIL] $m"; $script:Fails += $m } }
function Wsl([string]$b) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($b))
  $o = & wsl.exe -d $Distro -u g -- bash -c "echo $b64 | base64 -d | bash" 2>&1
  return @($o | ForEach-Object { "$_" })
}
function WslPath([string]$p) {
  $full = (Resolve-Path -LiteralPath $p).Path
  $d = $full.Substring(0, 1).ToLower(); $r = $full.Substring(2).Replace('\', '/')
  return "/mnt/$d$r"
}
$DaemonWsl = WslPath $DaemonTs
function Client([string[]]$ca, [switch]$NoWait) {
  $quoted = foreach ($a in $ca) { if ($a -match '[\s"]') { '"' + $a.Replace('"', '\"') + '"' } else { $a } }
  $cmd = '"' + $ClientTs + '" ' + ($quoted -join ' ')
  $tag = [guid]::NewGuid().ToString('N').Substring(0, 6)
  $out = Join-Path $VerifyDir "failout-$tag.txt"; $err = Join-Path $VerifyDir "failerr-$tag.txt"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $NodeExe -ArgumentList $cmd -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  if ($NoWait) { return [pscustomobject]@{ Proc = $p; Out = $out; Err = $err; Sw = $sw; Tag = $tag } }
  $p.WaitForExit(); $sw.Stop()
  return [pscustomobject]@{ Pid = $p.Id; Exit = $p.ExitCode; Ms = $sw.ElapsedMilliseconds
    Raw = ((Get-Content -LiteralPath $out -Raw) -as [string]); Err = ((Get-Content -LiteralPath $err -Raw) -as [string]) }
}
function Join-Client($h) {
  $h.Proc.WaitForExit(); $h.Sw.Stop()
  return [pscustomobject]@{ Pid = $h.Proc.Id; Exit = $h.Proc.ExitCode; Ms = $h.Sw.ElapsedMilliseconds
    Raw = ((Get-Content -LiteralPath $h.Out -Raw) -as [string]); Err = ((Get-Content -LiteralPath $h.Err -Raw) -as [string]) }
}
function Start-Daemon([int]$p, [int]$idle, [string]$tag) {
  $sh = "export PATH=`"`$HOME/.local/bin:`$HOME/.local/share/mise/shims:`$PATH`"`nexec mise exec -- node $DaemonWsl --port $p --version $Version --cwd $Cwd --idle-ms $idle`n"
  $shWin = Join-Path $VerifyDir "faillaunch-$tag-$p.sh"
  [IO.File]::WriteAllText($shWin, $sh.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
  $outL = Join-Path $VerifyDir "faildaemon-$tag-$p.out.log"; $errL = Join-Path $VerifyDir "faildaemon-$tag-$p.err.log"
  Remove-Item -LiteralPath $outL, $errL -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'g', '--', 'bash', (WslPath $shWin)) `
    -RedirectStandardOutput $outL -RedirectStandardError $errL -PassThru -WindowStyle Hidden
  return [pscustomobject]@{ Proc = $proc; Out = $outL; Err = $errL }
}
function Wait-Ready([int]$p, $d, [int]$tries = 60) {
  for ($i = 1; $i -le $tries; $i++) {
    Start-Sleep -Milliseconds 750
    $r = Client @('--port', "$p", '--status')
    if ($r.Exit -eq 0) { return @{ Ok = $true; Tries = $i; Raw = $r.Raw } }
    if ($d.Proc.HasExited) { return @{ Ok = $false; Tries = $i; Raw = $r.Raw; Exited = $true } }
  }
  return @{ Ok = $false; Tries = $tries }
}

Say "################ ① 守护未起时 client 的输出 ################"
$r1 = Client @('--port', '8739', '--key', 'k1', '--text', 'hi', '--timeout-ms', '8000')
Say "  cmd = node client.ts --port 8739 --key k1 --text hi"
Say "  exit=$($r1.Exit) elapsed_ms=$($r1.Ms)"
Say "  stdout(raw) = $($r1.Raw.Trim())"
Say "  stderr      = $($r1.Err.Trim())"
Check ($r1.Exit -eq 2) "退出码 2（传输层失败）"
Check ($r1.Raw -match 'transport') "stdout 是可读的 transport 错误 JSON"
Check ($r1.Raw -match 'ECONNREFUSED') "含 ECONNREFUSED（不是崩溃/空输出）"

Say "`n################ ②a 端口被占（WSL 侧）：第二个 daemon 的输出 ################"
$dA = Start-Daemon 8732 600000 'occupy'
$rdA = Wait-Ready 8732 $dA
Say "  第一个 daemon 就绪=$($rdA.Ok) tries=$($rdA.Tries)"
Check ($rdA.Ok) "占位 daemon 已就绪"
$dB = Start-Daemon 8732 600000 'second'
Start-Sleep -Seconds 4
if (-not $dB.Proc.HasExited) { Start-Sleep -Seconds 4 }
Say "  第二个 daemon wsl.exe HasExited=$($dB.Proc.HasExited) exit=$($dB.Proc.ExitCode)"
Say "  第二个 daemon stdout = $((Get-Content -LiteralPath $dB.Out -Raw))"
Say "  第二个 daemon stderr:"; Get-Content -LiteralPath $dB.Err -ErrorAction SilentlyContinue | ForEach-Object { Say "    $_" }
$errB = (Get-Content -LiteralPath $dB.Err -Raw -ErrorAction SilentlyContinue)
Check ($errB -match 'FATAL listen error') "第二个 daemon 打印 FATAL listen error"
Check ($errB -match 'EADDRINUSE') "第二个 daemon 打印 EADDRINUSE"
Check ($dB.Proc.HasExited) "第二个 daemon 进程已退出（非静默驻留）"
Say "  --- 关掉占位 daemon ---"
$null = Client @('--port', '8732', '--shutdown')
Start-Sleep -Seconds 3

Say "`n################ ②b 端口被占（Windows 侧 127.0.0.1:8733）################"
$job = Start-Job -ScriptBlock {
  $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('127.0.0.1'), 8733)
  $l.Start()
  Start-Sleep -Seconds 90
  $l.Stop()
}
Start-Sleep -Seconds 3
$state = (Get-Job -Id $job.Id).State
Say "  Windows 侧 8733 监听 job state=$state"
$dW = Start-Daemon 8733 600000 'winoccupy'
$rdW = Wait-Ready 8733 $dW 12
$dWPid = 0
if ($rdW.Ok) { try { $dWPid = [int](($rdW.Raw.Trim() | ConvertFrom-Json).daemonPid) } catch { $dWPid = 0 } }
Say "  WSL daemon 在 Windows 已占用 8733 时: ready=$($rdW.Ok) tries=$($rdW.Tries) daemonExited=$($dW.Proc.HasExited)"
Say "  daemon stderr:"; Get-Content -LiteralPath $dW.Err -ErrorAction SilentlyContinue | ForEach-Object { Say "    $_" }
$rWin = Client @('--port', '8733', '--status', '--timeout-ms', '6000')
Say "  Windows client --status exit=$($rWin.Exit) raw=$($rWin.Raw.Trim())"
Say "  （观察项：若两侧都监听成功，则 Windows 客户端会命中 Windows 侧监听者而非 WSL 守护）"
$null = Client @('--port', '8733', '--shutdown', '--timeout-ms', '3000')
Stop-Job -Id $job.Id -ErrorAction SilentlyContinue; Remove-Job -Id $job.Id -Force -ErrorAction SilentlyContinue
if (-not $dW.Proc.HasExited) { try { Stop-Process -Id $dW.Proc.Id -Force -ErrorAction SilentlyContinue } catch {} }
# 自作用域回收：只 kill 自己这次起的守护 pid（不做 pkill spike/daemon —— 别人可能有同名进程）
if ($dWPid -gt 0) { Wsl "kill -TERM $dWPid 2>/dev/null; sleep 1; kill -KILL $dWPid 2>/dev/null; true" | Out-Null }
Start-Sleep -Seconds 2

Say "`n################ ③ 两个 client 同时对**同一** key 发 prompt ################"
$dC = Start-Daemon 8734 600000 'concurrent'
$rdC = Wait-Ready 8734 $dC
Say "  daemon 就绪=$($rdC.Ok) tries=$($rdC.Tries)"
Check ($rdC.Ok) "并发场景 daemon 已就绪"
$h1 = Client @('--host', '127.0.0.1', '--port', '8734', '--key', 'k1', '--text', '只回复 AAA') -NoWait
$h2 = Client @('--host', '127.0.0.1', '--port', '8734', '--key', 'k1', '--text', '只回复 BBB') -NoWait
Say "  两个 client 进程: pid1=$($h1.Proc.Id) pid2=$($h2.Proc.Id)（都未 Wait，几乎同时发出）"
$c1 = Join-Client $h1
$c2 = Join-Client $h2
Say "  client1 pid=$($c1.Pid) exit=$($c1.Exit) elapsed_ms=$($c1.Ms) raw=$($c1.Raw.Trim())"
Say "  client2 pid=$($c2.Pid) exit=$($c2.Exit) elapsed_ms=$($c2.Ms) raw=$($c2.Raw.Trim())"
$st = Client @('--port', '8734', '--status')
Say "  status = $($st.Raw.Trim())"
$js = $st.Raw.Trim() | ConvertFrom-Json
$k = $js.keys | Where-Object { $_.key -eq 'k1' }
Say "  daemon 日志（recv / 完成顺序）:"; Get-Content -LiteralPath $dC.Err | Select-Object -Last 12 | ForEach-Object { Say "    $_" }
Check ($c1.Exit -eq 0 -and $c2.Exit -eq 0) "两个并发 client 都拿到 ok:true（没有互相踩坏）"
Check ($k.turns -eq 2) "status 显示 turns=2（守护内串行两轮）"
$serialHint = ($c2.Ms -gt $c1.Ms) -or ($c1.Ms -gt $c2.Ms)
Say "  观察：elapsed1=$($c1.Ms)ms elapsed2=$($c2.Ms)ms（串行 ⇒ 第二个的耗时约等于两轮之和）"
$null = Client @('--port', '8734', '--shutdown')
Start-Sleep -Seconds 3
if (-not $dC.Proc.HasExited) { try { Stop-Process -Id $dC.Proc.Id -Force -ErrorAction SilentlyContinue } catch {} }

Say "`n################ 收尾 ################"
$tail = Wsl 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
echo "profile_sdk_procs=$(pgrep -f -- ''profile sd[k]'' | wc -l)"
echo "daemon_procs=$(pgrep -f -- ''spike/daemon.t[s]'' | wc -l)"
echo "tmp_dsh=$(find /tmp -maxdepth 1 -name ''dsh-rwsl-*'' | wc -l)"
for p in 8731 8732 8733 8734 8739; do echo "port_${p}=$(ss -ltn | awk -v P=":$p" ''$4 ~ P$ {n++} END {print n+0}'')"; done'
$tail | ForEach-Object { Say "  $_" }
Say ''
if ($script:Fails.Count -eq 0) { Say 'VERIFY-FAILURES: ALL CHECKS PASSED'; exit 0 }
Say "VERIFY-FAILURES: $($script:Fails.Count) CHECK(S) FAILED"
$script:Fails | ForEach-Object { Say " - $_" }
exit 1

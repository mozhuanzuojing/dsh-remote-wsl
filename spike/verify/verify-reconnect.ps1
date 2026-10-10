#!/usr/bin/env pwsh
# verify/verify-reconnect.ps1 —— 独立验证 #1/#2/#6：
#   起自己的守护 → client A（独立进程，第 1 轮记住数字 7）→ A 退出 →
#   client B（另一个独立进程，追问）→ 必须回 7；期间 runtimePid/sessionId/PID 集合不得变。
#
# 只读场景：只执行 spike/ 下已有脚本；写入只落在 spike/verify/（日志/启动脚本）。
[CmdletBinding()]
param(
  [int]$Port = 8731,
  [string]$Distro = 'debian-u8-1',
  [string]$Version = '0.2.0-rc.2',
  [string]$Cwd = '/home/g',
  [int]$IdleMs = 1800000,
  [string]$NodeExe = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
)
$ErrorActionPreference = 'Stop'
$VerifyDir = $PSScriptRoot
$SpikeDir = Split-Path $VerifyDir -Parent
$ClientTs = Join-Path $SpikeDir 'client.ts'
$DaemonTs = Join-Path $SpikeDir 'daemon.ts'
$script:Fails = @()

function Say($m) { Write-Host $m }
function Check([bool]$c, [string]$m) {
  if ($c) { Say "  [PASS] $m" } else { Say "  [FAIL] $m"; $script:Fails += $m }
}
function Wsl([string]$b) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($b))
  $o = & wsl.exe -d $Distro -u g -- bash -c "echo $b64 | base64 -d | bash" 2>&1
  return @($o | ForEach-Object { "$_" })
}
function WslPath([string]$p) {
  $full = (Resolve-Path -LiteralPath $p).Path
  $d = $full.Substring(0, 1).ToLower()
  $r = $full.Substring(2).Replace('\', '/')
  return "/mnt/$d$r"
}
$DaemonWsl = WslPath $DaemonTs

# 清点模板：自避正则 'profile sd[k]'（避免匹配检查命令自身）；glob 用 find，不用 shell glob
$countsTpl = @'
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
echo "profile_sdk_procs=$(pgrep -f -- 'profile sd[k]' | wc -l)"
echo "profile_sdk_pids=$(pgrep -f -- 'profile sd[k]' | sort -n | tr '\n' ',')"
echo "tmp_dsh=$(find /tmp -maxdepth 1 -name 'dsh-rwsl-*' | wc -l)"
echo "port_listen=$(ss -ltn | awk '$4 ~ /:__PORT__$/ {n++} END {print n+0}')"
'@
function Get-Counts([int]$p) {
  $h = @{}
  foreach ($l in (Wsl ($countsTpl.Replace('__PORT__', [string]$p)))) {
    if ($l -match '^([A-Za-z_]+)=(.*)$') { $h[$Matches[1]] = "$($Matches[2])" }
  }
  return $h
}
function Show-Counts($h) {
  Say ("  " + (($h.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join '  '))
}

# 客户端：Start-Process 不给参数加引号 ⇒ 自己拼一条**已加引号**的命令行（坑②的正解）
function Invoke-ClientPid([string[]]$ca, [switch]$NoWait) {
  $quoted = foreach ($a in $ca) { if ($a -match '[\s"]') { '"' + $a.Replace('"', '\"') + '"' } else { $a } }
  $cmd = '"' + $ClientTs + '" ' + ($quoted -join ' ')
  $tag = [guid]::NewGuid().ToString('N').Substring(0, 6)
  $out = Join-Path $VerifyDir "clientout-$tag.txt"
  $err = Join-Path $VerifyDir "clienterr-$tag.txt"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $NodeExe -ArgumentList $cmd -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  if ($NoWait) { return [pscustomobject]@{ Proc = $p; Out = $out; Err = $err; Sw = $sw; Cmd = $cmd } }
  $p.WaitForExit()
  $sw.Stop()
  return [pscustomobject]@{
    Pid = $p.Id; Exit = $p.ExitCode; Exited = $p.HasExited; Ms = $sw.ElapsedMilliseconds; Cmd = $cmd
    Raw = ((Get-Content -LiteralPath $out -Raw) -as [string]); Err = ((Get-Content -LiteralPath $err -Raw) -as [string])
  }
}
function Finish-Client($h) {
  $h.Proc.WaitForExit(); $h.Sw.Stop()
  return [pscustomobject]@{
    Pid = $h.Proc.Id; Exit = $h.Proc.ExitCode; Exited = $h.Proc.HasExited; Ms = $h.Sw.ElapsedMilliseconds; Cmd = $h.Cmd
    Raw = ((Get-Content -LiteralPath $h.Out -Raw) -as [string]); Err = ((Get-Content -LiteralPath $h.Err -Raw) -as [string])
  }
}
function Start-Daemon([int]$p, [int]$idle, [string]$tag) {
  $sh = "export PATH=`"`$HOME/.local/bin:`$HOME/.local/share/mise/shims:`$PATH`"`nexec mise exec -- node $DaemonWsl --port $p --version $Version --cwd $Cwd --idle-ms $idle`n"
  $shWin = Join-Path $VerifyDir "launch-$tag-$p.sh"
  [IO.File]::WriteAllText($shWin, $sh.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
  $outL = Join-Path $VerifyDir "daemon-$tag-$p.out.log"
  $errL = Join-Path $VerifyDir "daemon-$tag-$p.err.log"
  Remove-Item -LiteralPath $outL, $errL -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath 'wsl.exe' `
    -ArgumentList @('-d', $Distro, '-u', 'g', '--', 'bash', (WslPath $shWin)) `
    -RedirectStandardOutput $outL -RedirectStandardError $errL -PassThru -WindowStyle Hidden
  return [pscustomobject]@{ Proc = $proc; Out = $outL; Err = $errL }
}
function Wait-Ready([int]$p, $d) {
  for ($i = 1; $i -le 80; $i++) {
    Start-Sleep -Milliseconds 750
    $r = Invoke-ClientPid @('--port', "$p", '--status')
    if ($r.Exit -eq 0) { return @{ Status = ($r.Raw.Trim() | ConvertFrom-Json); Tries = $i } }
    if ($d.Proc.HasExited) { return @{ Status = $null; Tries = $i; LastRaw = $r.Raw; LastExit = $r.Exit } }
  }
  return @{ Status = $null; Tries = 80; LastRaw = '(timeout)' }
}

Say "################ STEP 0: 前置清点 ################"
$before = Get-Counts $Port
Show-Counts $before
Check ($before['profile_sdk_procs'] -eq '0') "起始 profile_sdk_procs=0"
Check ($before['port_listen'] -eq '0') "起始 $Port 无监听"

Say "`n################ STEP 1: 起守护（我自己的启动脚本）################"
$d1 = Start-Daemon $Port $IdleMs 'main'
$ready = Wait-Ready $Port $d1
$st = $ready.Status
if (Test-Path -LiteralPath $d1.Out) { Say "  daemon stdout: $((Get-Content -LiteralPath $d1.Out -Raw))" }
Check ($null -ne $st -and $st.ok -eq $true) "守护就绪（tries=$($ready.Tries)）"
if ($null -eq $st) { Say "  last client raw=$($ready.LastRaw)"; Get-Content -LiteralPath $d1.Err -Tail 20 | ForEach-Object { Say "  $($_)" }; throw 'daemon not ready' }
$daemonPid = $st.daemonPid
Say "  daemonPid=$daemonPid version=$($st.version) port=$($st.port) idleMs=$($st.idleMs) keys=$($st.keys.Count)"
$c0 = Get-Counts $Port
Show-Counts $c0
Check ($c0['profile_sdk_procs'] -eq '0') "守护刚起、未 prompt 时还没有运行时进程（起点干净）"

Say "`n################ STEP 2: client A（独立进程）第 1 轮 ################"
$rA = Invoke-ClientPid @('--host', '127.0.0.1', '--port', "$Port", '--key', 'k1', '--text', '记住数字 7，只回 ACK')
Say "  cmd = $($rA.Cmd)"
Say "  clientA windows_pid=$($rA.Pid) exit=$($rA.Exit) HasExited=$($rA.Exited) elapsed_ms=$($rA.Ms)"
Say "  clientA stdout(raw) = $($rA.Raw.Trim())"
Say "  clientA stderr = $($rA.Err.Trim())"
$jA = $rA.Raw.Trim() | ConvertFrom-Json
Check ($rA.Exit -eq 0 -and $jA.ok -eq $true) "A round1 ok:true"
Check ($jA.answer -match 'ACK') "A round1 answer 含 ACK（实际 '$($jA.answer)'）"
$s1 = $jA.sessionId; $p1 = $jA.runtimePid
Say "  sessionId=$s1 runtimePid=$p1 turns=$($jA.turns) completedBy=$($jA.completedBy) events=$($jA.eventCount)"
Check ($rA.Exited -eq $true) "client A 进程已退出（HasExited=true）"

Say "`n################ STEP 3: A 退出后观察（负向对照：探针必须能看到活的运行时）################"
$c1 = Get-Counts $Port
Show-Counts $c1
Check ([int]$c1['profile_sdk_procs'] -ge 1) "A 退出后守护持有的运行时仍在（procs=$($c1['profile_sdk_procs'])）"
$st1 = Invoke-ClientPid @('--port', "$Port", '--status')
$j1 = $st1.Raw.Trim() | ConvertFrom-Json
$k1a = $j1.keys | Where-Object { $_.key -eq 'k1' }
Say "  status#1 raw = $($st1.Raw.Trim())"
Check ($null -ne $k1a) "status#1 里 key=k1 仍在（客户端退出没带走运行时）"
Check ($k1a.sessionId -eq $s1) "status#1 sessionId 与 A 一致"
Check ($k1a.runtimePid -eq $p1) "status#1 runtimePid 与 A 一致"

Say "`n################ STEP 4: client B（**另一个**独立进程）追问 ################"
$rB = Invoke-ClientPid @('--host', '127.0.0.1', '--port', "$Port", '--key', 'k1', '--text', '刚才让你记的数字？只回数字')
Say "  clientB windows_pid=$($rB.Pid) exit=$($rB.Exit) HasExited=$($rB.Exited) elapsed_ms=$($rB.Ms)"
Say "  clientB stdout(raw) = $($rB.Raw.Trim())"
$jB = $rB.Raw.Trim() | ConvertFrom-Json
Check ($rB.Pid -ne $rA.Pid) "client B 与 client A 是不同进程（PID $($rA.Pid) vs $($rB.Pid)）"
Check ($jB.ok -eq $true) "B round2 ok:true"
Check ($jB.answer.Trim() -eq '7') "B round2 answer 恰为 7（跨进程上下文保留）；实际 '$($jB.answer)'"
Check ($jB.sessionId -eq $s1) "B sessionId 与 A 一致"
Check ($jB.runtimePid -eq $p1) "B runtimePid 与 A 一致（没有偷偷重启运行时）"
Check ($jB.turns -eq 2) "B turns=2"

Say "`n################ STEP 5: 跨 client 期间进程集合必须不变 ################"
$c2 = Get-Counts $Port
Show-Counts $c2
Say "  before(A 后) pids = [$($c1['profile_sdk_pids'])]"
Say "  after (B 后) pids = [$($c2['profile_sdk_pids'])]"
Check ($c2['profile_sdk_pids'] -eq $c1['profile_sdk_pids']) "运行时进程 PID 集合未变（无新运行时、无重启）"
$st2 = Invoke-ClientPid @('--port', "$Port", '--status')
$j2 = $st2.Raw.Trim() | ConvertFrom-Json
$k1b = $j2.keys | Where-Object { $_.key -eq 'k1' }
Say "  status#2 raw = $($st2.Raw.Trim())"
Check ($k1b.sessionId -eq $s1) "status#2 sessionId 未变"
Check ($k1b.runtimePid -eq $p1) "status#2 runtimePid 未变"
Check ($j2.daemonPid -eq $daemonPid) "status#2 daemonPid 未变（$daemonPid）"

Say "`n################ STEP 6: 守护日志证据（client disconnected 但运行时保留）################"
if (Test-Path -LiteralPath $d1.Err) { Get-Content -LiteralPath $d1.Err | Select-Object -Last 12 | ForEach-Object { Say "  $_" } }

Say "`n################ STEP 7: --shutdown + 收尾核对 ################"
$rs = Invoke-ClientPid @('--port', "$Port", '--shutdown')
Say "  shutdown raw = $($rs.Raw.Trim())"
Start-Sleep -Seconds 3
$c3 = Get-Counts $Port
Show-Counts $c3
$rd = Invoke-ClientPid @('--port', "$Port", '--status')
Say "  post-shutdown --status exit=$($rd.Exit) raw=$($rd.Raw.Trim())"
Check ($rd.Exit -eq 2) "守护已退出：--status 传输层失败 exit=2"
Check ($c3['profile_sdk_procs'] -eq '0') "收尾 profile_sdk_procs=0"
Check ($c3['tmp_dsh'] -eq '0') "收尾 /tmp/dsh-rwsl-* = 0"
Check ($c3['port_listen'] -eq '0') "收尾 $Port 无监听"
if (-not $d1.Proc.HasExited) { try { Stop-Process -Id $d1.Proc.Id -Force -ErrorAction SilentlyContinue } catch {} }

Say ''
Say '################ VERDICT ################'
Say "  files: A_pid=$($rA.Pid) B_pid=$($rB.Pid) sessionId=$s1 runtimePid=$p1 daemonPid=$daemonPid"
if ($script:Fails.Count -eq 0) { Say '  VERIFY-RECONNECT: ALL CHECKS PASSED'; exit 0 }
Say "  VERIFY-RECONNECT: $($script:Fails.Count) CHECK(S) FAILED"
$script:Fails | ForEach-Object { Say "   - $_" }
exit 1

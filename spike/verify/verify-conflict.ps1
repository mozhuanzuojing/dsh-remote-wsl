#!/usr/bin/env pwsh
# verify/verify-conflict.ps1 —— 独立反证（#3）：不用守护，两个**互相独立的 OS 进程**
# 各自持有一份 dsh --profile sdk，复用同一 sessionId。
#   alive 模式：A 先建会话并持有运行时，B（另一个进程）用同一 id 发 prompt
#   stale 模式：A 先正常 shutdown、确认运行时进程已消失，B（另一个进程）再用同一 id
# 两者都要看 `-32603 session "..." already exists` 原文。
[CmdletBinding()]
param(
  [string]$Distro = 'debian-u8-1',
  [string]$Version = '0.2.0-rc.2',
  [string]$Cwd = '/home/g',
  [int]$HoldMs = 180000,
  [string]$NodeExe = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
)
$ErrorActionPreference = 'Stop'
$VerifyDir = $PSScriptRoot
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
$VerifyWsl = WslPath $VerifyDir
# ⚠ 必须写成**单行**（用 `;` 串联）而不是多行：实测经 pwsh→wsl.exe→bash 的多行内联脚本
# **每一行都各自在全新 shell 里执行**（`export PATH` / `cd` 都不会带到下一行），
# 多行版本会让后面的 `mise exec -- node …` 找不到 mise、还跑在错误的 cwd。
$Pre = "export PATH=`"`$HOME/.local/bin:`$HOME/.local/share/mise/shims:`$PATH`"; cd $VerifyWsl; "
$counts = @'
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
echo "profile_sdk_procs=$(pgrep -f -- 'profile sd[k]' | wc -l)"
echo "one_runtime_procs=$(pgrep -f -- 'one-runtime.t[s]' | wc -l)"
echo "port_listen=$(ss -ltn | awk '$4 ~ /:8731$/ {n++} END {print n+0}')"
'@
function Show-Counts { Say ("  " + ((Wsl $counts) -join '  ')) }

Say "################ 前置清点 ################"
Show-Counts
Say "  node(win) = $NodeExe"

# ── A. alive 模式：两个独立进程 ────────────────────────────────────────────────
Say "`n################ A. alive：A 持有运行时，B 用同一 sessionId ################"
$sidA = "verify-alive-$([guid]::NewGuid().ToString('N').Substring(0,12))"
$shA = $Pre + "exec mise exec -- node one-runtime.ts --session-id $sidA --text 'Reply only ACK.' --hold-ms $HoldMs`n"
$shWinA = Join-Path $VerifyDir 'conflict-alive-A.sh'
[IO.File]::WriteAllText($shWinA, $shA.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
$outA = Join-Path $VerifyDir 'conflict-alive-A.out.log'
$errA = Join-Path $VerifyDir 'conflict-alive-A.err.log'
Remove-Item -LiteralPath $outA, $errA -ErrorAction SilentlyContinue
Say "  sessionId = $sidA"
Say "  起进程 A: wsl.exe ... -- bash $(WslPath $shWinA)  (A 是独立 OS 进程，持有运行时 $HoldMs ms)"
$pA = Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '-u', 'g', '--', 'bash', (WslPath $shWinA)) `
  -RedirectStandardOutput $outA -RedirectStandardError $errA -PassThru -WindowStyle Hidden
$pidA = $null; $rtA = $null
for ($i = 1; $i -le 200; $i++) {
  Start-Sleep -Milliseconds 750
  if (Test-Path -LiteralPath $outA) {
    $txt = Get-Content -LiteralPath $outA -Raw
    if ($txt -match '"stage":"prompt"') {
      $line = ($txt -split "`n" | Where-Object { $_ -match '"stage":"prompt"' } | Select-Object -First 1)
      $j = $line | ConvertFrom-Json
      $pidA = $j.pid; $rtA = $j.runtimePid
      Say "  A prompt 完成: pid=$pidA runtimePid=$rtA ok=$($j.ok) turns=$($j.turns) text='$($j.text)'"
      break
    }
  }
  if ($pA.HasExited) { Say "  A 提前退出（exit=$($pA.ExitCode)）"; break }
}
Check ($null -ne $rtA) "进程 A 已建立会话并持有运行时（runtimePid=$rtA）"
if ($null -ne $rtA) {
  $alive = (Wsl "ps -p $rtA -o pid=,args= 2>/dev/null | head -2").Trim()
  Say "  A 运行时进程此刻: $alive"
  Check ($alive -match "$rtA") "A 的运行时 $rtA 此刻确实活着"
}
Say "  --- B（另一个独立 OS 进程）用同一 sessionId 发 prompt ---"
$tB = [Diagnostics.Stopwatch]::StartNew()
$outB = Wsl ($Pre + "mise exec -- node one-runtime.ts --session-id $sidA --text '刚才让你记的数字？只回数字' --version $Version --cwd $Cwd")
$tB.Stop()
foreach ($l in $outB) { Say "  [B] $l" }
$txtB = $outB -join "`n"
Check ($txtB -match '-32603') "alive：B 收到 JSON-RPC -32603"
Check ($txtB -match 'already exists') "alive：B 收到 'already exists'"
Check ($txtB -match '"stage":"start","ok":true') "alive：B 的 initialize 成功（冲突点在 session，不在连接）"
Check ($txtB -match '"stage":"prompt","ok":false') "alive：B 的 prompt 被拒（ok:false）"
Say "  B 耗时 $($tB.ElapsedMilliseconds) ms"

# 清理 A 及其运行时（A 是 wsl.exe 包装层，必须从 WSL 侧收）
# **自作用域**：只 kill 我们从 A 的 stdout 里读到的 pid（A 的 node 进程 pidA、A 持有的运行时 rtA），
# 不做 `pkill -f 'profile sd[k]'` —— 共享 WSL 宿主上那会误伤别的 agent/会话正在跑的运行时。
# rtA 是 detached 进程组组长（sdk-runtime.ts 用 detached:true spawn）⇒ `kill -- -rtA` 连带 pnpm/node 全树。
Say "  --- 清理 alive 场景（自作用域：只按 A 自己的 pid 精确回收）---"
$own = @()
if ($null -ne $pidA) { $own += [int]$pidA }
if ($null -ne $rtA) { $own += [int]$rtA }
if ($own.Count -gt 0) {
  $kill = "export PATH=`"`$HOME/.local/bin:`$HOME/.local/share/mise/shims:`$PATH`"`n"
  foreach ($k in $own) { $kill += "kill -TERM -- -$k 2>/dev/null; kill -TERM $k 2>/dev/null`n" }
  $kill += "sleep 1`n"
  foreach ($k in $own) { $kill += "kill -KILL -- -$k 2>/dev/null; kill -KILL $k 2>/dev/null`n" }
  $kill += "true"
  Wsl $kill | Out-Null
  Say "  已精确回收 pid=[$($own -join ',')]（A 的 node 进程 + 其运行时进程组）"
}
if (-not $pA.HasExited) { try { Stop-Process -Id $pA.Id -Force -ErrorAction SilentlyContinue } catch {} }
Start-Sleep -Seconds 3
Show-Counts

# ── B. stale 模式：A 正常退出后运行时已消失，B 复用同一 id ──────────────────────
Say "`n################ B. stale：旧运行时已消失后仍被拒？ ################"
$sidB = "verify-stale-$([guid]::NewGuid().ToString('N').Substring(0,12))"
Say "  sessionId = $sidB"
Say "  --- 进程 A（独立进程）建会话后正常 shutdown ---"
$outA2 = Wsl ($Pre + "mise exec -- node one-runtime.ts --session-id $sidB --text 'Reply only ACK.' --version $Version --cwd $Cwd")
foreach ($l in $outA2) { Say "  [A] $l" }
$jA2 = ($outA2 | Where-Object { $_ -match '"stage":"prompt"' } | Select-Object -First 1) | ConvertFrom-Json
$rtA2 = $jA2.runtimePid
Check ($null -ne $rtA2) "stale：A 建立了会话（runtimePid=$rtA2）"
$gone = (Wsl "ps -p $rtA2 -o pid= 2>/dev/null | wc -l").Trim()
Say "  A 的运行时进程 $rtA2 现存行数 = $gone"
Check ($gone -eq '0') "stale：A 的运行时 $rtA2 已消失（close 生效）"
$pidsNow = ((Wsl "export PATH=`"`$HOME/.local/bin:`$HOME/.local/share/mise/shims:`$PATH`"; pgrep -f -- 'profile sd[k]' | tr '\n' ','") -join '').Trim()
Say "  当前 profile_sdk pids = [$pidsNow]"
Check ([string]::IsNullOrWhiteSpace($pidsNow)) "stale：此刻没有任何 --profile sdk 运行时在跑（旧运行时确实没了）"
Say "  --- 进程 B（另一个独立进程）用**同一** sessionId 发 prompt ---"
$outB2 = Wsl ($Pre + "mise exec -- node one-runtime.ts --session-id $sidB --text '刚才让你记的数字？只回数字' --version $Version --cwd $Cwd")
foreach ($l in $outB2) { Say "  [B] $l" }
$txtB2 = $outB2 -join "`n"
Check ($txtB2 -match '-32603') "stale：B 仍收到 -32603"
Check ($txtB2 -match 'already exists') "stale：B 仍收到 'already exists'"
Check ($txtB2 -match '"stage":"prompt","ok":false') "stale：B 的 prompt 被拒（ok:false）"
Say "`n################ 收尾 ################"
Show-Counts
Say ''
if ($script:Fails.Count -eq 0) { Say 'VERIFY-CONFLICT: ALL CHECKS PASSED'; exit 0 }
Say "VERIFY-CONFLICT: $($script:Fails.Count) CHECK(S) FAILED"
$script:Fails | ForEach-Object { Say " - $_" }
exit 1

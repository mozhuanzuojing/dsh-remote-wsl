#!/usr/bin/env pwsh
# verify-f37.ps1 —— F-37 修复的死磕验证：每轮"动作前后各枚举一次窗口"，证明 ∆可见窗口 = 0。
# 每轮还要证明：守护真的活着（握手 ok + metadata 有 pid/port）、launch.<slot>.sh 自清理、launch-stderr.log 0600。
# ⚠️ 观测本身不弹窗：所有子进程 Hidden + 重定向；只碰自己的 --port（默认 8912）。
[CmdletBinding()]
param([int]$Port = 8912, [int]$Rounds = 5, [string]$Tag = 'run')
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$node = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
$probe = Join-Path $Root 'probe-f37.ts'
$script:Fails = @()
$script:Rows = @()

function Snap {
  $wins = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } |
      ForEach-Object { [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle } })
  $wt = @(Get-CimInstance Win32_Process -Filter "Name='WindowsTerminal.exe'" -ErrorAction SilentlyContinue |
      ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; created = "$($_.CreationDate)" } })
  # 本槽位的包装层（命令行含 launch.<slot>.sh）
  $wrap = @(Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -match "launch\.$Port\.sh" } |
      ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; cmd = $_.CommandLine } })
  return [pscustomobject]@{ wins = $wins; wt = $wt; wrap = $wrap }
}

function RunProbe([string[]]$extra) {
  $log = Join-Path $Root "out-$Tag-probe.log"
  $a = @("`"$probe`"") + $extra
  $pr = Start-Process -FilePath $node -ArgumentList $a -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $pr.WaitForExit(120000) | Out-Null
  $txt = $(if (Test-Path $log) { Get-Content $log -Raw } else { '' })
  return [pscustomobject]@{ exit = $pr.ExitCode; text = $txt }
}
function ResultOf([string]$txt) {
  $m = [regex]::Match($txt, '(?m)^RESULT (.*)$')
  if (-not $m.Success) { return $null }
  return ($m.Groups[1].Value | ConvertFrom-Json)
}

function Round([string]$name, [string[]]$extra) {
  Write-Host "`n---- [$name] ----"
  $A = Snap
  $p = RunProbe $extra
  Start-Sleep -Milliseconds 2500
  $B = Snap
  $r = ResultOf $p.text

  $newWins = @($B.wins | Where-Object { @($A.wins | ForEach-Object { $_.pid }) -notcontains $_.pid })
  $newWt = @($B.wt | Where-Object { @($A.wt | ForEach-Object { $_.pid }) -notcontains $_.pid })
  $windowDelta = $newWins.Count + $newWt.Count

  # 守护是否活着（握手）
  $hs = ResultOf (RunProbe @('--mode', 'handshake', '--port', "$Port")).text
  # 状态目录卫生：launch.<slot>.sh 必须已被守护自删
  $perms = (RunProbe @('--mode', 'perms', '--port', "$Port")).text
  $launcherLeft = $perms -match "launch\.$Port\.sh"
  $stderrMode = $(if ($perms -match '(?m)^(-rw\S+)\s+\d+\s+\S+\s+\S+\s+\S+\s+launch-stderr\.log') { $Matches[1] } else { '(未取到)' })

  $visOk = ($windowDelta -eq 0)
  $hsOk = ($hs -and $hs.ok -eq $true)
  $launcherOk = (-not $launcherLeft)
  $permOk = ($stderrMode -eq '-rw-------')
  $verdict = if ($visOk -and $hsOk -and $launcherOk -and $permOk) { 'PASS' } else { 'FAIL' }
  if ($verdict -eq 'FAIL') { $script:Fails += "$name 窗口∆=$windowDelta 握手=$($hsOk) 启动脚本残留=$launcherLeft 权限=$stderrMode" }

  Write-Host "   probe: exit=$($p.exit) $(($p.text -split "`n" | Where-Object { $_ -match '^RESULT' }) -join ' ')"
  Write-Host "   窗口: before wins=$($A.wins.Count)/wt=$($A.wt.Count)  after wins=$($B.wins.Count)/wt=$($B.wt.Count)  ∆=$windowDelta"
  if ($newWins.Count) { $newWins | ForEach-Object { Write-Host "     ⚠ 新窗口 pid=$($_.pid) $($_.name) $($_.title)" } }
  if ($newWt.Count) { $newWt | ForEach-Object { Write-Host "     ⚠ 新 WindowsTerminal pid=$($_.pid) ppid=$($_.ppid) created=$($_.created)" } }
  Write-Host "   握手: ok=$($hs.ok) pid=$($hs.pid) port=$($hs.port) keys=$($hs.keys)"
  Write-Host "   卫生: launch.$Port.sh 残留=$launcherLeft  launch-stderr.log=$stderrMode"
  Write-Host "   ⇒ $verdict"
  $script:Rows += [pscustomobject]@{
    round = $name; windowDelta = $windowDelta; newWinPids = @($newWins | ForEach-Object { $_.pid })
    newWtPids = @($newWt | ForEach-Object { $_.pid }); handshakeOk = $hsOk; handshakePid = $hs.pid
    launcherLeft = $launcherLeft; stderrMode = $stderrMode; verdict = $verdict; probeExit = $p.exit
  }
}

Write-Host "F-37 验证：port=$Port rounds=$Rounds tag=$Tag"
Write-Host "开工前枚举：wins=$((Snap).wins.Count) wt=$((Snap).wt.Count)"

# ── 五轮：首次启动 / 复用 / restart / stop+再启动 / 再复用 ─────────────────────
Round '1 首次启动(fresh ensure)' @('--mode', 'fresh', '--port', "$Port")
Round '2 已有守护复用(ensure)' @('--mode', 'reuse', '--port', "$Port")
Round '3 restart 对齐' @('--mode', 'restart', '--port', "$Port")
Round '4 复用(restart 后)' @('--mode', 'reuse', '--port', "$Port")
Round '5 stop 停守护' @('--mode', 'stop', '--port', "$Port")
Round '6 stop 后再首次启动' @('--mode', 'fresh', '--port', "$Port")

# ── 包装层退出后守护仍在（模拟"关客户端"）─────────────────────────────────────
Write-Host "`n---- [7 包装层被杀后守护仍在] ----"
$before = Snap
if ($before.wrap.Count -eq 0) {
  Write-Host "   ⚠ 未找到本槽位包装层 ⇒ 无法做该实验（记 FAIL）"; $script:Fails += '7 无包装层'
} else {
  $w = $before.wrap[0]
  Write-Host "   目标包装层 pid=$($w.pid) ppid=$($w.ppid)"
  Write-Host "   cmd=$($w.cmd)"
  $hs1 = ResultOf (RunProbe @('--mode', 'handshake', '--port', "$Port")).text
  Write-Host "   杀之前握手: ok=$($hs1.ok) pid=$($hs1.pid)"
  Stop-Process -Id $w.pid -Force -ErrorAction SilentlyContinue  # ★ 只杀我自己的包装层，不用全局 pkill
  Start-Sleep -Seconds 2
  $hs2 = ResultOf (RunProbe @('--mode', 'handshake', '--port', "$Port")).text
  $st = ResultOf (RunProbe @('--mode', 'status', '--port', "$Port")).text
  $after = Snap
  Write-Host "   杀之后握手: ok=$($hs2.ok) pid=$($hs2.pid)  （同一 pid ⇒ 守护没死）"
  Write-Host "   daemonSnapshot.live=$($st.live | ConvertTo-Json -Compress)"
  Write-Host "   窗口: before wins=$($before.wins.Count)/wt=$($before.wt.Count) after wins=$($after.wins.Count)/wt=$($after.wt.Count)"
  $aliveOk = ($hs1.ok -and $hs2.ok -and ($hs1.pid -eq $hs2.pid))
  $newWin2 = @($after.wins | Where-Object { @($before.wins | ForEach-Object { $_.pid }) -notcontains $_.pid })
  $newWt2 = @($after.wt | Where-Object { @($before.wt | ForEach-Object { $_.pid }) -notcontains $_.pid })
  Write-Host "   ⇒ 守护存活=$aliveOk  窗口∆=$($newWin2.Count + $newWt2.Count)"
  if (-not $aliveOk) { $script:Fails += '7 包装层被杀后握手失败/pid 变了' }
  if (($newWin2.Count + $newWt2.Count) -ne 0) { $script:Fails += '7 杀包装层时出现新窗口' }
  $script:Rows += [pscustomobject]@{ round = '7 包装层被杀后守护仍在'; windowDelta = ($newWin2.Count + $newWt2.Count); handshakeOk = $aliveOk; handshakePid = $hs2.pid; verdict = $(if ($aliveOk) { 'PASS' } else { 'FAIL' }) }
}

# ── 收尾：只停我自己的槽位 ───────────────────────────────────────────────────
Write-Host "`n---- [8 收尾] ----"
$stop = RunProbe @('--mode', 'stop', '--port', "$Port")
Write-Host "   stop: $(($stop.text -split "`n" | Where-Object { $_ -match '^RESULT' }) -join ' ')"
$st2 = ResultOf (RunProbe @('--mode', 'status', '--port', "$Port")).text
Write-Host "   收尾 daemonSnapshot.live=$($st2.live | ConvertTo-Json -Compress) orphans=$($st2.orphans | ConvertTo-Json -Compress)"
$final = Snap
Write-Host "   收尾枚举：wins=$($final.wins.Count) wt=$($final.wt.Count) 本槽位包装层=$($final.wrap.Count)"

$json = Join-Path $Root "out-verify-$Tag.json"
($script:Rows | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $json -Encoding utf8
Write-Host "`n================ 汇总 ================"
$script:Rows | Select-Object round, windowDelta, handshakeOk, launcherLeft, stderrMode, verdict | Format-Table -AutoSize
Write-Host "JSON -> $json"
if ($script:Fails.Count -eq 0) { Write-Host 'F-37 VERIFY: ALL PASS'; exit 0 }
Write-Host "F-37 VERIFY: $($script:Fails.Count) FAILED"; $script:Fails | ForEach-Object { Write-Host "  - $_" }; exit 1

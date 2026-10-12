#!/usr/bin/env pwsh
# verify-f37c.ps1 —— T17 双约束验证：(a) 无可见窗口  +  (b) 守护脱离 Windows 侧生死。
# 每轮：起"长驻宿主"(Hidden+重定向) → 动作 → 存活期枚举窗口(∆ 必须 0) + 握手 → **宿主退出后**再握手
#       （(b) 判据：握手仍 ok 且 meta.pid 不变）→ 卫生（launcher 自删 / launch-stderr.log 0600）。
[CmdletBinding()]
param([int]$Port = 8912, [string]$Tag = 'dual')
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$node = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
$probe = 'D:\project\net1\_t15-f37\probe-f37.ts'
$ka = 'D:\project\net1\_t15-f37\keepalive-launcher.mjs'
$script:Fails = @(); $script:Rows = @()

function Snap {
  $wins = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle } })
  $wt = @(Get-CimInstance Win32_Process -Filter "Name='WindowsTerminal.exe'" -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId } })
  return [pscustomobject]@{ wins = $wins; wt = $wt }
}
function Probe([string[]]$extra) {
  $log = Join-Path $Root "tmp-$Tag-probe.log"
  $a = @("`"$probe`"") + $extra
  $pr = Start-Process -FilePath $node -ArgumentList $a -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $pr.WaitForExit(120000) | Out-Null
  return $(if (Test-Path $log) { Get-Content $log -Raw } else { '' })
}
function Res([string]$t) { $m = [regex]::Match($t, '(?m)^RESULT (.*)$'); if ($m.Success) { return ($m.Groups[1].Value | ConvertFrom-Json) } return $null }
function WrapperOfSlot([int]$p) {
  return @(Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -match "launch\.$p\.sh" } | ForEach-Object { $_.ProcessId })
}

function Round([string]$name, [string]$mode, [bool]$expectDaemon) {
  Write-Host "`n---- [$name] mode=$mode ----"
  $A = Snap
  $log = Join-Path $Root "tmp-$Tag-$mode.log"
  $hostProc = Start-Process -FilePath $node -ArgumentList @("`"$ka`"", "$Port", '8000', $mode) -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  Start-Sleep -Milliseconds 4000
  $B = Snap
  $hs1 = Res (Probe @('--mode', 'handshake', '--port', "$Port"))
  $perms = Probe @('--mode', 'perms', '--port', "$Port")
  $launcherLeft = $perms -match "launch\.$Port\.sh"
  $stderrMode = $(if ($perms -match '(?m)^(-rw\S+)\s+.*launch-stderr\.log\s*$') { $Matches[1] } else { '(未取到)' })
  $newW = @($B.wins | Where-Object { @($A.wins | ForEach-Object { $_.pid }) -notcontains $_.pid })
  $newWt = @($B.wt | Where-Object { @($A.wt | ForEach-Object { $_.pid }) -notcontains $_.pid })
  $winD = $newW.Count + $newWt.Count
  $hostLog = $(if (Test-Path $log) { (Get-Content $log -Raw).Trim() -split "`n" | Select-Object -First 1 } else { '(无输出)' })

  # ★ (b) 判据：等宿主**正常退出**后，再握手（守护应仍在，且 meta.pid 不变）
  $hostProc.WaitForExit(60000) | Out-Null
  Start-Sleep -Milliseconds 2500
  $hs2 = Res (Probe @('--mode', 'handshake', '--port', "$Port"))
  $survived = if ($expectDaemon) { ($hs2.ok -eq $true) -and ($hs2.pid -eq $hs1.pid) } else { $hs2.ok -ne $true }

  $visOk = ($winD -eq 0)
  $permOk = ($stderrMode -eq '-rw-------')
  $launchOk = (-not $launcherLeft -or $mode -eq 'stop')
  $verdict = if ($visOk -and $permOk -and $launchOk -and $survived) { 'PASS' } else { 'FAIL' }
  if ($verdict -eq 'FAIL') { $script:Fails += "$name (win∆=$winD survived=$survived hs1=$($hs1.pid) hs2=$($hs2.pid) perm=$stderrMode launcherLeft=$launcherLeft)" }

  Write-Host "   宿主: $hostLog"
  Write-Host "   窗口: before=$($A.wins.Count)/wt$($A.wt.Count) after=$($B.wins.Count)/wt$($B.wt.Count)  ∆=$winD"
  if ($newWt.Count) { $newWt | ForEach-Object { Write-Host "     ⚠ 新 WindowsTerminal pid=$($_.pid) ppid=$($_.ppid)" } }
  Write-Host "   握手: 宿主存活期 ok=$($hs1.ok) pid=$($hs1.pid)  ｜ 宿主退出后 ok=$($hs2.ok) pid=$($hs2.pid)  ⇒ 存活=$survived"
  Write-Host "   卫生: launch.$Port.sh 残留=$launcherLeft  launch-stderr.log=$stderrMode"
  Write-Host "   ⇒ $verdict"
  $script:Rows += [pscustomobject]@{ round = $name; winDelta = $winD; hostAliveHs = $hs1.pid; afterHostExitHs = $hs2.pid; survivedHostExit = $survived; stderrMode = $stderrMode; verdict = $verdict }
}

Write-Host "T17 双约束验证 port=$Port tag=$Tag"
$a0 = Snap
Write-Host "开工枚举: wins=$($a0.wins.Count) wt=$($a0.wt.Count)  systemd 模式=$($env:DSH_REMOTE_WSL_SYSTEMD ?? 'auto')"

Round '1 首次启动(fresh, systemd 主路径)' 'fresh' $true
Round '2 已有守护复用' 'reuse' $true
Round '3 restart 对齐' 'restart' $true
Round '4 restart 后复用' 'reuse' $true
Round '5 stop 停守护' 'stop' $false
Round '6 stop 后再首次启动' 'fresh' $true

# ── 7) 只杀包装层（systemd 主路径下：包装层本就短命，杀它不该影响守护）─────────
Write-Host "`n---- [7 只杀包装层 + 杀宿主] ----"
$logf = Join-Path $Root "tmp-$Tag-killhost.log"
$host7 = Start-Process -FilePath $node -ArgumentList @("`"$ka`"", "$Port", '14000', 'reuse') -WindowStyle Hidden -PassThru -RedirectStandardOutput $logf -RedirectStandardError "$logf.err"
Start-Sleep -Milliseconds 4000
$hsA = Res (Probe @('--mode', 'handshake', '--port', "$Port"))
$wrapPids = WrapperOfSlot $Port
$A7 = Snap
Write-Host "   宿主 pid=$($host7.Id)（将硬杀）｜ 本槽位包装层=$($wrapPids -join ',')（systemd 主路径下通常为空）｜ 杀前握手 ok=$($hsA.ok) pid=$($hsA.pid)"
foreach ($wp in $wrapPids) { Stop-Process -Id ([int]$wp) -Force -ErrorAction SilentlyContinue }
Stop-Process -Id $host7.Id -Force -ErrorAction SilentlyContinue   # ★ 硬杀宿主（模拟"关客户端/宿主崩"）
Start-Sleep -Seconds 3
$hsB = Res (Probe @('--mode', 'handshake', '--port', "$Port"))
$stB = Res (Probe @('--mode', 'status', '--port', "$Port"))
$B7 = Snap
$newW7 = @($B7.wins | Where-Object { @($A7.wins | ForEach-Object { $_.pid }) -notcontains $_.pid }).Count + @($B7.wt | Where-Object { @($A7.wt | ForEach-Object { $_.pid }) -notcontains $_.pid }).Count
$ok7 = $hsA.ok -and $hsB.ok -and ($hsA.pid -eq $hsB.pid)
Write-Host "   硬杀宿主/包装层 +3s：握手 ok=$($hsB.ok) pid=$($hsB.pid)（应与杀前相同）｜ live=$($stB.live | ConvertTo-Json -Compress) 窗口∆=$newW7"
Write-Host "   ⇒ $(if ($ok7 -and $newW7 -eq 0) { 'PASS' } else { 'FAIL' })"
if (-not ($ok7 -and $newW7 -eq 0)) { $script:Fails += "7 硬杀宿主后守护未存活或出现窗口（ok=$ok7 win∆=$newW7）" }
$script:Rows += [pscustomobject]@{ round = '7 硬杀宿主+包装层'; winDelta = $newW7; survivedHostExit = $ok7; verdict = $(if ($ok7 -and $newW7 -eq 0) { 'PASS' } else { 'FAIL' }) }

# ── 8) 收尾 ───────────────────────────────────────────────────────────────────
Write-Host "`n---- [8 收尾] ----"
$st = Res (Probe @('--mode', 'stop', '--port', "$Port"))
$snapEnd = Res (Probe @('--mode', 'status', '--port', "$Port"))
$unit = (& wsl.exe -d debian-u8-1 -u g -- bash -c 'systemctl --user is-active dsh-rwsl-8912.service 2>&1; systemctl --user list-units "dsh-rwsl-*" --all --no-legend 2>&1 | head -3' 2>&1 | Where-Object { $_ -notmatch 'wsl:' }) -join ' / '
$final = Snap
Write-Host "   stop ok=$($st.ok) ｜ 剩余 slots=$($snapEnd.slots -join ',') live=$($snapEnd.live.Count) orphans=$($snapEnd.orphans -join ',')"
Write-Host "   unit 状态: $unit"
Write-Host "   收尾枚举: wins=$($final.wins.Count) wt=$($final.wt.Count)（开工 wins=$($a0.wins.Count) wt=$($a0.wt.Count)）"
$json = Join-Path $Root "out-verify-$Tag.json"
($script:Rows | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $json -Encoding utf8
Write-Host "`n================ 汇总 ================"
$script:Rows | Select-Object round, winDelta, survivedHostExit, verdict | Format-Table -AutoSize
Write-Host "JSON -> $json"
if ($script:Fails.Count -eq 0) { Write-Host 'T17 DUAL-CONSTRAINT: ALL PASS'; exit 0 }
Write-Host "T17 DUAL-CONSTRAINT: $($script:Fails.Count) FAILED"; $script:Fails | ForEach-Object { Write-Host "  - $_" }; exit 1

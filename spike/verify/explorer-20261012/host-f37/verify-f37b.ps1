#!/usr/bin/env pwsh
# verify-f37b.ps1 —— F-37 最终死磕验证（长驻宿主形态，贴近真实部署）。
# 每轮：起"长驻宿主"（Hidden+重定向）→ 动作 → 存活期枚举窗口（∆ 必须 0）→ 握手（守护真活着）
#       → 卫生（launch.<slot>.sh 自删、launch-stderr.log 0600）→ 等宿主退出。
# 另含：kill -HUP 存活、只杀包装层（已知限制，如实记录）、收尾清理。
[CmdletBinding()]
param([int]$Port = 8912, [string]$Tag = 'final')
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$node = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
$probe = Join-Path $Root 'probe-f37.ts'
$ka = Join-Path $Root 'keepalive-launcher.mjs'
$script:Fails = @(); $script:Rows = @()

function Snap {
  $wins = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle } })
  $wt = @(Get-CimInstance Win32_Process -Filter "Name='WindowsTerminal.exe'" -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; created = "$($_.CreationDate)" } })
  return [pscustomobject]@{ wins = $wins; wt = $wt }
}
function Probe([string[]]$extra) {
  $log = Join-Path $Root "out-$Tag-probe.log"
  $a = @("`"$probe`"") + $extra
  $pr = Start-Process -FilePath $node -ArgumentList $a -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $pr.WaitForExit(120000) | Out-Null
  return $(if (Test-Path $log) { Get-Content $log -Raw } else { '' })
}
function Res([string]$t) { $m = [regex]::Match($t, '(?m)^RESULT (.*)$'); if ($m.Success) { return ($m.Groups[1].Value | ConvertFrom-Json) } return $null }

function Round([string]$name, [string]$mode, [bool]$expectDaemon) {
  Write-Host "`n---- [$name] mode=$mode ----"
  $A = Snap
  $log = Join-Path $Root "out-$Tag-$mode.log"
  $host_ = Start-Process -FilePath $node -ArgumentList @("`"$ka`"", "$Port", '9000', $mode) -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  Start-Sleep -Milliseconds 4000
  $B = Snap
  $hs = Res (Probe @('--mode', 'handshake', '--port', "$Port"))
  $perms = Probe @('--mode', 'perms', '--port', "$Port")
  $launcherLeft = $perms -match "launch\.$Port\.sh"
  $stderrMode = $(if ($perms -match '(?m)^(-rw\S+)\s+.*launch-stderr\.log\s*$') { $Matches[1] } else { '(未取到)' })
  $newWins = @($B.wins | Where-Object { @($A.wins | ForEach-Object { $_.pid }) -notcontains $_.pid })
  $newWt = @($B.wt | Where-Object { @($A.wt | ForEach-Object { $_.pid }) -notcontains $_.pid })
  $winD = $newWins.Count + $newWt.Count
  $hostLog = $(if (Test-Path $log) { (Get-Content $log -Raw).Trim() -split "`n" | Select-Object -First 1 } else { '(无输出)' })

  $hsOk = ($hs -and $hs.ok -eq $true)
  $visOk = ($winD -eq 0)
  $daemonOk = ($hsOk -eq $expectDaemon)
  $permOk = ($stderrMode -eq '-rw-------')
  $verdict = if ($visOk -and $daemonOk -and $permOk -and (-not $launcherLeft -or $mode -eq 'stop')) { 'PASS' } else { 'FAIL' }
  if ($verdict -eq 'FAIL') { $script:Fails += "$name (win∆=$winD daemonOk=$daemonOk hs=$hsOk perm=$stderrMode launcherLeft=$launcherLeft)" }

  Write-Host "   宿主: $hostLog"
  Write-Host "   窗口: before=$($A.wins.Count)/wt$($A.wt.Count) after=$($B.wins.Count)/wt$($B.wt.Count)  ∆=$winD"
  if ($newWins.Count) { $newWins | ForEach-Object { Write-Host "     ⚠ 新窗口 pid=$($_.pid) $($_.name) $($_.title)" } }
  if ($newWt.Count) { $newWt | ForEach-Object { Write-Host "     ⚠ 新 WindowsTerminal pid=$($_.pid) ppid=$($_.ppid)" } }
  Write-Host "   握手: ok=$($hs.ok) pid=$($hs.pid) port=$($hs.port)  （期望 ok=$expectDaemon）"
  Write-Host "   卫生: launch.$Port.sh 残留=$launcherLeft  launch-stderr.log=$stderrMode"
  Write-Host "   ⇒ $verdict"
  $host_.WaitForExit(60000) | Out-Null
  $script:Rows += [pscustomobject]@{ round = $name; winDelta = $winD; handshakeOk = $hsOk; daemonPid = $hs.pid; launcherLeft = $launcherLeft; stderrMode = $stderrMode; verdict = $verdict }
  return $hs
}

Write-Host "F-37 最终验证 port=$Port tag=$Tag"
$a0 = Snap; Write-Host "开工枚举: wins=$($a0.wins.Count) wt=$($a0.wt.Count)"

$null = Round '1 首次启动(fresh)' 'fresh' $true
$null = Round '2 已有守护复用(ensure)' 'reuse' $true
$null = Round '3 restart 对齐' 'restart' $true
$null = Round '4 复用(restart 后)' 'reuse' $true
$null = Round '5 stop 停守护' 'stop' $false
$null = Round '6 stop 后再首次启动' 'fresh' $true

# ── 7) 裸 SIGHUP 必须被忽略（本修法新增的存活加固）────────────────────────────
# ⚠️ 必须有"长驻宿主"在场：宿主一退，包装层/守护都会被连带回收（既有耦合），
#    所以这里先起 keepalive，再在它活着的时候发 HUP。
Write-Host "`n---- [7 裸 SIGHUP 存活（长驻宿主在场）] ----"
$log7 = Join-Path $Root "out-$Tag-hup.log"
$host7 = Start-Process -FilePath $node -ArgumentList @("`"$ka`"", "$Port", '10000', 'reuse') -WindowStyle Hidden -PassThru -RedirectStandardOutput $log7 -RedirectStandardError "$log7.err"
Start-Sleep -Milliseconds 4000
$hsA = Res (Probe @('--mode', 'handshake', '--port', "$Port"))
if (-not $hsA.ok) { Write-Host '   前置失败：守护不在 ⇒ 记 FAIL'; $script:Fails += '7 前置无守护' }
else {
  $s = "kill -HUP $($hsA.pid); sleep 0.6; kill -0 $($hsA.pid) 2>/dev/null && echo STILL_ALIVE || echo DEAD"
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))
  $k = (& wsl.exe -d debian-u8-1 -u g -- bash -c "echo $b64 | base64 -d | bash" 2>&1 | Where-Object { $_ -match 'STILL_ALIVE|DEAD' }) -join ' '
  $hsB = Res (Probe @('--mode', 'handshake', '--port', "$Port"))
  Write-Host "   kill -HUP $($hsA.pid) => $k"
  Write-Host "   HUP 后握手: ok=$($hsB.ok) pid=$($hsB.pid)（应与前相同 pid=$($hsA.pid)）"
  $ok7 = ($k -match 'STILL_ALIVE') -and $hsB.ok -and ($hsB.pid -eq $hsA.pid)
  if (-not $ok7) { $script:Fails += '7 SIGHUP 后守护死了/pid 变了' }
  Write-Host "   ⇒ $(if ($ok7) { 'PASS' } else { 'FAIL' })"
  $script:Rows += [pscustomobject]@{ round = '7 裸 SIGHUP 存活'; winDelta = 0; handshakeOk = $ok7; daemonPid = $hsB.pid; verdict = $(if ($ok7) { 'PASS' } else { 'FAIL' }) }
}
$host7.WaitForExit(60000) | Out-Null

# ── 8) 只杀包装层（已知限制：本机 WSL 会连带回收；记录，不计入本修法的红）───────
Write-Host "`n---- [8 只杀包装层：记录已知限制] ----"
$logf = Join-Path $Root "out-$Tag-wrapkill.log"
$host2 = Start-Process -FilePath $node -ArgumentList @("`"$ka`"", "$Port", '12000', 'reuse') -WindowStyle Hidden -PassThru -RedirectStandardOutput $logf -RedirectStandardError "$logf.err"
Start-Sleep -Milliseconds 4000
$A8 = Snap
$wline = (Get-Content $logf | Select-String '^WRAPPER' | Select-Object -First 1).Line
$wpid = $(if ($wline) { ($wline -replace '^WRAPPER\s*', '').Split(',')[0] } else { '' })
$hs1 = Res (Probe @('--mode', 'handshake', '--port', "$Port"))
Write-Host "   包装层 pid=$wpid；杀前握手 ok=$($hs1.ok) pid=$($hs1.pid)"
if ($wpid) { Stop-Process -Id ([int]$wpid) -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
$hs2 = Res (Probe @('--mode', 'handshake', '--port', "$Port"))
$B8 = Snap
$newW = @($B8.wins | Where-Object { @($A8.wins | ForEach-Object { $_.pid }) -notcontains $_.pid }).Count + @($B8.wt | Where-Object { @($A8.wt | ForEach-Object { $_.pid }) -notcontains $_.pid }).Count
Write-Host "   杀包装层 +3s 握手: ok=$($hs2.ok)（本机 WSL 连带回收 ⇒ 预期 false，这是**既有**限制，非本修法引入）"
Write-Host "   杀包装层过程窗口 ∆=$newW（必须 0）"
if ($newW -ne 0) { $script:Fails += '8 杀包装层时出现新窗口' }
$host2.WaitForExit(60000) | Out-Null
$script:Rows += [pscustomobject]@{ round = '8 杀包装层(限制记录)'; winDelta = $newW; handshakeOk = $hs2.ok; daemonPid = $hs2.pid; verdict = $(if ($newW -eq 0) { 'PASS(窗口)' } else { 'FAIL' }) }

# ── 9) 收尾 ───────────────────────────────────────────────────────────────────
Write-Host "`n---- [9 收尾] ----"
$st = Res (Probe @('--mode', 'stop', '--port', "$Port"))
$snapEnd = Res (Probe @('--mode', 'status', '--port', "$Port"))
$final = Snap
Write-Host "   stop ok=$($st.ok) | 剩余 slots=$($snapEnd.slots -join ',') live=$($snapEnd.live.Count) orphans=$($snapEnd.orphans -join ',')"
Write-Host "   收尾枚举: wins=$($final.wins.Count) wt=$($final.wt.Count)（开工 wins=$($a0.wins.Count) wt=$($a0.wt.Count)）"
$json = Join-Path $Root "out-verify-$Tag.json"
($script:Rows | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $json -Encoding utf8
Write-Host "`n================ 汇总 ================"
$script:Rows | Select-Object round, winDelta, handshakeOk, daemonPid, verdict | Format-Table -AutoSize
Write-Host "JSON -> $json"
if ($script:Fails.Count -eq 0) { Write-Host 'F-37 VERIFY: ALL PASS'; exit 0 }
Write-Host "F-37 VERIFY: $($script:Fails.Count) FAILED"; $script:Fails | ForEach-Object { Write-Host "  - $_" }; exit 1

#!/usr/bin/env pwsh
# fix2-20261010/run-f1.ps1 —— task-14 #1/#2/#3：F1 完整性断言（我自己写的脚本，未复用实现者脚本）。
#
# 阶段 A（F1 核心，lead 只拿到一半的那条）：A(8841)+B(8842) 两个健康守护、**无孤儿**时，
#   对 B 不带 slot 执行 stop ⇒ 必须无 `Orphans:` 行、orphans_left=0，且 **A 仍存活且握手正常**。
# 阶段 B（F1 反例）：再真造一个孤儿(8843，元数据已删、进程活着) ⇒ status/snapshot 必须识别它，
#   不带 slot 的 stop 必须**只**点名它（不能把真孤儿一起漏掉，也不能误报 A/B）。
# 阶段 C：对孤儿槽位 ensure ⇒ 先收掉无元数据守护、仍在**请求槽位**起。
# 收尾逐槽位停我自己的（**不用 stop all=true**，避免误杀他人共享 state dir 的守护）。
[CmdletBinding()]
param([int]$A = 8841, [int]$B = 8842, [int]$Orphan = 8843)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$node = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
$probe = Join-Path $Root 'probe3.ts'
$script:Fails = @()
function Say($m) { Write-Host $m }
function Check([bool]$c, [string]$m) { if ($c) { Say "  [PASS] $m" } else { Say "  [FAIL] $m"; $script:Fails += $m } }
function P([string[]]$a, [string]$log) {
  $q = foreach ($x in $a) { if ($x -match '[\s"]') { '"' + $x.Replace('"', '\"') + '"' } else { $x } }
  $pr = Start-Process -FilePath $node -ArgumentList ('"' + $probe + '" ' + ($q -join ' ')) -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $pr.WaitForExit(240000) | Out-Null
  return [pscustomobject]@{ Exit = $pr.ExitCode; Text = ((Get-Content -LiteralPath $log -Raw) -as [string]) }
}
function Show($t) { $t -split "`n" | Where-Object { $_ -ne '' } | ForEach-Object { Say "    $_" } }
function Machine([string]$t) { (($t -split "`n") | Where-Object { $_ -match '^machine:' }) -join ' | ' }

Say "################ 0) 开工现场：他人守护清点（不得复用、不得误杀）################"
Show (P @('--mode', 'snapshot', '--port', "$A") "$Root\out-f1-00-baseline.txt").Text
$s = @'
for p in $(pgrep -f -- 'daemon\.t[s]' 2>/dev/null); do c=$(tr '\0' ' ' < /proc/$p/cmdline); echo "  pid=$p $(echo "$c" | grep -oE '\-\-port [0-9]+') $(echo "$c" | grep -oE '\-\-state-dir [^ ]+')"; done
'@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))
& wsl.exe -d debian-u8-1 -u g -- bash -c "echo $b64 | base64 -d | bash" 2>&1 | ForEach-Object { "  $_" }

Say "`n################ 1) 起 A($A) 与 B($B) 两个健康守护 ################"
Show (P @('--mode', 'tool-start', '--port', "$A") "$Root\out-f1-01a-start-A.txt").Text
Show (P @('--mode', 'tool-start', '--port', "$B") "$Root\out-f1-01b-start-B.txt").Text
$snapAB = P @('--mode', 'snapshot', '--port', "$A") "$Root\out-f1-02-snapshot-AB.txt"
Say "  现场:"; Show $snapAB.Text
$apid = ([regex]::Match($snapAB.Text, '"livePid":(\d+)')).Groups[1].Value
Say "  A pid=$apid（B 的 pid 见 snapshot procs）"

Say "`n################ 2) 【F1 核心】无孤儿时对 B 不带 slot 执行 stop ################"
$stopB = P @('--mode', 'tool-stop', '--port', "$B") "$Root\out-f1-03-stop-B.txt"
Show $stopB.Text
Check ($stopB.Text -notmatch 'Orphans:') "无 `Orphans:` 误报行"
Check ($stopB.Text -match 'orphans_left=0') "orphans_left=0"
Check ($stopB.Text -match "machine: slot=$B ") "machine 行 slot=$B（带 slot 的 stop）"
$aliveA = P @('--mode', 'status-json', '--port', "$A") "$Root\out-f1-04-A-alive.txt"
Show $aliveA.Text
Check (($aliveA.Text -match '"ok":true') -and ($aliveA.Text -match ('"pid":' + $apid))) "A(pid=$apid) 在 stop B 之后仍存活且握手正常"

Say "`n################ 3) 【F1 反例】真造孤儿($Orphan) ⇒ 必须仍被识别 ################"
Show (P @('--mode', 'iso-orphan', '--port', "$Orphan") "$Root\out-f1-05-orphan.txt").Text
$snapO = P @('--mode', 'snapshot', '--port', "$A") "$Root\out-f1-06-snapshot-orphan.txt"
Say "  snapshot:"; Show $snapO.Text
$opid = ([regex]::Match($snapO.Text, '"orphans":\[\{"pid":(\d+)')).Groups[1].Value
Say "  孤儿 pid=$opid"
Check ([bool]$opid) "snapshot.orphans 识别出真孤儿"
$sj = P @('--mode', 'status-json', '--port', "$A") "$Root\out-f1-07-status-json.txt"
Say "  daemonStatus:"; Show $sj.Text
Check ($sj.Text -match [regex]::Escape($opid)) "daemonStatus.orphans 同一口径（含 pid=$opid）"
$stT = P @('--mode', 'tool-status', '--port', "$A") "$Root\out-f1-08-tool-status.txt"
Say "  wsl_daemon action=status:"; Show $stT.Text
Check (($stT.Text -match 'orphans=1') -and ($stT.Text -match [regex]::Escape("pid$opid"))) "status 工具行 orphans=1 且点名 pid$opid"

Say "`n################ 4) 不带 slot 的 stop（真孤儿存在时）：只点名真孤儿，不误报 A ################"
$stA = P @('--mode', 'tool-stop', '--port', "$A") "$Root\out-f1-09-stop-A-with-orphan.txt"
Show $stA.Text
Check ($stA.Text -match 'Orphans:') "真孤儿存在时**仍**输出 Orphans 行（没把真孤儿漏掉）"
Check ($stA.Text -match [regex]::Escape("pid$opid")) "Orphans 行点名真孤儿 pid$opid"
$orphLine = (($stA.Text -split "`n") | Where-Object { $_ -match '^Orphans:' }) -join ' '
$otherPids = (($snapAB.Text | Select-String -Pattern '"pid":(\d+)' -AllMatches).Matches | ForEach-Object { $_.Groups[1].Value }) | Where-Object { $_ -ne $opid }
$leak = $false; foreach ($x in $otherPids) { if ($orphLine -match "pid$x") { $leak = $true } }
Check (-not $leak) "Orphans 行**不含**任何健康守护 pid（检查过 $($otherPids -join ','))"

Say "`n################ 5) ensure 侧口径：对孤儿槽位起 ⇒ 先收掉、仍在请求槽位起 ################"
$ens = P @('--mode', 'ensure-json', '--port', "$Orphan") "$Root\out-f1-10-ensure-orphan-slot.txt"
Show $ens.Text
Check (($ens.Text -match '"port":8843') -and ($ens.Text -match '"slot":8843')) "ensure 在请求槽位 8843 起（未迁移 +1）"
Check ($ens.Text -match '无元数据') "ensure 明确'发现无元数据/失联的本插件守护 ⇒ 先收掉再起'"
Start-Sleep -Seconds 2
$fin = P @('--mode', 'snapshot', '--port', "$A") "$Root\out-f1-11-final-snapshot.txt"
Say "  收尾现场:"; Show $fin.Text
Check ($fin.Text -match '"orphans":\[\]') "真孤儿已被回收（orphans=[]）"

Say "`n################ 6) 逐槽位停我自己的（不用 stop all=true）################"
foreach ($pt in @($Orphan, $A)) {
  $r = P @('--mode', 'tool-stop', '--port', "$pt") "$Root\out-f1-12-stop-$pt.txt"
  Say "  stop $pt => $(Machine $r.Text)"
}
Start-Sleep -Seconds 2
$end = P @('--mode', 'snapshot', '--port', "$A") "$Root\out-f1-13-end.txt"
Say "  最终 snapshot:"; Show $end.Text

Say ''
if ($script:Fails.Count -eq 0) { Say 'RUN-F1: ALL CHECKS PASSED'; exit 0 }
Say "RUN-F1: $($script:Fails.Count) CHECK(S) FAILED"; $script:Fails | ForEach-Object { Say "  - $_" }; exit 1

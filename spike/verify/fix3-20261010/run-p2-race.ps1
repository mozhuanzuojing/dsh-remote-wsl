#!/usr/bin/env pwsh
# fix3-20261010/run-p2-race.ps1 —— task-16：in-host cwd 对照 + P2 三步计数/他人文件不动 + 起停竞态。
[CmdletBinding()]
param([int]$Port = 8842, [int]$Rounds = 5)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$node = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
$probe = Join-Path $Root 'probe4.ts'
$script:Fails = @()
function Say($m) { Write-Host $m }
function Check([bool]$c, [string]$m) { if ($c) { Say "  [PASS] $m" } else { Say "  [FAIL] $m"; $script:Fails += $m } }
function Run([string[]]$a, [string]$log) {
  $q = foreach ($x in $a) { if ($x -match '[\s"]') { '"' + $x.Replace('"', '\"') + '"' } else { $x } }
  $pr = Start-Process -FilePath $node -ArgumentList ('"' + $probe + '" ' + ($q -join ' ')) -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $pr.WaitForExit(240000) | Out-Null
  return [pscustomobject]@{ Exit = $pr.ExitCode; Text = ((Get-Content -LiteralPath $log -Raw) -as [string]) }
}
function Show([string]$t) { ($t -split "`n") | Where-Object { $_ -ne '' } | ForEach-Object { Say "    $_" } }

Say "################ A) in-host 后端未变：cwd 仍生效（新 pid 的 /proc cwd）################"
$inh = Run @('--mode','inhost-cwd','--port',"$Port",'--backend','in-host','--cwd','/tmp') "$Root\out-p2-a-inhost-cwd.txt"
Show $inh.Text
Check ($inh.Text -match 'cwd=/tmp') "in-host 工具返回 cwd=/tmp"
Check ($inh.Text -match '/proc/\d+/cwd=/tmp') "新增 in-host 运行时进程的 /proc cwd=/tmp"

Say "`n################ B) P2 三步计数（own=2 / foreign-alive=1 / foreign-dead=1）################"
$foreignAlive = $PID
Say "  foreign(alive) winpid=$foreignAlive（本 pwsh；用于证明『活宿主他人文件不被删』）"
$sw = Run @('--mode','sweep3','--port',"$Port",'--foreign-alive',"$foreignAlive",'--dead-linux-pid','999999') "$Root\out-p2-b-sweep3.txt"
Show $sw.Text
$step1 = ([regex]::Match($sw.Text, 'step1 count = (.*)')).Groups[1].Value
$step2 = ([regex]::Match($sw.Text, 'step2 count = (.*)')).Groups[1].Value
$step3 = ([regex]::Match($sw.Text, 'step3 count = (.*)')).Groups[1].Value
Say "  step1=[$step1]"; Say "  step2=[$step2]"; Say "  step3=[$step3]"
$me = ([regex]::Match($sw.Text, '\[probe4 pid=(\d+)\]')).Groups[1].Value
Check (($step1 -match "dsh-rwsl-$me-") -and ($step1 -match "dsh-rwsl-$foreignAlive-") -and ($step1 -match 'dsh-rwsl-999998-')) "第①步三类文件都在（own/foreign-alive/foreign-dead）"
Check ($step2 -notmatch "dsh-rwsl-$me-[^ ]*\.pid") "第②步：own(winpid=$me，linux pid 已死) 的 .pid 已被回收"
Check ($step2 -match "dsh-rwsl-$foreignAlive-") "第②步：**他人且宿主活着**的文件仍在（绝不碰）"
Check ($step2 -notmatch 'dsh-rwsl-999998-') "第②步：属主已死的他人文件被回收（文档化的边界行为）"
Check ($step3 -notmatch 'dsh-rwsl-') "第③步：我自己造的文件全部清干净"

Say "`n################ C) 起停竞态：连续 $Rounds 轮 start→stop 是否还有 connection closed before reply ################"
$rc = Run @('--mode','races','--port',"$Port",'--rounds',"$Rounds") "$Root\out-p2-c-races.txt"
Show $rc.Text
$bad = ([regex]::Matches($rc.Text, 'transport=closed')).Count
$okCount = ([regex]::Matches($rc.Text, 'transport=shutdown')).Count
Say "  transport=shutdown 次数=$okCount ; transport=closed 次数=$bad"
Check ($okCount -eq $Rounds) "$Rounds 轮 stop 全部拿到 shutdown 回包（无 closed/超时）"
Check ($bad -eq 0) "无 `connection closed before reply`（竞态已消失）"

Say ''
if ($script:Fails.Count -eq 0) { Say 'RUN-P2-RACE: ALL CHECKS PASSED'; exit 0 }
Say "RUN-P2-RACE: $($script:Fails.Count) CHECK(S) FAILED"; $script:Fails | ForEach-Object { Say "  - $_" }; exit 1

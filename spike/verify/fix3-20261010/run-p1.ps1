#!/usr/bin/env pwsh
# fix3-20261010/run-p1.ps1 —— task-16 #1/#2 + lead 额外要的 (key,cwd) 语义判定。
[CmdletBinding()]
param([int]$Port = 8841)
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
  return ((Get-Content -LiteralPath $log -Raw) -as [string])
}
function Show([string]$t) { ($t -split "`n") | Where-Object { $_ -ne '' } | ForEach-Object { Say "    $_" } }
function Field([string]$t, [string]$name) {
  $m = [regex]::Match($t, ($name + '=([^\s]+)'))
  if ($m.Success) { return $m.Groups[1].Value } else { return '' }
}
function ProcCwdOf([string]$t) {
  $m = [regex]::Match($t, '/proc/\d+/cwd=([^\s]+)')
  if ($m.Success) { return $m.Groups[1].Value } else { return '' }
}

Say "################ P1-a：协议层 per-call cwd=/tmp（确定性：/proc/<runtimePid>/cwd）################"
$ta = Run @('--mode','dprompt','--port',"$Port",'--key','p1','--cwd','/tmp','--text','只回复 ACK') "$Root\out-p1-a-tmp.txt"
Show $ta
Check ((Field $ta 'daemonReportedCwd') -eq '/tmp') "daemonReportedCwd=/tmp"
Check ((ProcCwdOf $ta) -eq '/tmp') "远端 /proc/<runtimePid>/cwd=/tmp（不靠模型自述）"

Say "`n################ P1-b：不传 cwd ⇒ 守护 --cwd 默认 /home/g ################"
$tb = Run @('--mode','dprompt','--port',"$Port",'--key','p1','--text','只回复 ACK') "$Root\out-p1-b-default.txt"
Show $tb
Check ((Field $tb 'daemonReportedCwd') -eq '/home/g') "daemonReportedCwd=/home/g"
Check ((ProcCwdOf $tb) -eq '/home/g') "远端 /proc/<runtimePid>/cwd=/home/g"

Say "`n################ P1-c：守护元数据按 (key,cwd) 分条目 ################"
$tc = Run @('--mode','dstatus','--port',"$Port") "$Root\out-p1-c-keys.txt"
Show $tc
Check (($tc -match '"cwd":"/tmp"') -and ($tc -match '"cwd":"/home/g"')) "keys 里同一 key 出现 /tmp 与 /home/g 两个条目"

Say "`n################ P1-d：工具层 wsl_agent({cwd:'/tmp'}) ⇒ 远端 pwd 真的 /tmp ################"
$td = Run @('--mode','agent','--port',"$Port",'--key','cwd-tool','--cwd','/tmp','--task','运行 pwd 并只回复它输出的路径') "$Root\out-p1-d-tool-tmp.txt"
Show $td
Check (($td -match '/tmp') -and ($td -match 'cwd=/tmp')) "工具返回里 cwd=/tmp 且正文含 /tmp（远端 pwd）"

Say "`n################ Lead 额外语义：(key,cwd) 身份 ⇒ 换 cwd 必须**显式可见**、不静默丢上下文 ################"
$s1 = Run @('--mode','agent','--port',"$Port",'--key','semk','--cwd','/home/g','--task','记住数字 555。只回复 ACK') "$Root\out-p1-e-sem-1.txt"
Say "  [1] key=semk cwd=/home/g 第 1 轮:"; Show $s1
$s2 = Run @('--mode','agent','--port',"$Port",'--key','semk','--cwd','/tmp','--task','刚才让你记的数字？只回数字') "$Root\out-p1-f-sem-2.txt"
Say "  [2] 同 key、cwd=/tmp（应是**另一个**运行时/会话）:"; Show $s2
$s3 = Run @('--mode','agent','--port',"$Port",'--key','semk','--cwd','/home/g','--task','刚才让你记的数字？只回数字') "$Root\out-p1-g-sem-3.txt"
Say "  [3] 切回 cwd=/home/g（应恢复原会话、记得 555）:"; Show $s3
$sid1 = Field $s1 'session'; $sid2 = Field $s2 'session'; $sid3 = Field $s3 'session'
$t1 = Field $s1 'turns'; $t2 = Field $s2 'turns'; $t3 = Field $s3 'turns'
$rp1 = Field $s1 'runtimePid'; $rp2 = Field $s2 'runtimePid'
Say "  session1=$sid1(turns=$t1) session2=$sid2(turns=$t2) session3=$sid3(turns=$t3) rp1=$rp1 rp2=$rp2"
Check ([bool]$sid1 -and [bool]$sid2 -and ($sid1 -ne $sid2)) "换 cwd 得到**不同 sessionId**（身份确实分开）"
Check ($rp1 -ne $rp2) "换 cwd 得到**不同 runtimePid**"
Check ($t2 -eq '1') "cwd=/tmp 的会话 turns=1 ⇒ 上下文未从 /home/g 串过来（可见地是新会话）"
Check ($s2 -notmatch '(?m)^\s*555\s*$') "cwd=/tmp 的回答**不是** 555 ⇒ 没有静默复用旧 ctx"
Check (($sid3 -eq $sid1) -and ($t3 -eq '2')) "切回 cwd=/home/g 恢复原会话（同 sessionId、turns=2）⇒ 切换是**非破坏性**的"
Check ($s3 -match '(?m)^\s*555\s*$') "切回后答出 555 ⇒ 原上下文确实还在"

Say ''
if ($script:Fails.Count -eq 0) { Say 'RUN-P1: ALL CHECKS PASSED'; exit 0 }
Say "RUN-P1: $($script:Fails.Count) CHECK(S) FAILED"; $script:Fails | ForEach-Object { Say "  - $_" }; exit 1


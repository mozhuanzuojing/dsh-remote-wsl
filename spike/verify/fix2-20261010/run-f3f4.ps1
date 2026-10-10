#!/usr/bin/env pwsh
# fix2-20261010/run-f3f4.ps1 —— task-14 #3（F3 机器行统一）+ #4（F4 内联整改）。
# F3 全程用**私有 wslHome**（/tmp/rwsl-fix2-<port>）⇒ 不碰共享 state dir、不碰他人守护。
[CmdletBinding()]
param([int]$P1 = 8844, [int]$P2 = 8845)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$node = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
$probe = Join-Path $Root 'probe3.ts'
$priv = "/tmp/rwsl-fix2-$P1"
function Say($m) { Write-Host $m }
function Run([string[]]$a, [string]$log) {
  $q = foreach ($x in $a) { if ($x -match '[\s"]') { '"' + $x.Replace('"', '\"') + '"' } else { $x } }
  $pr = Start-Process -FilePath $node -ArgumentList ('"' + $probe + '" ' + ($q -join ' ')) -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $pr.WaitForExit(240000) | Out-Null
  return ((Get-Content -LiteralPath $log -Raw) -as [string])
}
function Machine([string]$t) { (($t -split "`n") | Where-Object { $_ -match '^machine:' }) -join "`n" }
function Show([string]$t) { ($t -split "`n") | Where-Object { $_ -ne '' } | ForEach-Object { Say "    $_" } }

Say "################ F3：5 种动作的 machine 行（私有 wslHome=$priv）################"
$m = [ordered]@{}
Say "  [1 start $P1]";    $t = Run @('--mode','tool-start','--port',"$P1",'--wsl-home',$priv) "$Root\out-f3-1-start.txt";    Show $t; $m['start'] = Machine $t
Say "  [2 status $P1]";   $t = Run @('--mode','tool-status','--port',"$P1",'--wsl-home',$priv) "$Root\out-f3-2-status.txt";   Show $t; $m['status'] = Machine $t
Say "  [3 restart $P1]";  $t = Run @('--mode','tool-restart','--port',"$P1",'--wsl-home',$priv) "$Root\out-f3-3-restart.txt";  Show $t; $m['restart'] = Machine $t
Say "  [4 stop $P1]";     $t = Run @('--mode','tool-stop','--port',"$P1",'--wsl-home',$priv) "$Root\out-f3-4-stop.txt";     Show $t; $m['stop'] = Machine $t
Say "  [5a start $P2]";   $t = Run @('--mode','tool-start','--port',"$P2",'--wsl-home',$priv) "$Root\out-f3-5-start2.txt";   Show $t
Say "  [5b stop --all]";  $t = Run @('--mode','tool-stop','--port',"$P2",'--wsl-home',$priv,'--all') "$Root\out-f3-6-stopall.txt"; Show $t; $m['stop-all'] = Machine $t

Say "`n  ---- 五条 machine 行并列 ----"
foreach ($k in $m.Keys) { Say ("    [{0,-8}] {1}" -f $k, $m[$k]) }
$re = '^machine: slot=(\S+) pid=(\S+) port=(\S+) version=(\S+)( .*)?$'
$ok = $true
foreach ($k in $m.Keys) { if ($m[$k] -notmatch $re) { $ok = $false; Say "    [FAIL] $k 不匹配统一正则" } }
Say "    同一正则可解析全部五种动作: $ok"
$fields = foreach ($k in $m.Keys) { ([regex]::Match($m[$k], $re)).Groups[1].Name + ':' + ((([regex]::Match($m[$k], $re)).Groups | Select-Object -Skip 1 -First 4) | ForEach-Object { $_.Name }) -join ',' }
Say "    （正则捕获组：slot/pid/port/version + 可选 extra）"

Say "`n################ F4：src 内不再有内联 bash -c / bash -lc 串 ################"
Say "  [改前对照] task-11 时旧 revision 的 index.ts:942 用的是内联：``bash -lc 'ls -1 /tmp/dsh-rwsl-*.pid 2>/dev/null | wc -l'``（我当时的报告）"
$all = Select-String -Path 'D:\project\dsh1\vendor\dsh-remote-wsl\src\*.ts' -Pattern "bash"
Say "  src/*.ts 中所有含 'bash' 的行（人工核对是否还有内联串）:"
$all | ForEach-Object { Say ("    {0}:{1} {2}" -f $_.Filename, $_.LineNumber, $_.Line.Trim()) }
$inline = $all | Where-Object { $_.Line -match "-c\b" -or $_.Line -match "-lc\b" }
if ($inline) { Say "  !! 仍疑似内联:"; $inline | ForEach-Object { Say ("    {0}:{1} {2}" -f $_.Filename,$_.LineNumber,$_.Line.Trim()) } }
else { Say "  ✓ 无内联 bash -c / bash -lc 串（其余 bash 用法均为'落文件 + bash <file>'）" }

Say "`n  ---- F4 功能面：/tmp 计数是否正确（造 3 个属主已死的残留后比对）################"
$mk = @'
ls -1 /tmp/dsh-rwsl-999999-* 2>/dev/null | wc -l
'@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(@'
for i in 1 2 3; do printf '#!/bin/bash\necho x\n' > /tmp/dsh-rwsl-999999-f4-$i.sh; echo 999999 > /tmp/dsh-rwsl-999999-f4-$i.pid; done
echo "created=$(ls -1 /tmp/dsh-rwsl-999999-f4-* 2>/dev/null | wc -l)"
'@))
$t = Run @('--mode','script','--port',"$P1",'--wsl-home',$priv,'--script-b64',$b64) "$Root\out-f4-1-mkfake.txt"; Show $t
$t2 = Run @('--mode','tool-status','--port',"$P1",'--wsl-home',$priv) "$Root\out-f4-2-status-tmpcount.txt"
Say "  wsl_status 报的 pid files 行:"; ($t2 -split "`n") | Where-Object { $_ -match 'pid files' } | ForEach-Object { Say "    $_" }
$t3 = Run @('--mode','script','--port',"$P1",'--wsl-home',$priv,'--script-b64',([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('echo "actual=$(ls -1 /tmp/dsh-rwsl-999999-f4-* 2>/dev/null | wc -l)"')))) "$Root\out-f4-3-actual.txt"; Show $t3
Say "  （此处只验'内联改落文件后仍能数对'；999999 属主已死的残留随后由产品 sweep 清）"
$t4 = Run @('--mode','tool-exec','--port',"$P1",'--wsl-home',$priv,'--command','echo sweep-f4') "$Root\out-f4-4-sweep.txt"
$t5 = Run @('--mode','script','--port',"$P1",'--wsl-home',$priv,'--script-b64',([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('echo "after_sweep=$(ls -1 /tmp/dsh-rwsl-999999-f4-* 2>/dev/null | wc -l)"')))) "$Root\out-f4-5-aftersweep.txt"; Show $t5

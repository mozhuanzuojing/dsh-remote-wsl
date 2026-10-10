#!/usr/bin/env pwsh
# fix2-20261010/run-f4-count.ps1 —— task-14 #4 功能面：/tmp 计数（改落文件形态后）仍正确。
# 用**私有 wslHome**；判据是**差值**（造 3 对 = +6），不是全局绝对零（并发下不判他人足迹）。
[CmdletBinding()]
param([int]$Port = 8844)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$node = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
$probe = Join-Path $Root 'probe3.ts'
$priv = "/tmp/rwsl-fix2-$Port"
function Say($m) { Write-Host $m }
function Run([string[]]$a, [string]$log) {
  $q = foreach ($x in $a) { if ($x -match '[\s"]') { '"' + $x.Replace('"', '\"') + '"' } else { $x } }
  $pr = Start-Process -FilePath $node -ArgumentList ('"' + $probe + '" ' + ($q -join ' ')) -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $pr.WaitForExit(240000) | Out-Null
  return ((Get-Content -LiteralPath $log -Raw) -as [string])
}
function TmpLine([string]$t) { (($t -split "`n") | Where-Object { $_ -match 'pid files|/tmp' }) -join ' | ' }
function B64([string]$s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }

Say "  BEFORE: $(TmpLine (Run @('--mode','wsl-status','--port',"$Port",'--wsl-home',$priv) "$Root\out-f4-2b-before.txt"))"
$mk = 'for i in 1 2 3; do printf x > /tmp/dsh-rwsl-999999-f4b-$i.sh; echo 999999 > /tmp/dsh-rwsl-999999-f4b-$i.pid; done; echo made6'
Say "  造 6 个（属主 winpid 999999 已死）: $((Run @('--mode','script','--port',"$Port",'--wsl-home',$priv,'--script-b64',(B64 $mk)) "$Root\out-f4-2c-mk.txt") -split "`n" | Where-Object { $_ -match 'made6' })"
Say "  AFTER+6: $(TmpLine (Run @('--mode','wsl-status','--port',"$Port",'--wsl-home',$priv) "$Root\out-f4-2d-after.txt"))"
$null = Run @('--mode','tool-exec','--port',"$Port",'--wsl-home',$priv,'--command','echo sweep-f4b') "$Root\out-f4-2e-sweep.txt"
Say "  POST-SWEEP: $(TmpLine (Run @('--mode','wsl-status','--port',"$Port",'--wsl-home',$priv) "$Root\out-f4-2f-post.txt"))"
$left = Run @('--mode','script','--port',"$Port",'--wsl-home',$priv,'--script-b64',(B64 'echo "MINE_LEFT=$(ls -1 /tmp/dsh-rwsl-999999-f4b-* 2>/dev/null | wc -l)"')) "$Root\out-f4-2g-left.txt"
Say "  $((($left -split "`n") | Where-Object { $_ -match 'MINE_LEFT' }) -join '')"

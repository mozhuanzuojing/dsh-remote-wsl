#!/usr/bin/env pwsh
# int-20261010/verify-realhost.ps1 —— task-4 #1：两个**真实 DSH 宿主进程**（dsh.cmd CLI）先后调 wsl_agent，
# 同 key 跨宿主续同一 session，并证明期间只有一份守护。
#
# 手法：先由我的夹具在自己的槽位（默认 8755）把守护起好；真实宿主会**发现并复用**该槽位
# （daemon-client 的 listDaemonSlots 扫全部槽位），因此全过程守护都跑在我自己的端口上。
[CmdletBinding()]
param(
  [int]$Port = 8755,
  [string]$Key = 'rv-int-1',
  [string]$Distro = 'debian-u8-1'
)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$node = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
$probe = Join-Path $Root 'probe.ts'
$dsh = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
function Say($m) { Write-Host $m }
function RunProbe([string[]]$a, [string]$log) {
  $q = foreach ($x in $a) { if ($x -match '[\s"]') { '"' + $x.Replace('"', '\"') + '"' } else { $x } }
  $cmd = '"' + $probe + '" ' + ($q -join ' ')
  $p = Start-Process -FilePath $node -ArgumentList $cmd -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $p.WaitForExit()
  return $p.ExitCode
}
function ShowLog([string]$log) { if (Test-Path $log) { Get-Content -LiteralPath $log | ForEach-Object { Say "  $_" } } }
function WslCounts {
  $s = 'echo "daemon_ts=$(pgrep -cf -- ''daemon\.t[s]'' || true)"; echo "profile_sdk=$(pgrep -cf -- ''profile sd[k]'' || true)"; echo "listen8755=$(ss -ltn | grep -c '':8755 '')"'
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))
  return ((& wsl.exe -d $Distro -u g -- bash -c "echo $b64 | base64 -d | bash" 2>&1) -join '  ')
}

Say "################ 0) 起/复用我自己的守护（槽位 $Port）################"
Say "  probe exit=$(RunProbe @('--mode','daemon','--action','start','--port',"$Port") (Join-Path $Root 'out-12a-daemon-start.txt'))"
ShowLog (Join-Path $Root 'out-12a-daemon-start.txt')
Say "  WSL: $(WslCounts)"

$p1 = "调用 wsl_agent 工具，参数 key='$Key'，task='记住数字 41。只回复 ACK'。然后把它返回的尾注（以 [remote-wsl: 开头那一行）**原样**贴给我，不要改写。"
$p2 = "再调用一次 wsl_agent 工具，参数 key 仍为 '$Key'，task='刚才让你记的数字？只回数字'。把它的**原始返回**（含尾注）原样贴给我。"

Say "`n################ 1) 真实宿主进程 #1：$dsh --profile remote-wsl-test ################"
$log1 = Join-Path $Root 'out-12b-host1.txt'
$sw = [Diagnostics.Stopwatch]::StartNew()
& $dsh --profile remote-wsl-test $p1 *>&1 | Out-File -Encoding utf8 $log1
$sw.Stop()
Say "  dsh exit=$LASTEXITCODE elapsed_ms=$($sw.ElapsedMilliseconds)"
ShowLog $log1

Say "`n################ 2) 宿主 #1 退出后守护状态（另一进程读取）################"
Say "  probe exit=$(RunProbe @('--mode','daemon','--action','status','--port',"$Port") (Join-Path $Root 'out-12c-status-after-host1.txt'))"
ShowLog (Join-Path $Root 'out-12c-status-after-host1.txt')
Say "  WSL: $(WslCounts)"

Say "`n################ 3) 真实宿主进程 #2（另一个独立进程）################"
$log2 = Join-Path $Root 'out-12d-host2.txt'
$sw2 = [Diagnostics.Stopwatch]::StartNew()
& $dsh --profile remote-wsl-test $p2 *>&1 | Out-File -Encoding utf8 $log2
$sw2.Stop()
Say "  dsh exit=$LASTEXITCODE elapsed_ms=$($sw2.ElapsedMilliseconds)"
ShowLog $log2

Say "`n################ 4) 两个宿主之后：同一份守护 / 同一 session ################"
Say "  probe exit=$(RunProbe @('--mode','daemon','--action','status','--port',"$Port") (Join-Path $Root 'out-12e-status-after-host2.txt'))"
ShowLog (Join-Path $Root 'out-12e-status-after-host2.txt')
Say "  WSL: $(WslCounts)"

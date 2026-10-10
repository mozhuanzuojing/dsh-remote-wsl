#!/usr/bin/env pwsh
# fix2-20261010/run-regression.ps1 —— task-14 #5/#7：夹具回归 + 真宿主 e2e + 故障注入。
# 夹具在 %TEMP%\rwsl-test（其 P0 闸门会打印 7 行 MATCH/MISMATCH；跑前必须 7/7 MATCH）。
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$node = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
$fx = "$env:TEMP\rwsl-test"
$dsh = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
function Say($m) { Write-Host $m }
function RunFx([string]$file, [string]$log, [int]$timeoutMs, [string]$failEnv) {
  if ($failEnv) { Set-Item -Path env:ADV_FORCE_FAIL -Value $failEnv }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $pr = Start-Process -FilePath $node -ArgumentList ('"' + $file + '"') -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $done = $pr.WaitForExit($timeoutMs); $sw.Stop()
  if (-not $done) { try { $pr.Kill() } catch {} }
  if ($failEnv) { Remove-Item env:ADV_FORCE_FAIL -ErrorAction SilentlyContinue }
  return [pscustomobject]@{ Exit = $(if ($done) { $pr.ExitCode } else { 'TIMEOUT' }); Ms = $sw.ElapsedMilliseconds }
}

Say "################ A) 夹具 P0 副本身份闸门 + test.ts ################"
$r = RunFx "$fx\test.ts" "$Root\out-03a-test.txt" 300000 $null
Say "  exit=$($r.Exit) ms=$($r.Ms)"
$txt = Get-Content "$Root\out-03a-test.txt" -Raw
Say "  --- P0 闸门行 ---"
($txt -split "`n") | Where-Object { $_ -match 'MATCH|MISMATCH|P0' } | ForEach-Object { Say "    $_" }
Say "  --- 不变量 ---"
foreach ($inv in @('注册工具: wsl_status, wsl_exec, wsl_agent, wsl_daemon, wsl_open_ui, wsl_sync_version', 'warm 0.2.0-rc.2: ok', 'cleanup disposers=1', 'backend=daemon')) {
  Say ("    {0,-88} => {1}" -f $inv, ($txt -match [regex]::Escape($inv)))
}
Say "    T3 两轮答 7 => $([bool]($txt -match '(?m)^7\r?$'))"
Say "  stderr 前 3 行:"; Get-Content "$Root\out-03a-test.txt.err" -ErrorAction SilentlyContinue | Select-Object -First 3 | ForEach-Object { Say "    $_" }

Say "`n################ B) adversarial.ts（应全 PASS；含 Z3/Z4/Z5 与 P0）################"
$r2 = RunFx "$fx\adversarial.ts" "$Root\out-03b-adversarial.txt" 420000 $null
Say "  exit=$($r2.Exit) ms=$($r2.Ms)"
($txt2 = Get-Content "$Root\out-03b-adversarial.txt" -Raw) | Out-Null
Get-Content "$Root\out-03b-adversarial.txt" | Where-Object { $_ -match '^(PASS|FAIL) .*(Z[0-9]|P0)|断言汇总|^FAIL' } | ForEach-Object { Say "    $_" }
Say "  --- 全部 FAIL 行 ---"; (Get-Content "$Root\out-03b-adversarial.txt" | Where-Object { $_ -match '^FAIL' }) | ForEach-Object { Say "    $_" }

Say "`n################ C) 真宿主 e2e ################"
$sw = [Diagnostics.Stopwatch]::StartNew()
& $dsh --profile remote-wsl-test '调用 wsl_status 工具，把 daemon 行与 backend 行原样贴给我。' *> "$Root\out-03c-e2e.txt"
$sw.Stop()
Say "  exit=$LASTEXITCODE ms=$($sw.ElapsedMilliseconds) 导入错误=$(@(Select-String -Path "$Root\out-03c-e2e.txt" -Pattern 'failed to import|ERR_MODULE|Cannot find module').Count)"
(Get-Content "$Root\out-03c-e2e.txt") | Where-Object { $_ -match 'daemon:|backend:' } | Select-Object -First 3 | ForEach-Object { Say "    $_" }

Say "`n################ D) ADV_FORCE_FAIL=1 仍能红 ################"
$r3 = RunFx "$fx\adversarial.ts" "$Root\out-03d-adversarial-forcefail.txt" 420000 '1'
Say "  exit=$($r3.Exit) ms=$($r3.Ms)（期望非 0）"
Get-Content "$Root\out-03d-adversarial-forcefail.txt" | Where-Object { $_ -match '故障注入|^FAIL|断言汇总' } | Select-Object -First 6 | ForEach-Object { Say "    $_" }

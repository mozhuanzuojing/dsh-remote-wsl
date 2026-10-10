#!/usr/bin/env pwsh
# fix3-20261010/run-regression3.ps1 —— task-16 #4（P0 闸门必须"副作用前红"）+ #5 回归。
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$node = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
$fx = "$env:TEMP\rwsl-test"
$src = 'D:\project\dsh1\vendor\dsh-remote-wsl\src'
$dsh = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$script:Fails = @()
function Say($m) { Write-Host $m }
function Check([bool]$c, [string]$m) { if ($c) { Say "  [PASS] $m" } else { Say "  [FAIL] $m"; $script:Fails += $m } }
function Wsl([string]$s) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))
  return @((& wsl.exe -d debian-u8-1 -u g -- bash -c "echo $b64 | base64 -d | bash" 2>&1) | ForEach-Object { "$_" })
}
function Counts {
  $r = Wsl @'
echo "tmp=$(find /tmp -maxdepth 1 -name 'dsh-rwsl-*' | wc -l)"
echo "own_daemons=$(for p in $(pgrep -f -- 'daemon\.t[s]' 2>/dev/null); do c=$(tr '\0' ' ' < /proc/$p/cmdline); case "$c" in *"--state-dir /home/g/.dsh/remote-wsl "*) echo x;; esac; done | wc -l)"
'@
  return ($r -join ' ')
}
function RunFx([string]$file, [string]$log, [int]$timeoutMs, [string]$failEnv) {
  if ($failEnv) { Set-Item -Path env:ADV_FORCE_FAIL -Value $failEnv }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $pr = Start-Process -FilePath $node -ArgumentList ('"' + $file + '"') -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $done = $pr.WaitForExit($timeoutMs); $sw.Stop()
  if (-not $done) { try { $pr.Kill() } catch {} }
  if ($failEnv) { Remove-Item env:ADV_FORCE_FAIL -ErrorAction SilentlyContinue }
  return [pscustomobject]@{ Exit = $(if ($done) { $pr.ExitCode } else { 'TIMEOUT' }); Ms = $sw.ElapsedMilliseconds }
}
function Hash7 {
  $h = @{}
  foreach ($f in @('index.ts','daemon.ts','daemon-client.ts','sdk-runtime.ts','selftest.ts','shell-env.ts','version.ts')) {
    $h[$f] = (Get-FileHash "$src\$f" -Algorithm SHA256).Hash
  }
  return $h
}

Say "################ #4) P0 闸门：故意让副本与 src 不一致 ⇒ 必须在任何 WSL 副作用前红 ################"
$before = Counts
Say "  改动前现场: $before"
$orig = Get-Content "$fx\lib\index.ts" -Raw
try {
  Add-Content -LiteralPath "$fx\lib\index.ts" -Value "`n// task-16 P0 故意污染（随后恢复）`n"
  Say "  已污染 %TEMP%\rwsl-test\lib\index.ts（追加一行注释，字节数 $( (Get-Item "$fx\lib\index.ts").Length )）"
  $r = RunFx "$fx\test.ts" "$Root\out-04a-p0-desync.txt" 120000 $null
  Say "  test.ts exit=$($r.Exit) ms=$($r.Ms)（期望非 0）"
  $t = Get-Content "$Root\out-04a-p0-desync.txt" -Raw
  ($t -split "`n") | Where-Object { $_ -match 'MISMATCH|MATCH|P0' } | Select-Object -First 10 | ForEach-Object { Say "    $_" }
  $after = Counts
  Say "  改动后现场: $after"
  Check ($r.Exit -ne 0) "夹具非 0 退出（闸门生效）"
  Check ($t -match 'MISMATCH') "打印 MISMATCH 行"
  Check (($after -eq $before)) "**在任何 WSL 副作用之前**就红了（/tmp 计数与 daemon 数均未变：$after）"
} finally {
  [IO.File]::WriteAllText("$fx\lib\index.ts", $orig, [Text.UTF8Encoding]::new($false))
  $srcHash = (Get-FileHash "$src\index.ts" -Algorithm SHA256).Hash
  $cpHash = (Get-FileHash "$fx\lib\index.ts" -Algorithm SHA256).Hash
  Say "  已恢复副本：SHA256 与 src 相同 = $($srcHash -eq $cpHash)"
}

Say "`n################ #5a) test.ts（恢复后应全过）################"
$r1 = RunFx "$fx\test.ts" "$Root\out-04b-test.txt" 300000 $null
Say "  exit=$($r1.Exit) ms=$($r1.Ms)"
(Get-Content "$Root\out-04b-test.txt") | Where-Object { $_ -match 'P0 前置|MATCH|注册工具|warm|cleanup disposers' } | Select-Object -First 6 | ForEach-Object { Say "    $_" }
Check ($r1.Exit -eq 0) "test.ts exit 0"

Say "`n################ #5b) adversarial.ts ################"
$r2 = RunFx "$fx\adversarial.ts" "$Root\out-04c-adversarial.txt" 420000 $null
Say "  exit=$($r2.Exit) ms=$($r2.Ms)"
(Get-Content "$Root\out-04c-adversarial.txt") | Where-Object { $_ -match '断言汇总|^FAIL|Z4 ' } | ForEach-Object { Say "    $_" }
Check ($r2.Exit -eq 0) "adversarial exit 0（0 FAIL）"

Say "`n################ #5c) 真宿主 e2e ################"
$sw = [Diagnostics.Stopwatch]::StartNew()
& $dsh --profile remote-wsl-test '调用 wsl_status 工具，把 daemon 那一行原样贴给我。' *> "$Root\out-04d-e2e.txt"
$sw.Stop()
Say "  exit=$LASTEXITCODE ms=$($sw.ElapsedMilliseconds) 导入错误=$(@(Select-String -Path "$Root\out-04d-e2e.txt" -Pattern 'failed to import|ERR_MODULE').Count)"
Check ($LASTEXITCODE -eq 0) "真宿主 e2e exit 0"

Say "`n################ #5d) ADV_FORCE_FAIL=1 ################"
$r3 = RunFx "$fx\adversarial.ts" "$Root\out-04e-forcefail.txt" 420000 '1'
Say "  exit=$($r3.Exit) ms=$($r3.Ms)（期望非 0）"
Check ($r3.Exit -ne 0) "故障注入仍能红"

Say ''
if ($script:Fails.Count -eq 0) { Say 'RUN-REG3: ALL CHECKS PASSED'; exit 0 }
Say "RUN-REG3: $($script:Fails.Count) CHECK(S) FAILED"; $script:Fails | ForEach-Object { Say "  - $_" }; exit 1

#!/usr/bin/env pwsh
# probe-listdir.ps1 —— T14：`explorer.listDir` 的安全面 + `/mnt` 映射 + 状态码成对 + 零副作用 + 确定性。
#
# 依据（实现，T13）：
#   · EXPLORER_METHODS 含 'explorer.listDir'；校验只接受干净 WSL 绝对 POSIX 路径（空/NUL/相对/反斜杠/`..` 段 ⇒ E_ARG 400）
#   · `/mnt/<letter>[/...]` 经 `windowsDriveForMount()` 映射到 `C:\…`（因 9p 不暴露 drvfs 挂载根，UNC 列不出 `/mnt/c`）；其余走 UNC
#   · 路径不存在/不是目录 ⇒ `E_NOTFOUND`(404) 且 body 带该 path；`STATUS_BY_CODE = {E_ARG:400, E_NOTFOUND:404, E_UNAVAILABLE:503}`
[CmdletBinding()]
param(
  [int]$Port = 8931,
  [int]$Slot = 8932,
  [string]$OutDir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
$route = "http://127.0.0.1:$Port/remote-wsl/api"
$origin = "http://127.0.0.1:$Port"
$log = New-Object System.Text.StringBuilder
function W($m) { [void]$log.AppendLine($m); Write-Host $m }
function WslB([string]$s) { $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)); return ((& wsl.exe -d debian-u8-1 -u g -- bash -c "echo $b | base64 -d | bash") 2>&1) -join "`n" }

function Post([string]$json, $headers) {
  try {
    $r = Invoke-WebRequest $route -Method POST -Headers $headers -ContentType 'application/json' -Body $json -UseBasicParsing -TimeoutSec 60 -SkipHttpErrorCheck
    return [pscustomobject]@{ status = [int]$r.StatusCode; body = $r.Content }
  } catch { return [pscustomobject]@{ status = -1; body = $_.Exception.Message } }
}
function LD($path, [switch]$NoOrigin) {
  $obj = [ordered]@{ method = 'explorer.listDir'; args = [ordered]@{ path = $path } }
  $j = $obj | ConvertTo-Json -Depth 6 -Compress
  $h = if ($NoOrigin) { @{} } else { @{ Origin = $origin } }
  return (Post $j $h)
}
function Parse($body) { try { return ($body | ConvertFrom-Json) } catch { return $null } }
function Names($obj) { if ($null -eq $obj -or $null -eq $obj.result) { return $null }; return @($obj.result.entries | ForEach-Object { $_.name }) }

$fail = 0
function Assert-Status($label, $got, $want) { $ok = ($got -eq $want); if (-not $ok) { $script:fail++ }; W ("  [{0}] {1} → {2} (期望 {3})" -f $(if ($ok) { 'PASS' } else { 'RED' }), $label, $got, $want) }

W "############ listDir 复验（$route）$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ############"

# ── 0) 白名单：GET methods 必须含 explorer.listDir
$r = Invoke-WebRequest $route -Method GET -Headers @{ Origin = $origin } -UseBasicParsing -TimeoutSec 30
$methods = @(($r.Content | ConvertFrom-Json).methods)
W "`n[0] GET methods = $($methods -join ', ')"
Assert-Status 'methods 含 explorer.listDir' ($methods -contains 'explorer.listDir') $true

# ── 1) 零副作用基线
$factsBefore = Join-Path $OutDir 'out-72-listdir-facts-before.json'
& (Join-Path $OutDir 'daemon-invariance.ps1') -Mode Capture -Port $Slot -Out $factsBefore | Out-Null
$wslProcBefore = (WslB "ls -1 /proc | grep -c '^[0-9]*$'").Trim() -replace '[^\d]', ''
$tmpBefore = (WslB "ls -1 /tmp 2>/dev/null | wc -l").Trim() -replace '[^\d]', ''
W "`n[1] 基线：WSL 进程数=$wslProcBefore  /tmp 条目=$tmpBefore"

# ── 2) 伪造/缺失 Origin ⇒ 403（且未执行）
$b = LD '/home/g' -NoOrigin;  W "`n[2] 缺失 Origin → $($b.status)";  Assert-Status '缺 Origin=403' $b.status 403
$b2 = Post '{"method":"explorer.listDir","args":{"path":"/home/g"}}' @{ Origin = 'http://evil.example' }
W "    伪造 Origin → $($b2.status)"; Assert-Status '伪造 Origin=403' $b2.status 403

# ── 3) 正向对照 + 合法路径
W "`n[3] 合法路径（正向对照）"
$legal = @('/', '/home/g', '/home/g/project/dsh1', '/mnt', '/mnt/c', '/mnt/d', '/mnt/c/Users', '/mnt/wslg')
$legalRes = [ordered]@{}
foreach ($p in $legal) {
  $x = LD $p; $o = Parse $x.body; $n = Names $o
  $legalRes[$p] = [ordered]@{ status = $x.status; count = $(if ($null -ne $n) { @($n).Count } else { $null }); first = $(if ($null -ne $n -and @($n).Count) { @($n)[0] } else { $null }) }
  W ("  {0,-22} status={1} 条目={2} 首项={3}" -f $p, $x.status, $(if ($null -ne $n) { @($n).Count } else { 'n/a' }), $(if ($null -ne $n -and @($n).Count) { @($n)[0] } else { '-' }))
  if ($p -ne '/mnt/z') { Assert-Status "合法 $p = 200" $x.status 200 }
}
($legalRes | ConvertTo-Json -Depth 6) | Set-Content (Join-Path $OutDir 'out-72-listdir-legal.json') -Encoding utf8

# ── 4) /mnt/<盘符> 映射一致性：listDir('/mnt/c') 名字集合 vs Windows C:\
W "`n[4] 盘符映射一致性"
$cNames = @(Get-ChildItem -Force 'C:\' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
$o = Parse (LD '/mnt/c').body; $lc = Names $o
$onlyWsl = @($lc | Where-Object { $cNames -notcontains $_ })
$onlyWin = @($cNames | Where-Object { $lc -notcontains $_ })
W ("  listDir('/mnt/c') 条目={0} ｜ C:\ 条目={1} ｜ 仅WSL侧={2} ｜ 仅Windows侧={3}" -f @($lc).Count, $cNames.Count, ($onlyWsl -join ','), ($onlyWin -join ','))
Assert-Status "映射集合相等" ($onlyWsl.Count -eq 0 -and $onlyWin.Count -eq 0) $true
$o2 = Parse (LD '/mnt/c/Users').body; $n2 = Names $o2
$uNames = @(Get-ChildItem -Force 'C:\Users' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
$d1 = @($n2 | Where-Object { $uNames -notcontains $_ }); $d2 = @($uNames | Where-Object { $n2 -notcontains $_ })
W ("  listDir('/mnt/c/Users') 条目={0} ｜ C:\Users 条目={1} ｜ 差集={2}/{3}" -f @($n2).Count, $uNames.Count, ($d1 -join ','), ($d2 -join ','))
Assert-Status "Users 映射集合相等" ($d1.Count -eq 0 -and $d2.Count -eq 0) $true

# ── 5) /mnt/z（不存在的盘）与 /mnt/wslg（不是盘符）
W "`n[5] 边界挂载"
$z = LD '/mnt/z'; $zo = Parse $z.body
W ("  /mnt/z → status={0} code={1} body={2}" -f $z.status, $(if ($zo) { $zo.code } else { '-' }), ($z.body -replace '\s+', ' ').Substring(0, [Math]::Min(160, ($z.body -replace '\s+', ' ').Length)))
Assert-Status '/mnt/z 可读错误（≠200）' ($z.status -ne 200 -and $z.status -ne -1) $true
$wslg = Parse (LD '/mnt/wslg').body
W ("  /mnt/wslg → status=200 条目数={0}（应为 UNC 路线，不是盘符）" -f @((Names $wslg)).Count)

# ── 6) 非法形态 ⇒ 400 E_ARG 且不得返回条目
W "`n[6] 非法形态 ⇒ 400 E_ARG"
$bad = [ordered]@{}
$cases = [ordered]@{}
$cases['../etc'] = '../etc'; $cases['相对路径 foo'] = 'foo'; $cases['空串'] = ''
$cases['反斜杠'] = '/home/g\etc'; $cases['..-段'] = '/home/../etc'; $cases['NUL'] = ("/home/g" + [char]0 + "x"); $cases['Windows 盘符'] = 'C:\Users'
foreach ($k in $cases.Keys) {
  $x = LD $cases[$k]; $o = Parse $x.body
  $hasEntries = ($null -ne $o -and $null -ne $o.result -and $null -ne $o.result.entries)
  W ("  {0,-14} status={1} code={2} 含条目={3}" -f $k, $x.status, $(if ($o) { $o.code } else { '-' }), $hasEntries)
  $bad[$k] = [ordered]@{ status = $x.status; code = $(if ($o) { $o.code } else { $null }); returnedEntries = $hasEntries }
  Assert-Status "$k = 400" $x.status 400
  Assert-Status "$k 不返回条目" $hasEntries $false
}
($bad | ConvertTo-Json -Depth 6) | Set-Content (Join-Path $OutDir 'out-73-listdir-bad.json') -Encoding utf8

# ── 7) 路径不存在 ⇒ 404 且 body 含 path
W "`n[7] 路径不存在 ⇒ 404（body 必须含该 path）"
$miss = '/home/g/no-such-dir-xyz-t14'
$x = LD $miss; $o = Parse $x.body
$contains = ($x.body -match [regex]::Escape($miss))
W ("  status={0} code={1} body 含 path={2}" -f $x.status, $(if ($o) { $o.code } else { '-' }), $contains)
W ("  body: " + ($x.body -replace '\s+', ' '))
Assert-Status '不存在路径 = 404' $x.status 404
Assert-Status 'body 含该 path' $contains $true

# ── 8) 确定性顺序（两次逐字相同）
W "`n[8] 确定性顺序"
$a1 = (LD '/home/g').body; $a2 = (LD '/home/g').body
$same = ($a1 -eq $a2)
W ("  两次 body 相同={0}" -f $same)
Assert-Status '同路径两次逐字相同' $same $true
$ord = Names (Parse $a1)
W ("  观察到的顺序（前 8）：" + ((@($ord) | Select-Object -First 8) -join ', '))

# ── 9) 零副作用（调用后再采一次）
# ⚠️ 自查修复：compare 的 stdout 不能重定向到它**自己会写**的 .txt（会撞文件锁，导致后面的日志写不出来）
$factsAfter = Join-Path $OutDir 'out-72-listdir-facts-after.json'
& (Join-Path $OutDir 'daemon-invariance.ps1') -Mode Capture -Port $Slot -Out $factsAfter | Out-Null
& (Join-Path $OutDir 'daemon-invariance.ps1') -Mode Compare -Before $factsBefore -After $factsAfter -OutFile (Join-Path $OutDir 'out-72-listdir-nosideeffect.json') *> (Join-Path $OutDir 'out-72-listdir-nosideeffect.log')
$cmpExit = $LASTEXITCODE
$wslProcAfter = (WslB "ls -1 /proc | grep -c '^[0-9]*$'").Trim() -replace '[^\d]', ''
$tmpAfter = (WslB "ls -1 /tmp 2>/dev/null | wc -l").Trim() -replace '[^\d]', ''
W "`n[9] 零副作用：daemon facts compare exit=$cmpExit（期望 0）｜WSL 进程 $wslProcBefore→$wslProcAfter ｜/tmp $tmpBefore→$tmpAfter"
Assert-Status 'daemon facts 不变 exit=0' $cmpExit 0

W "`n############ 汇总：失败断言数 = $fail ############"
Set-Content (Join-Path $OutDir 'out-72-listdir-probe.txt') -Value $log.ToString() -Encoding utf8
exit $(if ($fail -gt 0) { 1 } else { 0 })

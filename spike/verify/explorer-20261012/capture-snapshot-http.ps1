#!/usr/bin/env pwsh
# capture-snapshot-http.ps1 —— ③ 的**第三条**（也是最确定的一条）真相面：host 注册的 webServer 路由。
#
# 依据：docs/client-contract.md §4.2 —— 静态 client 半**没有** `host.call`，取数走
#   host `ctx.inject(["webServer"], …)` + `webServer.register({kind,path,handler})` + 浏览器同源 `fetch`。
# 因此面板拿到的 JSON 一定能在 HTTP 上直接取到。本脚本把它落盘，用于：
#   - ③ 三方比对（面板 DOM  vs  wsl_status  vs  route JSON）
#   - ⑥ `explorer.openSession` 的无副作用检查（默认路径 + 若 UI 暴露则 warm 路径）
#
# 用法：
#   ./capture-snapshot-http.ps1 -Port 8931 -Path /remote-wsl/api -Action snapshot -Out out-25-snapshot.json
#   ./capture-snapshot-http.ps1 -Port 8931 -Path /remote-wsl/api -Action openSession -Body '{"path":"/home/g/dsh1"}' -Out out-30-opensession-return.json
# 纪律：路径未知就先 `-Probe`（对若干候选路径逐个 GET/POST 并打印状态码），把实测结果记进 RUNBOOK，不要猜。
[CmdletBinding()]
param(
  [int]$Port = 8931,
  [string]$Path = '/remote-wsl/api',
  [ValidateSet('GET', 'POST')][string]$Method = 'GET',
  [string]$Action = 'snapshot',
  [string]$Body,
  [string]$Out,
  [switch]$Probe,
  [string[]]$ProbePaths = @('/remote-wsl/api', '/remote-wsl/api/snapshot', '/remote-wsl/snapshot', '/rwsl/api', '/plugins/remote-wsl/api'),
  [string]$OutDir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"

function Call([string]$m, [string]$p, [string]$body) {
  # 注意：`$p?action` 会被 PS 当成变量名 `p?action`！必须写成 ${p}
  $uri = "${base}${p}?action=$Action"
  $params = @{ Uri = $uri; Method = $m; UseBasicParsing = $true; TimeoutSec = 20 }
  if ($body) { $params.Body = $body; $params.ContentType = 'application/json' }
  try {
    $r = Invoke-WebRequest @params
    return [pscustomobject]@{ ok = $true; status = $r.StatusCode; body = $r.Content; uri = $uri }
  } catch {
    $sc = $null
    try { $sc = $_.Exception.Response.StatusCode.value__ } catch {}
    return [pscustomobject]@{ ok = $false; status = $sc; body = "$($_.Exception.Message)"; uri = $uri }
  }
}

if ($Probe) {
  Write-Host "=== 路径探测（$base）——先探再定，不要猜 ==="
  foreach ($p in $ProbePaths) {
    foreach ($m in @('GET', 'POST')) {
      $r = Call $m $p $(if ($m -eq 'POST') { '{}' } else { $null })
      Write-Host ("  {0,-4} {1,-32} status={2} ok={3}  {4}" -f $m, $p, $r.status, $r.ok, ($r.body -replace '\s+', ' ').Substring(0, [Math]::Min(120, ($r.body -replace '\s+', ' ').Length)))
    }
  }
  exit 0
}

$r = Call $Method $Path $Body
if (-not $Out) { $Out = Join-Path $OutDir 'out-25-snapshot-http.json' }
$payload = [ordered]@{
  capturedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
  uri = $r.uri; method = $Method; status = $r.status; ok = $r.ok
  bodyRaw = $r.body
  bodyJson = $null
}
try { $payload.bodyJson = ($r.body | ConvertFrom-Json) } catch { }
($payload | ConvertTo-Json -Depth 12) | Set-Content -LiteralPath $Out -Encoding utf8
Write-Host "status=$($r.status) ok=$($r.ok) -> $Out"
Write-Host ($r.body -replace '\s+', ' ').Substring(0, [Math]::Min(1500, ($r.body -replace '\s+', ' ').Length))
if (-not $r.ok) { exit 3 }
exit 0

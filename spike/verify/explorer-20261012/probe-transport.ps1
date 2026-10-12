#!/usr/bin/env pwsh
# probe-transport.ps1 —— task-4 **B 组：传输安全 5 条** + 验收③ 的第三条真相面（route JSON）。
#
# 被验路由（实测自 src/explorer.ts 头部注释 + host 日志）：POST /remote-wsl/api
#   body {"method":"explorer.snapshot","args":{}} → 200 {"ok":true,"result":…}；GET → 200 {"ok":true,"methods":[…]}（要 Origin）
#   同源判定：Origin 必须存在且其 host[:port] 与请求 Host 逐字相同；带 Sec-Fetch-Site 时必须 same-origin；否则 403 且**一个方法都不执行**
#   方法白名单：snapshot / openSession / daemon / fixPin；未知 ⇒ 400
#   动词/类型：GET=方法发现；其它动词 ⇒ 405；POST 无 application/json ⇒ **415**（任务文本写的是 405 —— 差异会如实记录）
#   E_ARG ⇒ 400；E_UNAVAILABLE ⇒ 503
#
# 用法：./probe-transport.ps1 -Port 8931 [-Slot 8932]
[CmdletBinding()]
param(
  [int]$Port = 8931,
  [int]$Slot = 8932,
  [string]$OutDir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"
$route = "$base/remote-wsl/api"
$sameOrigin = "http://127.0.0.1:$Port"
$log = New-Object System.Text.StringBuilder
function W($m) { [void]$log.AppendLine($m); Write-Host $m }
function WslBash([string]$s) { $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)); return ((& wsl.exe -d debian-u8-1 -u g -- bash -c "echo $b | base64 -d | bash") 2>&1) -join "`n" }
# ⚠️ wsl.exe 会把 "检测到 localhost 代理配置…" 这类**警告**混进 stdout（多行、带字符间空格）。
# 直接字符串比较会被噪声污染（曾导致阳性对照被误判 False）。⇒ 只从"行首是 PID / 行首是纯数字"的行取事实。
function WslPids([int]$slot) { $o = WslBash "pgrep -af 'daemon\.t[s] --port $slot' || true"; return @($o -split "`n" | Where-Object { $_ -match '^\s*\d+\s' } | ForEach-Object { [int]($_ -replace '^\s*(\d+)\s.*$', '$1') }) }
function WslListenCount([int]$slot) { $o = WslBash "ss -ltn 2>/dev/null | grep -c ':$slot ' || true"; $m = [regex]::Matches($o, '(?m)^\s*(\d+)\s*$'); if ($m.Count -eq 0) { return -1 }; return [int]$m[$m.Count - 1].Groups[1].Value }
function Call([string]$method, [string]$body, [hashtable]$headers, [string]$contentType) {
  $p = @{ Uri = $route; Method = $method; UseBasicParsing = $true; TimeoutSec = 30; Headers = $headers }
  if ($contentType) { $p.ContentType = $contentType }
  if ($body) { $p.Body = $body }
  try {
    $r = Invoke-WebRequest @p
    return [pscustomobject]@{ status = [int]$r.StatusCode; body = $r.Content; raw = $null }
  } catch {
    $resp = $_.Exception.Response
    $st = $null; $bd = ''
    if ($resp) {
      try { $st = [int]$resp.StatusCode } catch {}
      try { $sr = New-Object System.IO.StreamReader($resp.GetResponseStream()); $bd = $sr.ReadToEnd() } catch {}
    }
    return [pscustomobject]@{ status = $st; body = $bd; raw = $_.Exception.Message }
  }
}
function Mk([string]$origin, [switch]$json) {
  $h = @{}
  if ($origin) { $h['Origin'] = $origin }
  return @{ Headers = $h; Json = $json }
}

$results = [ordered]@{}
W "############ B 组：传输安全（$route） ############"
W "时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  同源 Origin=$sameOrigin"

# ---- 前置：确认我方槽位此刻**无**守护（用于 b 的"未执行"阴性判据）----
$prePids = @(WslPids $Slot)
$preListen = WslListenCount $Slot
W "`n[前置] 我方槽位 $Slot 起守护前：pids=[$($prePids -join ',')]  listen_count=$preListen"

# ---- a) 同源 POST → 200 ----
$r = Call 'POST' '{"method":"explorer.snapshot","args":{}}' @{ Origin = $sameOrigin } 'application/json'
W "`n[a] 同源 POST explorer.snapshot → status=$($r.status)"
W ("    body(head 600): " + ($r.body -replace '\s+', ' ').Substring(0, [Math]::Min(600, ($r.body -replace '\s+', ' ').Length)))
$results['a_same_origin_post'] = $r.status
$snap = $null; try { $snap = $r.body | ConvertFrom-Json } catch {}
if ($snap) { ($snap | ConvertTo-Json -Depth 12) | Set-Content -LiteralPath (Join-Path $OutDir 'out-25-snapshot-http.json') -Encoding utf8 }

# ---- a2) GET 无 Origin → 403；带 Origin → 200（方法清单） ----
$r = Call 'GET' $null @{} $null
W "`n[a2] GET 无 Origin → status=$($r.status)  body=$($r.body -replace '\s+', ' ')"
$resGetNoOrigin = $r.status
$r = Call 'GET' $null @{ Origin = $sameOrigin } $null
W "[a2] GET 带同源 Origin → status=$($r.status)  body=$($r.body -replace '\s+', ' ')"
$methods = $null; try { $methods = ($r.body | ConvertFrom-Json).methods } catch {}

# ---- b) 伪造 Origin → 403 **且方法未执行**（用有副作用的 daemon ensure 试） ----
$b403 = Call 'POST' '{"method":"explorer.daemon","args":{"action":"ensure"}}' @{ Origin = 'http://evil.example' } 'application/json'
W "`n[b] 伪造 Origin 的 daemon ensure → status=$($b403.status)  body=$($b403.body -replace '\s+', ' ')"
Start-Sleep -Seconds 2
$afterForgedPids = @(WslPids $Slot)
$afterForgedListen = WslListenCount $Slot
W "    伪造后：pids=[$($afterForgedPids -join ',')]  listen_count=$afterForgedListen  （必须与前置相同 = 未执行）"
$results['b_forged_origin'] = $b403.status
$results['b_side_effect_none'] = (($afterForgedListen -eq $preListen) -and (@($afterForgedPids).Count -eq @($prePids).Count))

# ---- b-missing) 缺 Origin → 403 ----
$bMiss = Call 'POST' '{"method":"explorer.daemon","args":{"action":"ensure"}}' @{} 'application/json'
W "[b-missing] 缺 Origin 的 daemon ensure → status=$($bMiss.status)  body=$($bMiss.body -replace '\s+', ' ')"
$results['b_missing_origin'] = $bMiss.status
$bBadSite = Call 'POST' '{"method":"explorer.snapshot","args":{}}' @{ Origin = $sameOrigin; 'Sec-Fetch-Site' = 'cross-site' } 'application/json'
W "[b-site] 同源 Origin 但 Sec-Fetch-Site: cross-site → status=$($bBadSite.status)  body=$($bBadSite.body -replace '\s+', ' ')"

# ---- b-positive) 阳性对照：同源 ensure 必须**真的执行**（证明上面的"未执行"不是方法本身坏了） ----
$bPos = Call 'POST' '{"method":"explorer.daemon","args":{"action":"ensure"}}' @{ Origin = $sameOrigin } 'application/json'
W "`n[b-positive] 同源 daemon ensure → status=$($bPos.status)  body=$($bPos.body -replace '\s+', ' ')"
$deadline = (Get-Date).AddSeconds(45); $posListen = -1
while ((Get-Date) -lt $deadline) { Start-Sleep -Seconds 2; $posListen = WslListenCount $Slot; if ($posListen -eq 1) { break } }
$posPids = @(WslPids $Slot)
W "    阳性对照结果：listen_count=$posListen  pids=[$($posPids -join ',')]  ⇒ 同源调用确实能起我方守护（证明 [b] 的阴性判据有区分力）"
$results['b_positive_control_ok'] = ($posListen -eq 1 -and @($posPids).Count -ge 1)
$results['b_negative_control_clean'] = (@($prePids).Count -eq 0 -and $preListen -eq 0)

# ---- c) 未知 method → 400 ----
$c = Call 'POST' '{"method":"explorer.__nope__","args":{}}' @{ Origin = $sameOrigin } 'application/json'
W "`n[c] 未知 method → status=$($c.status)  body=$($c.body -replace '\s+', ' ')"
$results['c_unknown_method'] = $c.status
$c2 = Call 'POST' '{"method":"constructor","args":{}}' @{ Origin = $sameOrigin } 'application/json'
W "[c2] 原型链探针 method='constructor' → status=$($c2.status)  body=$($c2.body -replace '\s+', ' ')"
$c3 = Call 'POST' '{"args":{}}' @{ Origin = $sameOrigin } 'application/json'
W "[c3] 空 method → status=$($c3.status)"

# ---- d) 动词/类型 ----
foreach ($v in @('PUT', 'DELETE', 'PATCH')) {
  $rd = Call $v '{}' @{ Origin = $sameOrigin } 'application/json'
  W "`n[d] $v → status=$($rd.status)  body=$($rd.body -replace '\s+', ' ')"
  $results["d_verb_$v"] = $rd.status
}
$d2 = Call 'POST' '{"method":"explorer.snapshot","args":{}}' @{ Origin = $sameOrigin } 'text/plain'
W "[d] POST + content-type: text/plain → status=$($d2.status)（实现=415；任务文本写 405 ⇒ 差异记录）  body=$($d2.body -replace '\s+', ' ')"
$results['d_content_type_textplain'] = $d2.status
$d3 = Call 'POST' 'not-json' @{ Origin = $sameOrigin } 'application/json'
W "[d] POST + 非法 JSON → status=$($d3.status)  body=$($d3.body -replace '\s+', ' ')"
$results['d_invalid_json'] = $d3.status
$d4 = Call 'POST' '{"method":"explorer.daemon","args":{"action":"__bogus__"}}' @{ Origin = $sameOrigin } 'application/json'
W "[d] 合法 method + 非法 action → status=$($d4.status)（期望 400 E_ARG）  body=$($d4.body -replace '\s+', ' ')"

# ---- e) 响应/错误里不含 token/凭据 ----
W "`n[e] 凭据泄漏检查（用**真实** daemon.token 值做针，绝不打印该值）"
$tok = (WslBash "cat /home/g/.dsh/remote-wsl/daemon.$Slot.token 2>/dev/null || true").Trim()
$needles = @()
if ($tok) { $needles += $tok; $needles += $tok.Substring(0, [Math]::Min(12, $tok.Length)) }
$needles += 'daemon.token'
$bodies = @($r.body, $b403.body, $bMiss.body, $bBadSite.body, $bPos.body, $c.body, $c2.body, $d2.body, $d3.body, $d4.body)
$hit = @()
foreach ($n in $needles) { if ($n -and ($bodies -join "`n") -match [regex]::Escape($n)) { $hit += "needle(len=$($n.Length))" } }
W "    daemon.token 在场=$(if ($tok) { 'yes' }) len=$(if ($tok) { $tok.Length } else { 0 }) ｜ 响应体中命中针数=$($hit.Count) $(if ($hit.Count) { '<= 泄漏!!' } else { '<= 未泄漏' })"
W "    另查常见凭据字样："
foreach ($pat in @('token', 'Bearer', 'Authorization', 'apiKey', 'api_key', 'password', 'secret', 'cookie')) {
  $n = [regex]::Matches(($bodies -join "`n"), [regex]::Escape($pat)).Count
  if ($n -gt 0) { W "      '$pat' 出现 $n 次" }
}
$results['e_token_leak'] = ($hit.Count -eq 0)

# ---- 汇总 ----
W "`n############ 汇总 ############"
foreach ($k in $results.Keys) { W ("  {0,-28} = {1}" -f $k, $results[$k]) }
W "  methods(GET) = $($methods -join ',')"
Set-Content -LiteralPath (Join-Path $OutDir 'out-23-transport-probe.txt') -Value $log.ToString() -Encoding utf8
([ordered]@{ generatedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); route = $route; results = $results; methods = $methods } | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath (Join-Path $OutDir 'out-23-transport-probe.json') -Encoding utf8
exit 0

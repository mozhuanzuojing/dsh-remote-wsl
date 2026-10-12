#!/usr/bin/env pwsh
# capture-boot-graph.ps1 —— 验收①②的**注册面**证据：HTTP boot graph + client bundle 字面量。
#
# 为什么需要它：本会话 cordis_inspect_query(client) 超时，拿不到 Slots.listSubTree。
# 因此用三条独立取证中的两条：
#   (1) `window.__DSH_BOOT__` 的 entry 行（证明插件被 host 的 clientModules 扫到并给了 bundle URL）
#   (2) bundle 源文本里的注册字面量（sidebar.panellist / main / id / order / label）
#   (3) 浏览器 DOM（rail 与面板渲染）—— 由 browser/*.js 采集
#
# 用法：./capture-boot-graph.ps1 -Port 8931 -Token <host 打印的 token> -ExpectPlugin -OutDir .
#   ⚠️ `dsh web` 的 HTML 入口受浏览器信任栅栏保护：无 token ⇒ 401；必须用 `/?token=<t>` 建立会话，
#   后续 bundle/chunk 请求复用同一 WebSession（cookie 随行）。
[CmdletBinding()]
param(
  [int]$Port = 8931,
  [string]$Token,
  [switch]$ExpectPlugin,
  [string]$OutDir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"
$suffix = if ($ExpectPlugin) { '' } else { '-base' }

$htmlFile = Join-Path $OutDir ("out-04-index{0}.html" -f $suffix)
$graphFile = Join-Path $OutDir ("out-04-boot-graph{0}.json" -f $suffix)
$slotsFile = Join-Path $OutDir ("out-05-artifact-slots{0}.txt" -f $suffix)

$url = if ($Token) { "$base/?token=$Token" } else { "$base/" }
$r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10 -SessionVariable ws
Set-Content -LiteralPath $htmlFile -Value $r.Content -Encoding utf8
Write-Host "index.html <- $('(with token)' + $(if ($Token) { '' } else { '' })) ($($r.Content.Length) bytes) -> $htmlFile"

# 实测注入形状（2026-10-12）：`globalThis["__DSH_BOOT__"] = {"rev":…,"entries":[…],"batches":[…]}` 内联在 <script> 里。
# ⚠️ 不能用 `\{.*?"entries".*?\}` 这种懒匹配（会从文档里更早的 `{` 起抓、截到第一个 `}`，解析出空条目）。
$graph = $null
$m = [regex]::Match($r.Content, '__DSH_BOOT__"?\]\s*=\s*(\{.+?\})\s*</script>', 'Singleline')
if ($m.Success) {
  try { $graph = $m.Groups[1].Value | ConvertFrom-Json } catch { $graph = $null }
}
if (-not $graph) { $graph = [pscustomobject]@{ entries = @(); batches = @(); _parse = 'FAILED: 未在 index.html 里找到 __DSH_BOOT__ = {...}</script>（注入形状需现场重探）' } }
($graph | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $graphFile -Encoding utf8

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("# 注册面证据（$base）生成于 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
[void]$sb.AppendLine("index=$htmlFile")
if ($graph._parse) { [void]$sb.AppendLine("!! $($graph._parse)") }
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## boot entries")
foreach ($e in @($graph.entries)) { [void]$sb.AppendLine("  id=$($e.id) rev=$($e.rev) url=$($e.url) inject=[$($e.inject -join ',')] immediately=$($e.immediately)") }

$mine = @($graph.entries | Where-Object { $_.id -eq 'dsh-remote-wsl' })
$rc = 0
# 契约（docs/client-contract.md §2.3/§1.2）：入口是手写 `window.__ModuleLoader__.load({...})`；
# `client.<name>.js` 是**按需 chunk**（只有入口工厂里的 require.async 触发），
# combo 路由形如 `/plugins/??<pkg>/client.js&rev=<rev>`。⇒ **只 grep 入口会漏掉 chunk 里的注册字面量（假红）**。
# 因此三路取证：① 服务端入口 combo ② 逐 chunk 尝试 ③ 磁盘上的 client/**（静态）
$needles = @('__ModuleLoader__', 'sidebar.panellist', 'remote-wsl', 'main', 'order')
$bodies = @()
if ($ExpectPlugin) {
  if ($mine.Count -eq 0) { [void]$sb.AppendLine(""); [void]$sb.AppendLine("VERDICT: RED —— boot graph 里**没有** dsh-remote-wsl entry（dsh.client 未被扫到 / 未声明）"); $rc = 1 }
  else {
    [void]$sb.AppendLine(""); [void]$sb.AppendLine("OK: boot graph 命中 entry id=dsh-remote-wsl rev=$($mine[0].rev)")
    $url = $mine[0].url
    if ($url -notmatch '^https?://') { $url = $base + '/' + $url.TrimStart('/') }
    $bundleFile = Join-Path $OutDir ("out-04-bundle{0}.js" -f $suffix)
    try {
      $b = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 15 -WebSession $ws
      Set-Content -LiteralPath $bundleFile -Value $b.Content -Encoding utf8
      $bodies += [pscustomobject]@{ src = "served-entry:$url"; body = $b.Content }
      [void]$sb.AppendLine("bundle(entry)=$url -> $bundleFile ($($b.Content.Length) bytes)")
    } catch { [void]$sb.AppendLine("入口 bundle 拉取失败：$($_.Exception.Message)  <== 需现场重探"); $rc = 1 }

    # ② 逐 chunk 尝试（磁盘上的 client.<name>.js，按 combo 形态猜 URL；404 就记 not-served，不判红）
    $vendorClient = 'D:\project\dsh1\vendor\dsh-remote-wsl\client'
    if (Test-Path -LiteralPath $vendorClient) {
      foreach ($f in (Get-ChildItem -File -LiteralPath $vendorClient -Filter 'client.*.js' | Sort-Object Name)) {
        $alt = "$base/plugins/??dsh-remote-wsl/$($f.Name)&rev=$($mine[0].rev)"
        try {
          $cb = Invoke-WebRequest -Uri $alt -UseBasicParsing -TimeoutSec 10
          $cf = Join-Path $OutDir ("out-04-bundle-chunk-{0}" -f $f.Name)
          Set-Content -LiteralPath $cf -Value $cb.Content -Encoding utf8
          $bodies += [pscustomobject]@{ src = "served-chunk:$($f.Name)"; body = $cb.Content }
          [void]$sb.AppendLine("chunk($($f.Name)) => 200 ($($cb.Content.Length) bytes) -> $cf")
        } catch { [void]$sb.AppendLine("chunk($($f.Name)) => 未按该形态服务（$($_.Exception.Response.StatusCode.value__)）—— 走磁盘静态复核") }
      }
    }
    # ③ 磁盘静态（不是服务端真相，只用于"字面量到底在哪一层"的定位）
    if (Test-Path -LiteralPath $vendorClient) {
      foreach ($f in (Get-ChildItem -File -Recurse -LiteralPath $vendorClient | Sort-Object FullName)) {
        $bodies += [pscustomobject]@{ src = "disk:$($f.FullName.Substring($vendorClient.Length + 1))"; body = (Get-Content -LiteralPath $f.FullName -Raw) }
      }
    }

    foreach ($n in $needles) {
      $hitSrc = @($bodies | Where-Object { $_.body -match [regex]::Escape($n) } | ForEach-Object { $_.src })
      $found = $hitSrc.Count -gt 0
      [void]$sb.AppendLine(("  literal '{0}': {1}  [{2}]" -f $n, $(if ($found) { 'FOUND' } else { 'MISSING' }), ($hitSrc -join ' , ')))
      if (-not $found) { $rc = 1 }
    }
    [void]$sb.AppendLine("  （判据：FOUND 出现在 served-entry / served-chunk / disk 任一处即算在场；只有**三处都没有**才判 RED。")
    [void]$sb.AppendLine("    仅 disk 命中 => 记为「字面量在磁盘上，服务端未验证到」=> 报告里必须标未复核，不得写成通过。）")
    foreach ($pat in @("sidebar\.panellist", "id:\s*'remote-wsl'", "key:\s*'remote-wsl'", "order:\s*\d+", "label", "explorer\.snapshot|/remote-wsl|/rwsl")) {
      [void]$sb.AppendLine("  --- /$pat/ （disk:client/index.js + 各 chunk 的首个命中）---")
      foreach ($bd in $bodies) {
        $m = [regex]::Match($bd.body, $pat)
        if ($m.Success) {
          $s = [Math]::Max(0, $m.Index - 100); $l = [Math]::Min(280, $bd.body.Length - $s)
          [void]$sb.AppendLine("    [$($bd.src)] " + ($bd.body.Substring($s, $l) -replace '\s+', ' '))
        }
      }
    }
  }
} else {
  [void]$sb.AppendLine("")
  [void]$sb.AppendLine("基线实例（不带插件）：期望 entries 里**没有** dsh-remote-wsl。命中数=$($mine.Count)")
  [void]$sb.AppendLine("这条与带插件实例的 entry 集合做对称差 => 必须恰为 {dsh-remote-wsl}")
}

Set-Content -LiteralPath $slotsFile -Value $sb.ToString() -Encoding utf8
Write-Host $sb.ToString()
Write-Host "exit=$rc -> $slotsFile"
exit $rc


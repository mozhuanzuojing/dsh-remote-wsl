#!/usr/bin/env pwsh
# revision.ps1 —— task-4 冻结锚点。
#
# 锚点（lead 2026-10-12 裁决 Q1/Q2 更新）：
#   A1 = src/**/*.ts      （现存 8 个 = 原冻结 7 + 新增 src/explorer.ts）
#   A2 = client/**         （全部文件；入口固定 client/index.js）
#   A3 = package.json      （client 半的注册契约：exports["./client"] + dsh.client.platform="web"）
# 非锚点 advisory（只告警，不判无效）：cordis.patch.yml、README.md、docs/*.md
#
# 用法：
#   ./revision.ps1 -Mode Preview   # 落 REVISION.preview.txt（不构成冻结）
#   ./revision.ps1 -Mode Write     # 开工时落 REVISION.txt（client/** 为空或入口缺失 => 拒写 exit 2）
#   ./revision.ps1 -Mode Check     # 收尾复算；锚点不同 => 打印差异 + exit 1（判定「验证无效」）
#
# 退出码：0 = OK；1 = 锚点漂移（验证无效）；2 = 锚点不完整（Write 前置未满足）；3 = 锚点 OK 但 advisory 漂移
[CmdletBinding()]
param(
  [ValidateSet('Preview', 'Write', 'Check')][string]$Mode = 'Preview',
  [string]$PluginRoot = 'D:\project\dsh1\vendor\dsh-remote-wsl',
  [string]$ClientRel = 'client',
  [string]$ClientEntry = 'client/index.js',
  [string]$OutDir = $PSScriptRoot,
  [switch]$AllowAdvisoryDrift,
  [switch]$ConfirmFreeze   # Write 必须显式带此开关（防止 task-2/3 还在写时误冻结）
)
$ErrorActionPreference = 'Stop'

$ANCHOR_BEGIN = '#@ANCHOR-BEGIN'
$ANCHOR_END = '#@ANCHOR-END'
$ADV_BEGIN = '#@ADVISORY-BEGIN'
$ADV_END = '#@ADVISORY-END'
$AdvisoryExtra = @('cordis.patch.yml', 'README.md')
$Frozen7 = @('src/daemon-client.ts', 'src/daemon.ts', 'src/index.ts', 'src/sdk-runtime.ts', 'src/selftest.ts', 'src/shell-env.ts', 'src/version.ts')

function Get-Anchor([string]$root, [string]$clientRel) {
  $srcDir = Join-Path $root 'src'
  if (-not (Test-Path -LiteralPath $srcDir)) { throw "缺少 src 目录: $srcDir" }
  $items = New-Object System.Collections.Generic.List[object]
  foreach ($f in (Get-ChildItem -File -Recurse -LiteralPath $srcDir -Filter '*.ts' | Sort-Object FullName)) {
    $items.Add([pscustomobject]@{ Rel = ($f.FullName.Substring($root.Length + 1) -replace '\\', '/'); Full = $f.FullName })
  }
  $clientCount = 0; $clientEntryPresent = $false
  $clientDir = Join-Path $root $clientRel
  if (Test-Path -LiteralPath $clientDir) {
    foreach ($f in (Get-ChildItem -File -Recurse -LiteralPath $clientDir | Sort-Object FullName)) {
      $rel = $f.FullName.Substring($root.Length + 1) -replace '\\', '/'
      $items.Add([pscustomobject]@{ Rel = $rel; Full = $f.FullName })
      $clientCount++
      if ($rel -eq $ClientEntry) { $clientEntryPresent = $true }
    }
  }
  foreach ($f in (Get-ChildItem -File -LiteralPath $root -Filter 'package.json' | Sort-Object Name)) {
    $items.Add([pscustomobject]@{ Rel = 'package.json'; Full = $f.FullName })
  }
  return [pscustomobject]@{ Items = $items; ClientCount = $clientCount; ClientEntryPresent = $clientEntryPresent }
}

function Render-Lines($paths) {
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($p in $paths) {
    if (-not (Test-Path -LiteralPath $p.Full)) { $out.Add(('MISSING'.PadRight(64) + '  {0,9}  {1}' -f 0, $p.Rel)); continue }
    $h = (Get-FileHash -LiteralPath $p.Full -Algorithm SHA256).Hash.ToLower()
    $size = (Get-Item -LiteralPath $p.Full).Length
    $out.Add(('{0}  {1,9}  {2}' -f $h, $size, $p.Rel))
  }
  return ($out -join "`n")
}

# 契约体检（**不作为拒写条件**：契约坏了正是要验出来的红，先冻结再验）
function Get-Preflight([string]$root, [string]$clientRel, [string]$clientEntry) {
  $lines = New-Object System.Collections.Generic.List[string]
  $pkgPath = Join-Path $root 'package.json'
  $pkg = $null
  try { $pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json } catch { $lines.Add("PREFLIGHT FAIL: package.json 不是合法 JSON: $($_.Exception.Message)"); return @($lines) }
  $exp = $null
  if ($pkg.PSObject.Properties.Name -contains 'exports') { $exp = $pkg.exports }
  $clientExport = $null
  if ($null -ne $exp) {
    if ($exp.PSObject.Properties.Name -contains './client') { $clientExport = $exp.'./client' }
    elseif ($exp.PSObject.Properties.Name -contains 'client') { $clientExport = $exp.client }
  }
  if ($clientExport) { $lines.Add("PREFLIGHT OK: exports[`"./client`"] = $clientExport") } else { $lines.Add("PREFLIGHT FAIL: package.json 缺 exports[`"./client`"]（约定：-> $clientEntry）") }
  $cl = $null
  if ($pkg.PSObject.Properties.Name -contains 'dsh') { $cl = $pkg.dsh.client }
  if ($null -eq $cl) { $lines.Add("PREFLIGHT FAIL: package.json 缺 dsh.client 声明（约定：dsh.client.platform = `"web`"）") }
  else {
    $plat = if ($cl.PSObject.Properties.Name -contains 'platform') { $cl.platform } else { $null }
    if ("$plat" -eq 'web') { $lines.Add("PREFLIGHT OK: dsh.client.platform = web") } else { $lines.Add("PREFLIGHT FAIL: dsh.client.platform = `"$plat`"（必须 `"web`"）") }
  }
  $entryPath = Join-Path $root $clientEntry
  if (Test-Path -LiteralPath $entryPath) { $lines.Add("PREFLIGHT OK: 入口文件在场 $clientEntry（$((Get-Item -LiteralPath $entryPath).Length) bytes）") } else { $lines.Add("PREFLIGHT FAIL: 入口文件缺失 $clientEntry（契约：缺文件 => 激活失败）") }
  $files = if ($pkg.PSObject.Properties.Name -contains 'files') { @($pkg.files) } else { @() }
  if ($files -contains $clientRel) { $lines.Add("PREFLIGHT OK: package.json files 含 `"$clientRel`"") } else { $lines.Add("PREFLIGHT WARN: package.json files 不含 `"$clientRel`"（打包面可能漏发 client 半）") }
  return @($lines)
}

function Build-Doc([string]$mode) {
  $a = Get-Anchor $PluginRoot $ClientRel
  $anchorBody = Render-Lines $a.Items

  $advPaths = New-Object System.Collections.Generic.List[object]
  foreach ($rel in $AdvisoryExtra) {
    $full = Join-Path $PluginRoot $rel
    if (Test-Path -LiteralPath $full) { $advPaths.Add([pscustomobject]@{ Rel = $rel; Full = $full }) }
  }
  $docsDir = Join-Path $PluginRoot 'docs'
  if (Test-Path -LiteralPath $docsDir) {
    foreach ($f in (Get-ChildItem -File -Recurse -LiteralPath $docsDir | Sort-Object FullName)) {
      $advPaths.Add([pscustomobject]@{ Rel = ($f.FullName.Substring($PluginRoot.Length + 1) -replace '\\', '/'); Full = $f.FullName })
    }
  }
  $advBody = Render-Lines $advPaths
  $pre = Get-Preflight $PluginRoot $ClientRel $ClientEntry

  $srcCount = @($a.Items | Where-Object { $_.Rel -like 'src/*' }).Count
  $head = @()
  $head += "# task-4 冻结 revision（锚点 = src/**/*.ts + $ClientRel/** + package.json）"
  $head += "#"
  $head += "# **不可手工编辑**：由 revision.ps1 生成/复算。"
  $head += "# 生成时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')（Asia/Shanghai 本地时区）"
  $head += "# 模式：$mode ｜ 采集方式：Get-FileHash -Algorithm SHA256"
  $head += "# 锚点文件数：$($a.Items.Count)（src=$srcCount  $ClientRel=$($a.ClientCount)  package.json=1）"
  $head += "# 锚点漂移 => 验证无效（revision.ps1 -Mode Check 退出码 1）"
  $head += "# advisory 漂移 => 退出码 3，需解释（cordis.patch.yml / README.md / docs/*.md 不入锚点）"
  $head += "#"
  $head += "# 契约体检（不参与锚点比对，只记录）："
  foreach ($l in $pre) { $head += "#   $l" }
  $head += ""
  $head += $ANCHOR_BEGIN
  $head += $anchorBody
  $head += $ANCHOR_END
  $head += $ADV_BEGIN
  $head += "# --- 非锚点（advisory）：只告警，不判无效 ---"
  $head += $advBody
  $head += $ADV_END
  return [pscustomobject]@{ Text = ($head -join "`n"); Anchor = $anchorBody; Advisory = $advBody; SrcCount = $srcCount; ClientCount = $a.ClientCount; ClientEntryPresent = $a.ClientEntryPresent; Preflight = $pre }
}

function Section-Of([string]$text, [string]$begin, [string]$end) {
  $i = $text.IndexOf($begin); $j = $text.IndexOf($end)
  if ($i -lt 0 -or $j -lt 0 -or $j -le $i) { return $null }
  return $text.Substring($i + $begin.Length, $j - $i - $begin.Length).Trim()
}

$targetName = if ($Mode -eq 'Preview') { 'REVISION.preview.txt' } else { 'REVISION.txt' }
$target = Join-Path $OutDir $targetName
$doc = Build-Doc $Mode

$a = Get-Anchor $PluginRoot $ClientRel
$present = @($a.Items | ForEach-Object { $_.Rel })
$missingFrozen = @($Frozen7 | Where-Object { $present -notcontains $_ })
$extraSrc = @($present | Where-Object { $_ -like 'src/*' -and $Frozen7 -notcontains $_ })
if ($missingFrozen.Count -gt 0) { Write-Host "REFUSE: 原冻结 7 个文件缺失：$($missingFrozen -join ', ')"; exit 2 }
if ($extraSrc.Count -gt 0) {
  Write-Host "NOTE: src/**/*.ts = $($doc.SrcCount)（原冻结 7 + 额外 $($extraSrc.Count)）：$($extraSrc -join ', ')"
  Write-Host "      -> 已一并纳入锚点（lead 2026-10-12 Q1 裁决：P0 冻结集含新增文件）。"
}

Write-Host "--- 契约体检 ---"
foreach ($l in $doc.Preflight) { Write-Host "  $l" }

if ($Mode -eq 'Write') {
  if (-not $ConfirmFreeze) { Write-Host "REFUSE: 冻结必须显式 -ConfirmFreeze（等 lead 通知 task-2/task-3 落地后再冻结；本回合仍待命）"; exit 2 }
  if ($doc.ClientCount -lt 1) { Write-Host "REFUSE: $ClientRel/** 为空 —— task-3 的 client 半尚未落地，不能冻结"; exit 2 }
  if (-not $doc.ClientEntryPresent) { Write-Host "REFUSE: 入口 $ClientEntry 不存在 —— 契约要求入口固定 $ClientEntry（先让 task-3 落地）"; exit 2 }
}

if ($Mode -eq 'Check') {
  if (-not (Test-Path -LiteralPath $target)) { Write-Host "REFUSE: 找不到 $target（未冻结）"; exit 2 }
  $old = Get-Content -LiteralPath $target -Raw
  $oldAnchor = Section-Of $old $ANCHOR_BEGIN $ANCHOR_END
  $oldAdv = Section-Of $old $ADV_BEGIN $ADV_END
  $sameAnchor = ($oldAnchor -eq $doc.Anchor)
  $sameAdv = ($oldAdv -eq $doc.Advisory)
  Write-Host "锚点一致 = $sameAnchor ｜ advisory 一致 = $sameAdv"
  Write-Host "锚点文件数 = $($doc.SrcCount) src + $($doc.ClientCount) $ClientRel + package.json"
  if (-not $sameAnchor) {
    Write-Host "`n===== 锚点漂移：冻结 vs 现在 ====="
    $o = ($oldAnchor -split "`n"); $n = ($doc.Anchor -split "`n")
    for ($k = 0; $k -lt [Math]::Max($o.Count, $n.Count); $k++) {
      $ov = if ($k -lt $o.Count) { $o[$k] } else { '<none>' }
      $nv = if ($k -lt $n.Count) { $n[$k] } else { '<none>' }
      if ($ov -ne $nv) { Write-Host "  - $ov"; Write-Host "  + $nv" }
    }
    Write-Host "`n结论：**验证无效**（被验对象在验证期间发生变化）"
    exit 1
  }
  if (-not $sameAdv -and -not $AllowAdvisoryDrift) {
    Write-Host "`n===== advisory 漂移（cordis.patch.yml / README / docs）====="
    Write-Host "  - $oldAdv"; Write-Host "  + $($doc.Advisory)"
    Write-Host "`n结论：锚点未变，但 advisory 输入变了 => 需解释（exit 3）"
    exit 3
  }
  Write-Host "结论：revision 锚点未变。"
  exit 0
}

Set-Content -LiteralPath $target -Value $doc.Text -Encoding utf8
Write-Host "[$Mode] 已写 $target"
Write-Host "  src/**/*.ts = $($doc.SrcCount)  $ClientRel/** = $($doc.ClientCount)  package.json = 1"
if ($doc.ClientCount -lt 1 -or -not $doc.ClientEntryPresent) { Write-Host "  注意：client 半未落地 —— Preview 允许；Write 会拒绝" }
Write-Host ""
Write-Host $doc.Anchor
exit 0

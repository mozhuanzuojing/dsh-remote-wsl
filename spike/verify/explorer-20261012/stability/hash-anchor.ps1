#!/usr/bin/env pwsh
# hash-anchor.ps1 —— task-7 自己的**被验对象 revision 锚点**（独立于 p0-verify 的 revision.ps1）。
#
# 为什么要有：稳定性结论只在"被验对象没变"的前提下成立。若 T2/T3 在长跑测试期间改了
# client/**，20 轮循环的前后读数就不可比 ⇒ 报告必须能自证：开工锚点 == 收工锚点。
#
# 锚点 = client/** 全部文件 + src/*.ts 全部文件 + package.json 的 SHA256 + size
# （package.json 单独标 advisory，"dsh.client" 是否声明决定 bundle 是否被注入 = 我的 G2 闸门）
#
# 用法：
#   ./hash-anchor.ps1 -Mode Preview        # 只打印，不落盘（准备阶段用这个）
#   ./hash-anchor.ps1 -Mode Write          # 落 REVISION.txt（client/** 为空则拒绝 exit 2）
#   ./hash-anchor.ps1 -Mode Check          # 收工复算；不等则打印差异并 exit 1
[CmdletBinding()]
param(
  [ValidateSet('Preview','Write','Check')][string]$Mode = 'Preview',
  [string]$Vendor = 'D:\project\dsh1\vendor\dsh-remote-wsl',
  [string]$OutDir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
$anchorFile = Join-Path $OutDir 'REVISION.txt'

function Get-FileHash256([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }

function Get-AnchorSet {
  $items = @()
  $clientDir = Join-Path $Vendor 'client'
  if (Test-Path -LiteralPath $clientDir) {
    foreach ($f in Get-ChildItem -LiteralPath $clientDir -Recurse -File | Sort-Object FullName) {
      $items += [pscustomobject]@{ rel = $f.FullName.Substring($Vendor.Length + 1) -replace '\\','/'; sha256 = Get-FileHash256 $f.FullName; size = $f.Length; advisory = $false }
    }
  }
  $srcDir = Join-Path $Vendor 'src'
  if (Test-Path -LiteralPath $srcDir) {
    foreach ($f in Get-ChildItem -LiteralPath $srcDir -File -Filter '*.ts' | Sort-Object Name) {
      $items += [pscustomobject]@{ rel = "src/$($f.Name)"; sha256 = Get-FileHash256 $f.FullName; size = $f.Length; advisory = $false }
    }
  }
  $pkg = Join-Path $Vendor 'package.json'
  if (Test-Path -LiteralPath $pkg) {
    $items += [pscustomobject]@{ rel = 'package.json'; sha256 = Get-FileHash256 $pkg; size = (Get-Item $pkg).Length; advisory = $true }
  }
  return , $items
}

function Get-Gate {
  # ★ S4 修正（2026-10-12）：不能用文本 grep 找 `dsh.client` —— 真实声明是嵌套 JSON，
  #   字面量不出现，会假红。改为解析 JSON 路径 + 校验 exports["./client"] 指向真实文件。
  $pkg = Join-Path $Vendor 'package.json'
  $out = [pscustomobject]@{ dshClientDeclared = $false; platform = $null; inject = $null; entry = $null; entryExists = $false; clientFileCount = 0; gatePass = $false; why = '' }
  $cd = Join-Path $Vendor 'client'
  if (Test-Path -LiteralPath $cd) { $out.clientFileCount = (Get-ChildItem -LiteralPath $cd -Recurse -File).Count }
  if (Test-Path -LiteralPath $pkg) {
    try {
      $j = Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json
      $c = $j.dsh.client
      $out.dshClientDeclared = ($null -ne $c)
      if ($out.dshClientDeclared) { $out.platform = $c.platform; $out.inject = ($c.inject -join ',') }
      $e = $j.exports.'./client'
      $out.entry = $e
      if ($e) { $out.entryExists = Test-Path -LiteralPath (Join-Path $Vendor ($e -replace '^\./','')) }
      $out.gatePass = ($out.dshClientDeclared -and $out.entryExists -and $out.clientFileCount -gt 0)
      if (-not $out.gatePass) { $out.why = "dsh.client=$($out.dshClientDeclared) 入口存在=$($out.entryExists) client文件数=$($out.clientFileCount)" }
    } catch { $out.why = "package.json 解析失败：$($_.Exception.Message)" }
  } else { $out.why = 'package.json 不存在' }
  return $out
}

$gate = Get-Gate
$items = Get-AnchorSet
$hdr = @(
  "# task-7 被验对象锚点（hash-anchor.ps1）"
  "# 时间：$(Get-Date -Format 'o')  模式：$Mode"
  "# gate(G2): dsh.client=$($gate.dshClientDeclared) platform=$($gate.platform) inject=[$($gate.inject)] entry=$($gate.entry) 入口存在=$($gate.entryExists) ⇒ pass=$($gate.gatePass) $($gate.why)"
  "# 锚点条目：$($items.Count)（client/**: $((@($items | Where-Object { $_.rel -like 'client/*' })).Count)，src/*.ts: $((@($items | Where-Object { $_.rel -like 'src/*' })).Count)，advisory: $((@($items | Where-Object { $_.advisory })).Count)）"
)
$body = $items | ForEach-Object { "{0}`t{1}`t{2}{3}" -f $_.sha256, $_.size, $_.rel, $(if ($_.advisory) { '  [advisory]' } else { '' }) }
$all = $hdr + $body

switch ($Mode) {
  'Preview' {
    $all | ForEach-Object { Write-Host $_ }
    Write-Host "（Preview：未写入 $anchorFile）"
    if (-not $gate.gatePass) { Write-Host "gate 未过：dsh.client=$($gate.dshClientDeclared) clientFiles=$($gate.clientFileCount) —— 稳定性测试尚不能开工" }
    exit 0
  }
  'Write' {
    $clientCount = (@($items | Where-Object { $_.rel -like 'client/*' })).Count
    if ($clientCount -eq 0) { Write-Host "拒绝 Write：client/** 为空（没有渲染面可验）—— exit 2"; exit 2 }
    $all | Set-Content -LiteralPath $anchorFile -Encoding utf8
    Write-Host "已写锚点：$anchorFile（$($items.Count) 条）"
    if (-not $gate.gatePass) { Write-Host "警告：gate 未过（dsh.client=$($gate.dshClientDeclared)）—— 锚点已落，但开工前必须先过 G2" }
    exit 0
  }
  'Check' {
    if (-not (Test-Path -LiteralPath $anchorFile)) { Write-Host "找不到锚点：$anchorFile"; exit 3 }
    $old = Get-Content -LiteralPath $anchorFile | Where-Object { $_ -and -not $_.StartsWith('#') }
    $oldMap = @{}
    foreach ($l in $old) { $p = $l -split "`t"; if ($p.Count -ge 3) { $oldMap[$p[2].Trim() -replace '\s+\[advisory\]$',''] = $p[0] } }
    $newMap = @{}
    foreach ($i in $items) { $newMap[$i.rel] = $i.sha256 }
    $diffs = @()
    foreach ($k in $oldMap.Keys) { if (-not $newMap.ContainsKey($k)) { $diffs += "REMOVED  $k" } elseif ($oldMap[$k] -ne $newMap[$k]) { $diffs += "CHANGED  $k  $($oldMap[$k].Substring(0,12)) -> $($newMap[$k].Substring(0,12))" } }
    foreach ($k in $newMap.Keys) { if (-not $oldMap.ContainsKey($k)) { $diffs += "ADDED    $k" } }
    if ($diffs.Count -eq 0) { Write-Host "锚点一致：被验对象未变（$($items.Count) 条）"; exit 0 }
    Write-Host "!! 锚点不一致 —— 稳定性结论无效（前后读数不可比）："
    $diffs | ForEach-Object { Write-Host "  $_" }
    exit 1
  }
}

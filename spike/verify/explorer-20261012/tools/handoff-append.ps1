<#
.SYNOPSIS
  安全地把一个新小节追加到交接文档（handoff），并保证既有标题一个都不丢。

.DESCRIPTION
  为什么存在：本轮用"按标题做锚点替换"的手法追加小节，**3 次把后面的 `## 7.` 吃掉**。
  本脚本从设计上禁止那种手法：

    * `-Mode Apply` 只在**文件末尾追加**：新内容 = 原文本 + 追加块。
      改完立刻断言 **`newText.StartsWith(originalText)`（原字节是前缀）** —— 只要这条成立，
      "吃掉既有内容"在物理上不可能发生。断言失败 ⇒ 回滚原字节并退出 1。
    * 追加后再断言 **标题序列 before ⊆ after（顺序保持的子序列）**，否则同样回滚。
    * 全脚本**没有任何**"按标题/正则定位并替换已有文本"的代码路径；唯一的区间操作是文件末尾。
    * `-Mode Check` 做同一件事的比较：把当前标题序列与基线快照比对，
      基线标题必须全部按原顺序出现（"完全一致或只多不少"），否则退出 1 并列出**丢了哪些标题**。

.PARAMETER Mode
  Snapshot = 把当前标题序列写成基线快照（不改文档）。
  Headings = 打印当前标题序列（行号 + 级别 + 文本）。
  Apply    = 追加一个小节（需 -Title，正文用 -Body 或 -BodyFile）。
  Check    = 当前标题序列 vs 基线快照（默认取 -SnapshotDir 下同名快照）。

.EXAMPLE
  pwsh -File handoff-append.ps1 -Mode Headings
  pwsh -File handoff-append.ps1 -Mode Snapshot
  pwsh -File handoff-append.ps1 -Mode Check
  pwsh -File handoff-append.ps1 -Mode Apply -Title '14. 新增小节' -BodyFile .\note.md
#>
[CmdletBinding()]
param(
  [ValidateSet('Snapshot', 'Headings', 'Apply', 'Check')] [string] $Mode = 'Check',
  [string] $Path = 'D:\project\net1\docs\handoff\2026-10-10-dsh-remote-wsl-守护接入与差距.md',
  [string] $Title,
  [string] $Body,
  [string] $BodyFile,
  [string] $SnapshotDir = "$PSScriptRoot\snapshots",
  [string] $SnapshotName,
  [string] $Baseline
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string] $message, [int] $code) { Write-Host "FAIL: $message"; exit $code }
function Info([string] $message) { Write-Host $message }

function Get-Sha256OfText([string] $text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
  }
  finally { $sha.Dispose() }
}

function Get-Headings([string] $text) {
  $result = @()
  $lines = $text -split "`n"
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    $m = [regex]::Match($line, '^(?<hashes>#{2,3})\s+(?<text>.*?)\s*$')
    if ($m.Success) {
      $result += [pscustomobject]@{
        Line  = $i + 1
        Level = $m.Groups['hashes'].Value.Length
        Text  = $m.Groups['text'].Value
      }
    }
  }
  return $result
}

function Get-SnapshotPath([string] $docPath) {
  if ($Baseline) { return $Baseline }
  $name = if ($SnapshotName) { $SnapshotName } else { [System.IO.Path]::GetFileName($docPath) }
  return (Join-Path $SnapshotDir ($name + '.headings.txt'))
}

function Write-Snapshot([string] $docPath, [object[]] $headings, [string] $snapshotPath) {
  $dir = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($snapshotPath))
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $sb = New-Object System.Text.StringBuilder
  [void] $sb.AppendLine("# headings baseline — 由 handoff-append.ps1 -Mode Snapshot 生成；只在文件末尾追加，不要手工编辑")
  [void] $sb.AppendLine("# doc: $docPath")
  [void] $sb.AppendLine("# taken: $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))")
  foreach ($h in $headings) { [void] $sb.AppendLine("$($h.Line)`t$($h.Level)`t$($h.Text)") }
  [System.IO.File]::WriteAllText($snapshotPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
}

function Read-Snapshot([string] $snapshotPath) {
  if (-not (Test-Path -LiteralPath $snapshotPath)) { Fail "基线快照不存在: $snapshotPath（先跑 -Mode Snapshot）" 2 }
  $result = @()
  foreach ($line in [System.IO.File]::ReadAllLines($snapshotPath)) {
    if ($line.StartsWith('#')) { continue }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split "`t"
    if ($parts.Count -lt 3) { continue }
    $result += [pscustomobject]@{ Line = [int] $parts[0]; Level = [int] $parts[1]; Text = ($parts[2..($parts.Count - 1)] -join "`t") }
  }
  return $result
}

# --------------------------------------------------------------- 子序列判定
<#
  返回 @( { Status = 'kept'|'missing'; H = 基线标题 } )，
  以及使 before 成为 after 子序列的匹配（顺序保持）。
#>
function Compare-Headings([object[]] $before, [object[]] $after) {
  $rows = @()
  $j = 0
  foreach ($b in $before) {
    $matched = $false
    while ($j -lt $after.Count) {
      $a = $after[$j]
      $j++
      if ($a.Level -eq $b.Level -and $a.Text -eq $b.Text) { $matched = $true; break }
    }
    $rows += [pscustomobject]@{ Status = if ($matched) { 'kept' } else { 'missing' }; H = $b }
  }
  return $rows
}

# ---------------------------------------------------------------------- main

$docPath = [System.IO.Path]::GetFullPath($Path)
if (-not (Test-Path -LiteralPath $docPath)) { Fail "交接文档不存在: $docPath" 2 }
$originalText = [System.IO.File]::ReadAllText($docPath)

switch ($Mode) {
  'Headings' {
    $h = Get-Headings $originalText
    Info "doc: $docPath  ($($h.Count) headings)"
    foreach ($x in $h) { Write-Output ("{0,5}  {1}  {2}" -f $x.Line, ('#' * $x.Level), $x.Text) }
    exit 0
  }

  'Snapshot' {
    $snapshotPath = Get-SnapshotPath $docPath
    $h = Get-Headings $originalText
    Write-Snapshot $docPath $h $snapshotPath
    Info "snapshot: $snapshotPath  ($($h.Count) headings)"
    exit 0
  }

  'Check' {
    $snapshotPath = Get-SnapshotPath $docPath
    $before = Read-Snapshot $snapshotPath
    $after = Get-Headings $originalText
    Info "doc      : $docPath  ($($after.Count) headings)"
    Info "baseline : $snapshotPath  ($($before.Count) headings)"
    $rows = Compare-Headings $before $after
    $missing = @($rows | Where-Object { $_.Status -eq 'missing' })
    Info '--- baseline headings ---'
    foreach ($r in $rows) {
      if ($r.Status -eq 'kept') { Write-Output ("PASS  kept     [baseline L{0}] {1} {2}" -f $r.H.Line, ('#' * $r.H.Level), $r.H.Text) }
      else { Write-Output ("FAIL  MISSING  [baseline L{0}] {1} {2}" -f $r.H.Line, ('#' * $r.H.Level), $r.H.Text) }
    }
    if ($missing.Count -gt 0) {
      Info ''
      Info "RESULT: FAIL — 基线里 $($missing.Count) 个标题在当前文档里找不到了（顺序保持的子序列判定）"
      exit 1
    }
    if ($after.Count -gt $before.Count) { Info "note: 基线之外新增了 $($after.Count - $before.Count) 个标题（允许：只多不少）" }
    Info ''
    Info "RESULT: PASS — 基线 $($before.Count) 个标题全部按原顺序保留"
    exit 0
  }

  'Apply' {
    if (-not $Title) { Fail "Apply 需要 -Title" 2 }
    $newBody = if ($BodyFile) { [System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($BodyFile)) } elseif ($Body) { $Body } else { '' }

    $existing = Get-Headings $originalText
    $dupe = $existing | Where-Object { $_.Level -eq 2 -and $_.Text -eq $Title }
    if ($dupe) { Fail "文档里已存在同名二级标题 '$Title'（L$($dupe[0].Line)）⇒ 拒绝重复追加" 2 }

    $before = $existing
    $suffix = "`n## $Title`n"
    if ($newBody.Trim().Length -gt 0) { $suffix += "`n" + $newBody.TrimEnd("`r", "`n") + "`n" }
    $newText = $originalText + $suffix

    # 不变量 1：原字节必须是新文本的前缀（物理上不可能吃掉既有内容）
    if (-not $newText.StartsWith($originalText, [System.StringComparison]::Ordinal)) {
      Fail "内部错误：追加结果不再是'原文本为前缀'，已放弃写入" 1
    }

    # 不变量 2：标题序列 before ⊆ after（顺序保持）
    $after = Get-Headings $newText
    $rows = Compare-Headings $before $after
    $missing = @($rows | Where-Object { $_.Status -eq 'missing' })
    if ($missing.Count -gt 0) {
      Fail "追加会使 $($missing.Count) 个既有标题丢失（$(($missing | ForEach-Object { $_.H.Text }) -join ' / ')）⇒ 已放弃写入" 1
    }

    # 保留原编码的 BOM 策略
    $raw = [System.IO.File]::ReadAllBytes($docPath)
    $hasBom = ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF)
    $encoding = New-Object System.Text.UTF8Encoding($hasBom)
    try {
      [System.IO.File]::WriteAllText($docPath, $newText, $encoding)
    }
    catch {
      [System.IO.File]::WriteAllBytes($docPath, $raw)
      Fail "写入失败，已回滚原字节: $($_.Exception.Message)" 1
    }

    $afterCheck = Get-Headings ([System.IO.File]::ReadAllText($docPath))
    $rows2 = Compare-Headings $before $afterCheck
    if (@($rows2 | Where-Object { $_.Status -eq 'missing' }).Count -gt 0) {
      [System.IO.File]::WriteAllBytes($docPath, $raw)
      Fail "落盘后复检发现标题丢失 ⇒ 已回滚原字节" 1
    }

    $snapshotPath = Get-SnapshotPath $docPath
    Write-Snapshot $docPath $afterCheck $snapshotPath
    Info "APPENDED: ## $Title  -> $docPath  (headings $($before.Count) -> $($afterCheck.Count))"
    Info "append-only 断言通过（原文本为新文本前缀）；基线快照已更新: $snapshotPath"
    exit 0
  }
}

<#
.SYNOPSIS
  从 REVISION.txt 的 #@ANCHOR-BEGIN/END 块生成 / 校验 README 的冻结 revision 表。

.DESCRIPTION
  消灭"手抄 13 个锚点"这一类错误（本轮真发生过：c34e1af4… 被抄成 c34e1af4… 之外的错值、
  以及漏判"哪些文件变了"）。本脚本是**唯一**的锚点投影器：
    REVISION.txt  --(Generate)-->  README 表格片段
    README 表格   --(Check)--->    与 REVISION.txt 逐字比对

  安全约定（刻意设计）：
    * 默认 `-Mode Generate` **只打印**，绝不写仓库里的任何文件。
    * 写 README 需要 **同时** `-Apply -Mode Generate`，且 README 里必须已存在
      `<!-- FREEZE-TABLE-BEGIN -->` / `<!-- FREEZE-TABLE-END -->` 这一对标记；
      标记不存在 ⇒ 退出码 2 并打印"建议在哪加标记"，**不改 README**。
    * `-Apply` 只替换标记之间的内容；标记外的字节（含历史冻结表）一律不动。
    * 从不使用"按标题/哈希做锚点替换"的手法——只按标记行做区间替换。

.PARAMETER Mode
  Generate（默认）= 打印（或 -OutFile 写出）由 REVISION.txt 生成的表格片段。
  Check           = 校验 README 里的冻结表与 REVISION.txt 逐字一致，不一致退出码 1。

.PARAMETER RevisionPath / ReadmePath
  默认值是本仓库（dsh-remote-wsl）内的固定位置，可用参数覆盖（做"故意红"实验时指向副本）。

.PARAMETER TableIndex
  README 里可能有多张历史冻结表（P0 / P0.1 / P0.2 / P0.3 …）。
  候选 = "至少包含 1 个 REVISION 锚点路径"的表；默认取**最后一张**（= 最新）。
  用 `-TableIndex N`（1 基，按候选顺序，从最早到最新）可指定其它表。

.EXAMPLE
  pwsh -File sync-freeze-table.ps1                       # 打印生成的片段
  pwsh -File sync-freeze-table.ps1 -Mode Check           # 校验（退出码 0/1/2）
  pwsh -File sync-freeze-table.ps1 -Mode Check -ReadmePath <副本>
#>
[CmdletBinding()]
param(
  [ValidateSet('Generate', 'Check')] [string] $Mode = 'Generate',
  [string] $RevisionPath = "$PSScriptRoot\..\REVISION.txt",
  [string] $ReadmePath = "$PSScriptRoot\..\..\..\..\README.md",
  [int] $TableIndex = 0,
  [string] $OutFile,
  [switch] $Apply,
  [string] $BeginMarker = '<!-- FREEZE-TABLE-BEGIN -->',
  [string] $EndMarker = '<!-- FREEZE-TABLE-END -->',
  [switch] $Quiet
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string] $message, [int] $code) {
  Write-Host "FAIL: $message"
  exit $code
}

function Resolve-FullPath([string] $path) {
  $p = [System.IO.Path]::GetFullPath($path)
  if (-not (Test-Path -LiteralPath $p)) { Fail "file not found: $p" 2 }
  return $p
}

# ---------------------------------------------------------------- REVISION.txt

function Read-Anchors([string] $path) {
  $lines = [System.IO.File]::ReadAllLines($path)
  $begin = -1; $end = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq '#@ANCHOR-BEGIN') { $begin = $i; continue }
    if ($lines[$i].Trim() -eq '#@ANCHOR-END') { $end = $i; break }
  }
  if ($begin -lt 0 -or $end -lt 0) { Fail "REVISION has no #@ANCHOR-BEGIN/END block: $path" 2 }
  if ($end -le $begin) { Fail "REVISION ANCHOR block is empty: $path" 2 }

  $rows = @()
  for ($i = $begin + 1; $i -lt $end; $i++) {
    $line = $lines[$i]
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    # 形如: <64hex>  <spaces>  <size>  <spaces>  <path>
    $m = [regex]::Match($line, '^(?<hash>[0-9a-fA-F]{64})\s+(?<size>\d+)\s+(?<path>.+?)\s*$')
    if (-not $m.Success) { Fail "REVISION anchor line $($i + 1) is malformed: $line" 2 }
    $rows += [pscustomobject]@{
      Hash = $m.Groups['hash'].Value
      Size = [int64] $m.Groups['size'].Value
      Path = $m.Groups['path'].Value
    }
  }
  if ($rows.Count -eq 0) { Fail "REVISION ANCHOR block parsed 0 rows: $path" 2 }
  return $rows
}

# ------------------------------------------------------------------- README

<#
  找到所有"冻结表"候选：表头为 | 文件 | 大小 | SHA256 | 的 Markdown 表。
  返回 @( [pscustomobject]@{ HeaderLine=1基行号; Rows=@(path,size,hash,line) } )
#>
function Read-FreezeTables([string] $path) {
  $lines = [System.IO.File]::ReadAllLines($path)
  $tables = @()
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -notmatch '^\|\s*文件\s*\|\s*大小\s*\|\s*SHA256\s*\|\s*$') { continue }
    $headerLine = $i + 1
    $rows = @()
    $j = $i + 1
    if ($j -lt $lines.Count -and $lines[$j] -match '^\|[\s\-:|]+\|\s*$') { $j++ }   # 分隔行
    for (; $j -lt $lines.Count; $j++) {
      $line = $lines[$j]
      if ($line -notmatch '^\|') { break }
      $m = [regex]::Match($line, '^\|\s*`(?<path>[^`]+)`\s*\|\s*(?<size>[\d,]+)\s*\|\s*`(?<hash>[^`]+)`\s*\|\s*$')
      if (-not $m.Success) { continue }
      $rows += [pscustomobject]@{
        Path = $m.Groups['path'].Value
        Size = [int64] ($m.Groups['size'].Value -replace ',', '')
        Hash = $m.Groups['hash'].Value
        Line = $j + 1
      }
    }
    if ($rows.Count -gt 0) {
      $tables += [pscustomobject]@{ HeaderLine = $headerLine; Rows = $rows }
    }
  }
  return $tables
}

function Format-Size([int64] $size) { return $size.ToString('N0', [System.Globalization.CultureInfo]::InvariantCulture) }

function New-Fragment([object[]] $anchors) {
  $sb = New-Object System.Text.StringBuilder
  [void] $sb.AppendLine('| 文件 | 大小 | SHA256 |')
  [void] $sb.AppendLine('|---|---:|---|')
  foreach ($a in $anchors) {
    [void] $sb.AppendLine("| ``$($a.Path)`` | $(Format-Size $a.Size) | ``$($a.Hash)`` |")
  }
  return $sb.ToString().TrimEnd("`r", "`n")
}

# --------------------------------------------------------------------- main

$revPath = Resolve-FullPath $RevisionPath
$anchors = @(Read-Anchors $revPath)
if (-not $Quiet) { Write-Host "REVISION : $revPath  ($($anchors.Count) anchors)" }

if ($Mode -eq 'Generate') {
  $fragment = New-Fragment $anchors
  if ($OutFile) {
    [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($OutFile), $fragment + "`n", (New-Object System.Text.UTF8Encoding($false)))
    if (-not $Quiet) { Write-Host "wrote fragment -> $([System.IO.Path]::GetFullPath($OutFile))" }
  }
  else {
    Write-Output $fragment
  }

  if (-not $Apply) {
    if (-not $Quiet) { Write-Host 'note: Generate 模式默认只打印/写 OutFile；改 README 需要 -Apply（且 README 必须已有 FREEZE-TABLE 标记对）。' }
    exit 0
  }

  # ---- -Apply：只替换标记之间 ----
  $readmePath = Resolve-FullPath $ReadmePath
  $text = [System.IO.File]::ReadAllText($readmePath)
  $bi = $text.IndexOf($BeginMarker, [System.StringComparison]::Ordinal)
  $ei = $text.IndexOf($EndMarker, [System.StringComparison]::Ordinal)
  if ($bi -lt 0 -or $ei -lt 0 -or $ei -lt $bi) {
    Fail ("README 没有 $BeginMarker / $EndMarker 标记对 ⇒ 拒绝改动。建议加标记的位置：`n" +
          "  1) 把 **当前** 冻结表（README 里最后一张 | 文件 | 大小 | SHA256 | 表，P0.3 那张）整段包起来：`n" +
          "     <!-- FREEZE-TABLE-BEGIN -->`n     | 文件 | 大小 | SHA256 |`n     ...`n     <!-- FREEZE-TABLE-END -->`n" +
          "  2) 标记必须独占一行、前后不要留其它内容；历史冻结表（P0/P0.1/P0.2）**不要**加标记。`n" +
          "  3) 加完标记后再跑：sync-freeze-table.ps1 -Mode Generate -Apply") 2
  }
  $head = $text.Substring(0, $bi + $BeginMarker.Length)
  $tail = $text.Substring($ei)
  $new = $head + "`n" + $fragment + "`n" + $tail
  [System.IO.File]::WriteAllText($readmePath, $new, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "APPLIED: replaced bytes between markers in $readmePath"
  exit 0
}

# ---- Check ----
$readmePath = Resolve-FullPath $ReadmePath
$candidates = @(Read-FreezeTables $readmePath | Where-Object {
    $paths = $_.Rows | ForEach-Object { $_.Path }
    ($anchors | Where-Object { $paths -contains $_.Path }).Count -gt 0
  })
if ($candidates.Count -eq 0) { Fail "README 里找不到任何含 REVISION 锚点路径的冻结表: $readmePath" 1 }

$selected = if ($TableIndex -gt 0) {
    if ($TableIndex -gt $candidates.Count) { Fail "TableIndex=$TableIndex 超出候选表数量 $($candidates.Count)" 2 }
    $candidates[$TableIndex - 1]
  }
  else { $candidates[$candidates.Count - 1] }

if (-not $Quiet) {
  Write-Host "README   : $readmePath"
  Write-Host "表格      : 第 $($selected.HeaderLine) 行起（候选 $($candidates.Count) 张，取$(if ($TableIndex -gt 0) { " 第 $TableIndex 张" } else { '最后一张' })）"
  Write-Host '--- per-anchor ---'
}

$byPath = @{}
foreach ($r in $selected.Rows) { $byPath[$r.Path] = $r }

$problems = @()
foreach ($a in $anchors) {
  $line = if ($byPath.ContainsKey($a.Path)) { $byPath[$a.Path].Line } else { $selected.HeaderLine }
  $where = "${readmePath}:$line ($($a.Path))"
  if (-not $byPath.ContainsKey($a.Path)) {
    $problems += "MISSING  $where — README 表里没有这个锚点行"
    Write-Host "FAIL  $where  missing row"
    continue
  }
  $r = $byPath[$a.Path]
  $hashOk = [string]::Equals($r.Hash, $a.Hash, [System.StringComparison]::Ordinal)   # 区分大小写
  $sizeOk = ($r.Size -eq $a.Size)
  if ($hashOk -and $sizeOk) {
    Write-Host "PASS  $where  $($a.Hash.Substring(0, 12))…  $($a.Size)"
  }
  else {
    if (-not $hashOk) {
      $problems += "HASH     $where — README=$($r.Hash)  REVISION=$($a.Hash)"
      Write-Host "FAIL  $where  hash mismatch"
      Write-Host "        README   = $($r.Hash)"
      Write-Host "        REVISION = $($a.Hash)"
      for ($k = 0; $k -lt 64; $k++) {
        if ($r.Hash[$k] -ne $a.Hash[$k]) { Write-Host "        第一个不同字符：第 $($k + 1) 位（README='$($r.Hash[$k])' REVISION='$($a.Hash[$k])'）"; break }
      }
    }
    if (-not $sizeOk) {
      $problems += "SIZE     $where — README=$($r.Size)  REVISION=$($a.Size)"
      Write-Host "FAIL  $where  size mismatch (README=$($r.Size) REVISION=$($a.Size))"
    }
  }
}

# 表里多出来的行（不在 REVISION 里的路径）
foreach ($r in $selected.Rows) {
  if (-not ($anchors | Where-Object { $_.Path -eq $r.Path })) {
    $problems += "EXTRA    ${readmePath}:$($r.Line) ($($r.Path)) — README 表里有锚点集之外的路径"
    Write-Host "FAIL  ${readmePath}:$($r.Line) ($($r.Path))  extra row"
  }
}

if ($problems.Count -gt 0) {
  Write-Host ''
  Write-Host "RESULT: FAIL — $($problems.Count) 处不一致"
  $problems | ForEach-Object { Write-Host "  - $_" }
  exit 1
}

Write-Host ''
Write-Host "RESULT: PASS — $($anchors.Count)/$($anchors.Count) 锚点逐字一致（hash 大小写敏感 + 字节数）"
exit 0

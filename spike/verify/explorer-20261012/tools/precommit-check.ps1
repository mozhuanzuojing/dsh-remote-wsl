<#
.SYNOPSIS
  dsh-remote-wsl 的"提交前清单"：一条命令跑完，每项给 PASS/FAIL/WARN + 原始输出。

.DESCRIPTION
  把原来靠人肉跑的六类检查脚本化：
    01 git status 是否干净（插件仓库）
    02 README 冻结表 vs REVISION.txt（调用 sync-freeze-table.ps1 -Mode Check）
    03 交接文档双份一致（docs 侧 vs %TEMP% 侧）
    04 流水不变量（C:\Users\l\.agents\change-log.md：无 BOM / 无 CRLF / NUL 计数 / 行数）
    05 残留（端口 8911–8990 / WSL 守护 / launch.*.sh / dsh-rwsl* unit / failed user unit / 可见窗口 / 活宿主 19387 pid）
    06 远端 origin HEAD == 本地 HEAD

  判定原则（刻意保守，避免"凭标题猜"）：
    * 端口/窗口这两项**只在能给出归属证据时**判 FAIL：命令行动匹配我们自己的标记
      （dsh-remote-wsl / remote-wsl / dsh-rwsl / usab-ux 之外的我们的 profile），
      否则记 WARN 并把 pid/父 pid/命令行/启动时间原样贴出，交给人判。
      `-FailOnAnyListener` / `-FailOnVisibleWindow` 可切换成严格模式。
    * 网络不可达（代理未起）时 06 记 WARN 而不是 FAIL，并贴出原始报错。

  绝不做的事：不 Start-Process、不 detached、不杀任何进程、不写除自己目录外的文件。
  端口段 8911–8990 只读探测；用户宿主 19387 只读报告 pid，绝不触碰。

.EXAMPLE
  pwsh -File precommit-check.ps1
  pwsh -File precommit-check.ps1 -FailOnAnyListener
#>
[CmdletBinding()]
param(
  [string] $PluginRepo = "$PSScriptRoot\..\..\..\..",
  [string] $HandoffDocs = 'D:\project\net1\docs\handoff\2026-10-10-dsh-remote-wsl-守护接入与差距.md',
  [string] $HandoffTwin = "$env:TEMP\handoff-remote-wsl-daemon-20261010.md",
  [string] $ChangeLog = 'C:\Users\l\.agents\change-log.md',
  [string] $WslDistro = 'debian-u8-1',
  [int] $PortFrom = 8911,
  [int] $PortTo = 8990,
  [int] $ExpectNul = 1,
  [int] $ExpectLogLines = 0,
  [int64] $ExpectLogBytes = 0,
  [switch] $FailOnAnyListener,
  [switch] $FailOnVisibleWindow,
  [switch] $SkipNetwork,
  [switch] $WithControls,
  [int] $NetworkTimeoutSec = 25,
  # ── T68：05f 可见窗口归属（机器可判：启动时间 + 父链；**禁凭标题**）────────────────
  # 本次"运行时间窗"的起点。默认 = 脚本启动时刻往前 $WindowSlackMinutes 分钟。
  # 旁路：显式给一个时间点复现（例如把窗口起点指到 notepad 启动之前）。
  [datetime] $WindowSince = [datetime]::MinValue,
  # 允许的时钟/启动抖动（分钟）。落窗外 ⇒ 不可能是本次动作造的窗口。
  [int] $WindowSlackMinutes = 15,
  # 复现/负向测试用：注入一个**取不到启动时间的假 pid**，证明"不可判定 ⇒ WARN（不落成 PASS）"。
  [switch] $WindowProbeUndecidable
)

$ErrorActionPreference = 'Continue'
$results = New-Object System.Collections.Generic.List[object]
# 运行时间窗起点（05f 用；越早记录越准 —— 前面的 git/wsl 探测也要算进来）
$RunStartedAt = Get-Date
if ($WindowSince -eq [datetime]::MinValue) { $WindowSince = $RunStartedAt.AddMinutes(-1 * [Math]::Abs($WindowSlackMinutes)) }

function Add-Result([string] $id, [string] $name, [string] $verdict, [string] $detail) {
  $results.Add([pscustomobject]@{ Id = $id; Name = $name; Verdict = $verdict; Detail = $detail })
  $color = switch ($verdict) { 'PASS' { 'Green' } 'FAIL' { 'Red' } 'WARN' { 'Yellow' } default { 'Gray' } }
  Write-Host ("[{0}] {1,-28} {2}  {3}" -f $verdict, $name, $id, $detail) -ForegroundColor $color
}

function Write-Raw([string] $title, [string] $text) {
  Write-Host "----- $title -----" -ForegroundColor DarkGray
  if ([string]::IsNullOrWhiteSpace($text)) { Write-Host '(empty)' -ForegroundColor DarkGray }
  else { Write-Host $text.TrimEnd() }
  Write-Host '-------------------' -ForegroundColor DarkGray
}

function Get-OwnerInfo([int] $pid_) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pid_" -ErrorAction SilentlyContinue
  if (-not $proc) { return [pscustomobject]@{ Pid = $pid_; Name = '?'; Parent = 0; Cmd = '' } }
  return [pscustomobject]@{ Pid = $proc.ProcessId; Name = $proc.Name; Parent = $proc.ParentProcessId; Cmd = ($proc.CommandLine ?? '') }
}

# 我们自己的标记：只有命令行里出现这些才算"可能是我们"
$ourMarkers = @('dsh-remote-wsl', 'dsh-rwsl', 'remote-wsl-ux', 'remote-wsl-test', 'explorer-20261012')
function Test-IsOurs([string] $cmdline) {
  if ([string]::IsNullOrEmpty($cmdline)) { return $false }
  foreach ($m in $ourMarkers) { if ($cmdline -like "*$m*") { return $true } }
  return $false
}

$repo = [System.IO.Path]::GetFullPath($PluginRepo)
Write-Host "=== dsh-remote-wsl precommit check ===" -ForegroundColor Cyan
Write-Host "repo: $repo"
Write-Host "time: $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Host ''

# ---------------------------------------------------------------- 01 git status
$statusRaw = (& git -C $repo status --short 2>&1 | Out-String)
$sl = @($statusRaw -split "`n" | Where-Object { $_.Trim().Length -gt 0 })
if ($sl.Count -eq 0) { Add-Result '01' 'git status 干净' 'PASS' '工作树无未提交改动' }
else { Add-Result '01' 'git status 干净' 'FAIL' "$($sl.Count) 条未提交改动（提交前必须为空）" }
Write-Raw '01 git status --short' $statusRaw

# ---------------------------------------------------------- 02 冻结表 vs REVISION
$syncScript = Join-Path $PSScriptRoot 'sync-freeze-table.ps1'
$freezeOut = (& pwsh -NoProfile -File $syncScript -Mode Check 2>&1 | Out-String)
$freezeCode = $LASTEXITCODE
if ($freezeCode -eq 0) { $n = ([regex]::Match($freezeOut, 'RESULT: PASS — (\d+)/(\d+)')).Groups[2].Value; if (-not $n) { $n = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\REVISION.txt') | Select-String -Pattern '^\s*[0-9a-f]{64}\s').Count }; Add-Result '02' 'README 冻结表 vs REVISION' 'PASS' "$n 锚点逐字一致" }
else { Add-Result '02' 'README 冻结表 vs REVISION' 'FAIL' "sync-freeze-table -Mode Check 退出码 $freezeCode" }
Write-Raw '02 sync-freeze-table -Mode Check' $freezeOut

# ------------------------------------------------------------- 03 交接双份一致
$docsPath = [System.IO.Path]::GetFullPath($HandoffDocs)
$twinPath = [System.IO.Path]::GetFullPath($HandoffTwin)
if (-not (Test-Path -LiteralPath $docsPath)) {
  Add-Result '03' '交接双份一致' 'FAIL' "docs 侧不存在: $docsPath"
  Write-Raw '03 handoff' ''
}
elseif (-not (Test-Path -LiteralPath $twinPath)) {
  Add-Result '03' '交接双份一致' 'FAIL' "%TEMP% 侧不存在: $twinPath"
  Write-Raw '03 handoff' ''
}
else {
  $h1 = (Get-FileHash -LiteralPath $docsPath -Algorithm SHA256).Hash.ToLower()
  $h2 = (Get-FileHash -LiteralPath $twinPath -Algorithm SHA256).Hash.ToLower()
  $l1 = ([System.IO.File]::ReadAllBytes($docsPath)).Length
  $l2 = ([System.IO.File]::ReadAllBytes($twinPath)).Length
  $t = "docs : $h1  $l1 bytes  $docsPath`ntwin : $h2  $l2 bytes  $twinPath"
  if ($h1 -eq $h2) { Add-Result '03' '交接双份一致' 'PASS' "同一 SHA256（$l1 bytes）" }
  else { Add-Result '03' '交接双份一致' 'FAIL' "SHA256 不同（docs $l1 bytes / twin $l2 bytes）" }
  Write-Raw '03 handoff hashes' $t
}

# --------------------------------------------------------- 04 流水不变量
if (-not (Test-Path -LiteralPath $ChangeLog)) {
  Add-Result '04' '流水不变量' 'FAIL' "change-log 不存在: $ChangeLog"
}
else {
  $bytes = [System.IO.File]::ReadAllBytes($ChangeLog)
  $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $nul = 0; foreach ($b in $bytes) { if ($b -eq 0) { $nul++ } }
  $crlf = 0; for ($i = 0; $i -lt $bytes.Length - 1; $i++) { if ($bytes[$i] -eq 13 -and $bytes[$i + 1] -eq 10) { $crlf++ } }
  $lf = 0; foreach ($b in $bytes) { if ($b -eq 10) { $lf++ } }
  $endsNl = ($bytes.Length -gt 0 -and $bytes[$bytes.Length - 1] -eq 10)
  $logicalLines = @([System.IO.File]::ReadAllLines($ChangeLog)).Count
  $detail = "bytes=$($bytes.Length) BOM=$bom CRLF=$crlf LF=$lf NUL=$nul logicalLines=$logicalLines endsWithNewline=$endsNl"
  $bad = @()
  if ($bom) { $bad += 'UTF-8 BOM 存在（要求无 BOM）' }
  if ($crlf -gt 0) { $bad += "CRLF=$crlf（要求 LF-only）" }
  if ($nul -ne $ExpectNul) { $bad += "NUL=$nul（期望 $ExpectNul）" }
  if ($ExpectLogLines -gt 0 -and $logicalLines -ne $ExpectLogLines) { $bad += "行数=$logicalLines（期望 $ExpectLogLines）" }
  if ($ExpectLogBytes -gt 0 -and $bytes.Length -ne $ExpectLogBytes) { $bad += "字节=$($bytes.Length)（期望 $ExpectLogBytes）" }
  if ($bad.Count -eq 0) { Add-Result '04' '流水不变量' 'PASS' $detail }
  else { Add-Result '04' '流水不变量' 'FAIL' ($bad -join '; ') }
  Write-Raw '04 change-log invariants' "$detail`n$($bad -join "`n")"
}

# ------------------------------------------------------------- 05 残留
# 05a 端口
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -ge $PortFrom -and $_.LocalPort -le $PortTo })
$portLines = @()
$oursListeners = @()
foreach ($l in ($listeners | Sort-Object LocalPort)) {
  $o = Get-OwnerInfo $l.OwningProcess
  $mark = if (Test-IsOurs $o.Cmd) { 'OURS?' } else { 'foreign' }
  if ($mark -eq 'OURS?') { $oursListeners += $l }
  $portLines += ("{0}:{1}  pid={2} parent={3} {4}  [{5}]`n    {6}" -f $l.LocalAddress, $l.LocalPort, $o.Pid, $o.Parent, $o.Name, $mark, $o.Cmd)
}
$portText = ($portLines -join "`n")
if ($listeners.Count -eq 0) { Add-Result '05a' "端口 $PortFrom-$PortTo 无监听" 'PASS' '区间内 0 个监听者' }
elseif ($oursListeners.Count -gt 0 -or $FailOnAnyListener) {
  Add-Result '05a' "端口 $PortFrom-$PortTo 无监听" 'FAIL' "$($listeners.Count) 个监听者（其中可归属我们的 $($oursListeners.Count) 个）"
}
else { Add-Result '05a' "端口 $PortFrom-$PortTo 无监听" 'WARN' "$($listeners.Count) 个监听者，但命令行不含我们的标记（见原始输出，归属交人判）" }
Write-Raw "05a listeners $PortFrom-$PortTo" $portText

# 05b WSL 侧残留（守护 / launch.*.sh / dsh-rwsl* unit / failed unit）—— 一次 wsl 调用取回
$wslProbe = @'
echo "@@DAEMON@@"; pgrep -af 'dsh' 2>/dev/null | grep -v 'pgrep -af' | grep -v 'systemctl' | head -20
echo "@@LAUNCH@@"; ls -1 "$HOME/.dsh/remote-wsl"/launch.*.sh 2>/dev/null
echo "@@UNITS@@"; systemctl --user list-units 'dsh-rwsl*' --all --no-legend --no-pager 2>/dev/null
echo "@@FAILED@@"; systemctl --user list-units --state=failed --no-legend --no-pager 2>/dev/null
echo "@@FAILEDCOUNT@@"; systemctl --user list-units --state=failed --no-legend --no-pager 2>/dev/null | sed '/^\s*$/d' | wc -l
'@
$wslOut = ''
try {
  $wslOut = (& wsl.exe -d $WslDistro -- bash -lc $wslProbe 2>&1 | Out-String)
} catch { $wslOut = "wsl call failed: $($_.Exception.Message)" }
# wsl.exe 的自身横幅是 UTF-16（夹 NUL），并可能混入 CRLF ⇒ 先归一化再解析，
# 否则标记行匹配会静默失败（教训：本脚本第一版就因此把"有 failed unit"误判成 PASS）。
$wslNorm = ($wslOut -replace "`0", '') -replace "`r", ''
Write-Raw '05b WSL probe (normalized)' $wslNorm

function Get-WslSection([string] $text, [string] $marker) {
  # ^@@MARKER@@ 之后、下一个 ^@@...@@ 之前的所有非空行
  $m = [regex]::Match($text, "(?ms)^@@$([regex]::Escape($marker))@@[^\n]*\n(?<body>.*?)(?=^@@|\z)")
  if (-not $m.Success) { return @() }
  return @($m.Groups['body'].Value -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
}
$daemonLines = @(Get-WslSection $wslNorm 'DAEMON')
$launchLines = @(Get-WslSection $wslNorm 'LAUNCH')
$unitLines = @(Get-WslSection $wslNorm 'UNITS')
$failedLines = @(Get-WslSection $wslNorm 'FAILED')
$failedCountRaw = @(Get-WslSection $wslNorm 'FAILEDCOUNT')
$parsedFailedCount = if ($failedCountRaw.Count -gt 0) { ($failedCountRaw[-1] -replace '[^0-9]', '') } else { '' }
# 自校验：`list-units --state=failed` 的**实列行数**与 `wc -l` 的计数必须一致；
# 不一致或解析不到就以"实列行数"为准（宁可红，不可假绿），并标 WARN 说明量具不一致。
$failedCount = $failedLines.Count
$instrumentMismatch = $false
if ($parsedFailedCount -eq '') { $instrumentMismatch = $true }
elseif ([int] $parsedFailedCount -ne $failedLines.Count) { $instrumentMismatch = $true }
if ($instrumentMismatch) {
  Write-Host ("[WARN] 05e 量具自查：list-units 实列 $($failedLines.Count) 行，wc -l 计数 '$parsedFailedCount' ⇒ 以实列行数为准") -ForegroundColor Yellow
}

if ($daemonLines.Count -eq 0) { Add-Result '05b' 'WSL 守护残留' 'PASS' 'pgrep 无 dsh 进程' }
else { Add-Result '05b' 'WSL 守护残留' 'FAIL' "$($daemonLines.Count) 条 dsh 进程（见原始输出）" }

if ($launchLines.Count -eq 0) { Add-Result '05c' 'launch.*.sh 包装层' 'PASS' '~/.dsh/remote-wsl/ 下无 launch.*.sh' }
else { Add-Result '05c' 'launch.*.sh 包装层' 'FAIL' "$($launchLines.Count) 个残留: $($launchLines -join ', ')" }

if ($unitLines.Count -eq 0) { Add-Result '05d' 'dsh-rwsl* unit' 'PASS' '无 dsh-rwsl* user unit' }
else { Add-Result '05d' 'dsh-rwsl* unit' 'FAIL' "$($unitLines.Count) 个 unit（见原始输出）" }

if ($failedCount -eq 0) { Add-Result '05e' 'failed user unit = 0' 'PASS' 'systemctl --user list-units --state=failed 实列 0 行' }
else { Add-Result '05e' 'failed user unit = 0' 'FAIL' "failed user unit = $failedCount（必须 0；收尾需 stop + reset-failed）$(if ($instrumentMismatch) { ' [量具不一致，已按实列行数判定]' })" }

# 05f 可见窗口归属（T68：**机器可判** —— 启动时间窗 + 父链；**标题只作参考、禁作依据**）
#
# 判据（与本项目历轮手工裁定一致）：
#   · 窗口进程**启动时刻落在运行时间窗内** ∧ 父链里出现"我方工具链"名字 ⇒ **FAIL（我方产生了可见窗口）**
#   · 落在窗外 ⇒ 一定是早于本次运行的进程 ⇒ **PASS（归属他人）**
#   · 取不到启动时间/父链 ⇒ **WARN（绝不记 PASS）**
# 为什么"启动时间"是主判据：同一台机器上用户的 VS Code / 浏览器 / 用户宿主都在跑，
# 命令行与标题都可能与我们高度相似（F-37 第一次就是被标题误导过）⇒ **只认时间与进程树**。

$OUR_CHAIN_NAMES = @(
  'pwsh', 'powershell', 'cmd', 'conhost', 'node', 'dsh', 'bash', 'wsl', 'wslhost', 'wslrelay',
  'windowsterminal', 'wt', 'python', 'python3'
)
# 明确**不算我方**的名字：用户的桌面壳 / 用户宿主 / 编辑器 / 浏览器（它们常在父链上，绝不能被算成我们）
$NEVER_OURS_NAMES = @(
  'explorer', 'deepseek harness', 'code', 'cursor', 'chrome', 'msedge', 'firefox',
  'qq', 'weixin', 'textinputhost', 'gephgui-wry'
)

function Get-ProcChain([int] $TargetPid, [int] $MaxDepth = 8) {
  # 返回父链（含自身，最多 MaxDepth 层）。取不到 ⇒ 返回 @()（调用方据此判"不可判定"）。
  # ⚠ 参数**不能**叫 `$Pid`：PowerShell 的 `$PID` 是只读自动变量（大小写不敏感），
  #   命名成 `$Pid` 会让绑定失败 ⇒ 父链恒空、全部误判成 UNDECIDABLE（T68 首跑就踩到）。
  $script:ChainLastError = $null
  $chain = @()
  $cur = $TargetPid
  for ($i = 0; $i -lt $MaxDepth -and $cur -gt 0; $i++) {
    $ci = $null
    try { $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction Stop }
    catch { $script:ChainLastError = "Get-CimInstance(pid=$cur) 失败: $($_.Exception.Message)"; break }
    if ($null -eq $ci) { $script:ChainLastError = "pid=$cur 在 Win32_Process 里查不到（可能已退出）"; break }
    $chain += [pscustomobject]@{ Pid = [int]$ci.ProcessId; Parent = [int]$ci.ParentProcessId; Name = [string]$ci.Name }
    $cur = [int]$ci.ParentProcessId
  }
  return $chain
}

function Test-ChainIsOurs($Chain) {
  foreach ($e in $Chain) {
    $n = ([string]$e.Name).ToLowerInvariant() -replace '\.exe$', ''
    if ($NEVER_OURS_NAMES -contains $n) { return $false }   # 碰到用户应用 ⇒ 明确不是我们
    if ($OUR_CHAIN_NAMES -contains $n) { return $true }
  }
  return $false
}

$winLines = @()
$ourWindows = @()
$undecidableWindows = @()
$foreignWindows = @()

$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
if ($WindowProbeUndecidable) {
  # 注入一个不存在的 pid：证明"取不到启动时间/父链 ⇒ WARN"这条分支真的会走（T68 验收③）
  $procs += [pscustomobject]@{ Id = 999999; ProcessName = '<injected-undecidable>'; StartTime = $null; MainWindowTitle = '(injected)'; MainWindowHandle = 1 }
}

foreach ($p in $procs) {
  $o = Get-OwnerInfo $p.Id
  $chain = @(Get-ProcChain $p.Id)
  $started = $null
  try { if ($p.StartTime) { $started = [datetime]$p.StartTime } } catch { $started = $null }
  $chainOurs = Test-ChainIsOurs $chain
  $inWindow = ($null -ne $started) -and ($started -ge $WindowSince)

  if ($null -eq $started -or $chain.Count -eq 0) {
    $verdict = 'UNDECIDABLE'
    $undecidableWindows += $p.Id
    if ($null -eq $started) { $script:ChainLastError = "取不到 StartTime（pid=$($p.Id)）" }
  }
  elseif ($chainOurs -and $inWindow) {
    $verdict = 'OURS'
    $ourWindows += $p.Id
  }
  else {
    $verdict = 'foreign'
    $foreignWindows += $p.Id
  }

  $chainText = if ($chain.Count -gt 0) { ($chain | ForEach-Object { "$($_.Name)#$($_.Pid)" }) -join ' <- ' } else { "(取不到父链：$($script:ChainLastError))" }
  $startText = if ($null -ne $started) { $started.ToString('yyyy-MM-dd HH:mm:ss') } else { '(取不到启动时间)' }
  $winLines += ("pid={0} {1}  start={2}  parent={3}  verdict={4}`n    chain= {5}`n    inWindow={6}  chainIsOurs={7}`n    title(仅供参考,禁作为归属依据)= {8}`n    cmd= {9}" -f `
      $o.Pid, $o.Name, $startText, $o.Parent, $verdict, $chainText, $inWindow, $chainOurs, $p.MainWindowTitle, $o.Cmd)
}
$winLines += ("`n窗口起点 WindowSince = {0:yyyy-MM-dd HH:mm:ss}（脚本启动 {1:yyyy-MM-dd HH:mm:ss}，抖动 {2} 分钟）" -f $WindowSince, $RunStartedAt, $WindowSlackMinutes)
$winLines += ("归属汇总：ours={0} foreign={1} undecidable={2}" -f $ourWindows.Count, $foreignWindows.Count, $undecidableWindows.Count)
Write-Raw '05f visible windows (pid/start/parent-chain = 归属证据, 禁凭标题)' (($winLines -join "`n"))

if ($ourWindows.Count -gt 0 -or ($FailOnVisibleWindow -and $procs.Count -gt 0)) {
  Add-Result '05f' '可见窗口（归属机器判定）' 'FAIL' "$($procs.Count) 个可见窗口；**可归属我方 pid = $($ourWindows -join ', ')**（启动时间落在窗内 ∧ 父链含我方工具链）"
}
elseif ($procs.Count -eq 0) { Add-Result '05f' '可见窗口（归属机器判定）' 'PASS' '当前无可见顶层窗口' }
elseif ($undecidableWindows.Count -gt 0) {
  Add-Result '05f' '可见窗口（归属机器判定）' 'WARN' "$($procs.Count) 个可见窗口中 $($undecidableWindows.Count) 个**取不到启动时间/父链** ⇒ 无法判定（pid=$($undecidableWindows -join ', ')）；**绝不记 PASS**"
}
else { Add-Result '05f' '可见窗口（归属机器判定）' 'PASS' "$($procs.Count) 个可见窗口全部归属他人（均早于本次运行窗或父链为用户应用）；逐窗证据见原始输出" }

# 05g 活宿主 19387
$host19387 = @(Get-NetTCPConnection -LocalPort 19387 -State Listen -ErrorAction SilentlyContinue)
if ($host19387.Count -eq 0) { Add-Result '05g' '活宿主 19387' 'WARN' '19387 无监听（用户宿主可能未运行）' }
else {
  $o = Get-OwnerInfo $host19387[0].OwningProcess
  Add-Result '05g' '活宿主 19387' 'PASS' "pid=$($o.Pid) parent=$($o.Parent) $($o.Name)（**只报告，绝不触碰**）"
  Write-Raw '05g live host 19387' "pid=$($o.Pid) parent=$($o.Parent) name=$($o.Name)`ncmd=$($o.Cmd)"
}

# ------------------------------------------------------- 06 远端 == 本地 HEAD
$localHead = (& git -C $repo rev-parse HEAD 2>&1 | Out-String).Trim()
$remoteOut = ''
if ($SkipNetwork) {
  Add-Result '06' '远端 origin == 本地 HEAD' 'WARN' "-SkipNetwork：跳过（本地 HEAD=$($localHead.Substring(0,12))…）"
}
else {
  # 直接调用 git（不 Start-Process / 不 Start-Job，避免任何窗口面）；用 git 自己的低速超时兜底。
  $prevPrompt = $env:GIT_TERMINAL_PROMPT
  $env:GIT_TERMINAL_PROMPT = '0'
  try {
    $remoteOut = (& git -C $repo -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10 ls-remote origin HEAD 2>&1 | Out-String).Trim()
  }
  catch { $remoteOut = "git ls-remote threw: $($_.Exception.Message)" }
  finally { $env:GIT_TERMINAL_PROMPT = $prevPrompt }
  $remoteHead = if ($remoteOut -match '^(?<h>[0-9a-f]{40})\s') { $Matches['h'] } else { '' }
  Write-Raw '06 git ls-remote origin HEAD' "local : $localHead`nremote: $remoteOut"
  if ($remoteHead -eq '') { Add-Result '06' '远端 origin == 本地 HEAD' 'WARN' "取不到远端（代理/网络）：$(($remoteOut -split "`n")[0])" }
  elseif ($remoteHead -eq $localHead) { Add-Result '06' '远端 origin == 本地 HEAD' 'PASS' "$($localHead.Substring(0,12))… 一致" }
  else { Add-Result '06' '远端 origin == 本地 HEAD' 'FAIL' "local=$localHead remote=$remoteHead" }
}

# ------------------------------------------- 07 client chunk rev 门禁（task-37）
# 机制：chunk 的 URL rev 取自**入口** `client/index.js` 的元数据（mtimeMs/ctimeMs/size），
#   且路由带 immutable ⇒ 只改 chunk 不改入口 ⇒ 平台不重扫、URL 也不变 ⇒ 连空缓存的新客户端也拿旧脚本。
#   详见 docs/client-contract.md §11；脚本 spike/verify/explorer-20261012/tools/check-client-rev.ts（2026-10-14 由 .mjs 更名，判据未改）。
# 退出码映射：0=PASS；1=FAIL（chunk 变了而入口未 bump）；2=脚本用法/环境错 ⇒ FAIL；3=判定不可得 ⇒ **WARN**（绝不当 PASS）
# 测试旁路（不改 client/** 即可演示红）：
#   $env:DSRW_CHUNKREV_ROOT = '<插件根，默认 $PluginRepo>'
#   $env:DSRW_CHUNKREV_ARGS = '--mode baseline --baseline <不存在的文件>'   # 用来演示 exit 3 ⇒ WARN
$revScript = Join-Path $PSScriptRoot 'check-client-rev.ts'
if (-not (Test-Path -LiteralPath $revScript)) {
  Add-Result '07' 'client chunk rev 门禁' 'WARN' "找不到 $revScript（跳过）"
}
else {
  $revNode = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $revNode) {
    foreach ($cand in @("$env:LOCALAPPDATA\mise\shims\node.exe", 'C:\Users\l\AppData\Local\mise\shims\node.exe')) {
      if (Test-Path -LiteralPath $cand) { $revNode = $cand; break }
    }
  }
  if (-not $revNode) { Add-Result '07' 'client chunk rev 门禁' 'WARN' '找不到 node（无法判定）' }
  else {
    $revRoot = if ($env:DSRW_CHUNKREV_ROOT) { $env:DSRW_CHUNKREV_ROOT } else { $PluginRepo }
    $revExtra = if ($env:DSRW_CHUNKREV_ARGS) { $env:DSRW_CHUNKREV_ARGS -split '\s+' } else { @() }
    $revOut = (& $revNode $revScript --root $revRoot @revExtra 2>&1 | Out-String)
    $revCode = $LASTEXITCODE
    $revHead = (($revOut -split "`n") | Where-Object { $_.Trim() } | Select-Object -First 1)
    if ($revCode -eq 0) { Add-Result '07' 'client chunk rev 门禁' 'PASS' $revHead }
    elseif ($revCode -eq 1) { Add-Result '07' 'client chunk rev 门禁' 'FAIL' "$revHead ⇒ 改任何 chunk 必须同时改 client/index.js（见 docs/client-contract.md §11）" }
    elseif ($revCode -eq 3) { Add-Result '07' 'client chunk rev 门禁' 'WARN' "判定不可得（无 git 且无基线）⇒ 需人判：$revHead" }
    else { Add-Result '07' 'client chunk rev 门禁' 'FAIL' "脚本自身出错 exit=$revCode：$revHead" }
    Write-Raw '07 check-client-rev.ts --root ' $revOut
  }
}

  # ------------------------------------------- 08 漏 import 扫描（task-47/T51）
  # 机制：本仓"零构建 TS + 相对 `.ts`" ⇒ **漏 import 不在 import 期报错**，只有执行到那一行才 ReferenceError
  #   ⇒ "调用期才炸"。同型已出现三次：T3 `launchScript`→`daemonScriptWsl`；T5 `wsl-io.ts` 漏 `spawn`；
  #   T47 `register-tools.ts` 漏 `allowBuildFlags`（`wsl_open_ui` 启动）+ 漏 `reapWsl`（**收尾**才炸）。
  #   详见 arch-t5/REPORT-openui-p0.md；脚本 arch-t5/tools/scan-missing-imports.ts。
  # 退出码映射：0=PASS；1=FAIL（命中，列出 `标识符@行号`）；2=无法判定 ⇒ **WARN**（绝不当 PASS）；其它 ⇒ FAIL。
  # 测试旁路：$env:DSRW_SCANROOT = '<要扫的 src 目录，默认 $PluginRepo\src>'（用于在副本上演示红/WARN）。
  # -WithControls：在 %TEMP% 副本上抽掉一个 import，验证扫描器仍能命中（灵敏度对照；不碰仓库）。
  $scanScript = Join-Path (Split-Path $PSScriptRoot -Parent) 'arch-t5\tools\scan-missing-imports.ts'
  if (-not (Test-Path -LiteralPath $scanScript)) {
    Add-Result '08' '漏 import 扫描' 'WARN' "找不到 $scanScript（跳过）"
  }
  else {
    $scanNode = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $scanNode) {
      foreach ($cand in @("$env:LOCALAPPDATA\mise\shims\node.exe", 'C:\Users\l\AppData\Local\mise\shims\node.exe')) {
        if (Test-Path -LiteralPath $cand) { $scanNode = $cand; break }
      }
    }
    if (-not $scanNode) { Add-Result '08' '漏 import 扫描' 'WARN' '找不到 node（无法判定）' }
    else {
      $scanRoot = if ($env:DSRW_SCANROOT) { $env:DSRW_SCANROOT } else { Join-Path $PluginRepo 'src' }
      $scanFiles = @()
      if (Test-Path -LiteralPath $scanRoot) {
        $scanFiles = @(Get-ChildItem -LiteralPath $scanRoot -Recurse -Filter '*.ts' -File | ForEach-Object { $_.FullName })
      }
      if ($scanFiles.Count -eq 0) {
        Add-Result '08' '漏 import 扫描' 'WARN' "在 $scanRoot 下找不到 .ts（无法判定）"
      }
      else {
        $scanOut = (& $scanNode $scanScript @scanFiles 2>&1 | Out-String)
        $scanCode = $LASTEXITCODE
        $scanHead = (($scanOut -split "`r?`n") | Where-Object { $_ -match '命中合计|命中 ⇒|SCAN_UNDECIDABLE' } | Select-Object -First 3) -join ' / '
        if ($scanCode -eq 0) { Add-Result '08' '漏 import 扫描' 'PASS' "$($scanFiles.Count) 文件 / $scanHead" }
        elseif ($scanCode -eq 1) { Add-Result '08' '漏 import 扫描' 'FAIL' "命中：$scanHead ⇒ 补对应 import（零构建 TS 只在调用期报错）" }
        elseif ($scanCode -eq 2) { Add-Result '08' '漏 import 扫描' 'WARN' "判定不可得 ⇒ 需人判：$scanHead" }
        else { Add-Result '08' '漏 import 扫描' 'FAIL' "脚本自身出错 exit=$scanCode：$scanHead" }
        Write-Raw '08 scan-missing-imports.ts' $scanOut
      }
      if ($WithControls) {
        $ctlDir = Join-Path $env:TEMP ('dsh-rw-scanctl-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        New-Item -ItemType Directory -Path $ctlDir -Force | Out-Null
        try {
          $victim = Join-Path $PluginRepo 'src\register-tools.ts'
          if (-not (Test-Path -LiteralPath $victim)) {
            Add-Result '08c' '漏 import 对照（灵敏度）' 'WARN' "找不到 $victim ⇒ 对照未做"
          }
          else {
            $copy = Join-Path $ctlDir 'register-tools.ts'
            $orig = Get-Content -LiteralPath $victim -Raw
            $mut = $orig -replace "(?m)^[ \t]*import \{[^}]*allowBuildFlags[^}]*\} from '\./sdk-runtime\.ts';[ \t]*\r?\n", ''
            if ($mut -eq $orig) {
              Add-Result '08c' '漏 import 对照（灵敏度）' 'WARN' '副本里没找到可抽掉的 allowBuildFlags import ⇒ 对照未生效'
            }
            else {
              [IO.File]::WriteAllText($copy, $mut, (New-Object Text.UTF8Encoding($false)))
              $ctlOut = (& $scanNode $scanScript $copy 2>&1 | Out-String)
              $ctlCode = $LASTEXITCODE
              if ($ctlCode -eq 1) { Add-Result '08c' '漏 import 对照（灵敏度）' 'PASS' '抽掉 allowBuildFlags import ⇒ 扫描器命中（夹具真灵）' }
              else { Add-Result '08c' '漏 import 对照（灵敏度）' 'FAIL' "抽掉 import 后扫描器未命中（exit=$ctlCode）⇒ 判据可能失效" }
              Write-Raw '08c control' $ctlOut
            }
          }
        }
        finally { Remove-Item -LiteralPath $ctlDir -Recurse -Force -ErrorAction SilentlyContinue }
      }
    }
  }

# -------------------------------------------------------------------- summary
Write-Host ''
Write-Host '=== SUMMARY ===' -ForegroundColor Cyan
$fails = @($results | Where-Object { $_.Verdict -eq 'FAIL' })
$warns = @($results | Where-Object { $_.Verdict -eq 'WARN' })
foreach ($r in $results) { Write-Host ("  {0,-4} {1,-28} {2}" -f $r.Verdict, $r.Name, $r.Detail) }
Write-Host ''
Write-Host ("PASS={0}  WARN={1}  FAIL={2}" -f @($results | Where-Object { $_.Verdict -eq 'PASS' }).Count, $warns.Count, $fails.Count)
if ($fails.Count -gt 0) {
  Write-Host 'RESULT: FAIL —— 逐条见上（每项都有原始输出）' -ForegroundColor Red
  exit 1
}
if ($warns.Count -gt 0) { Write-Host 'RESULT: PASS（含 WARN：需人判的项已给出归属证据）' -ForegroundColor Yellow; exit 0 }
Write-Host 'RESULT: PASS' -ForegroundColor Green
exit 0

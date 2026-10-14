#!/usr/bin/env pwsh
<#
.SYNOPSIS
  INJ-A —— 杀死守护后刷新面板（FMEA F4/F5/F18/F22/F23 的端到端注入实验）。

.DESCRIPTION
  分阶段执行，**每阶段可单独跑**（便于在浏览器步骤前后插证据）：

    capture  → 落 before 证据（revision / 活宿主 pid / snapshot / wsl_status / 归一状态）
    kill     → **只停本插件自有槽位**，再证明 snapshot 已变 running:false
    <浏览器> → 刷新面板 + 抽取 DOM（由 agent 用 browser/extract-panel.js + 截图完成，见 INJECTION-PLAN §1）
    verify   → 对 kill 态的面板抽取做断言（可读错误 / 非白屏 / 无陈旧 pid）
    restore  → 幂等 ensure，落 after 证据，比较 before/after
    all      → capture + kill（浏览器步骤请停在 kill 之后，手动/工具做完再跑 verify / restore）

  纪律（脚本内硬守卫，违反即拒跑）：
   · 必须带 -Go；
   · 端口必须落在 8971–8980，且不得命中 19387（用户宿主）/ 9910（proxy）；
   · 每次动作前复验 19387 的 listener pid 未变（基线 47564）；
   · daemon 动作**只允许** slot ∈ {8972,8973,8974}，**禁止** all=true（对请求体做字符串级断言）；
   · 不改被验对象；不全局 pkill；只按记录的 pid 收自己起的进程。

.EXAMPLE
  pwsh ./inject-a-daemon-kill.ps1 -Phase capture -Go
  pwsh ./inject-a-daemon-kill.ps1 -Phase kill    -Go
  # （浏览器：刷新面板 → 抽取 → 截图）
  pwsh ./inject-a-daemon-kill.ps1 -Phase verify  -Go
  pwsh ./inject-a-daemon-kill.ps1 -Phase restore -Go
#>
[CmdletBinding()]
param(
  [ValidateSet('capture', 'kill', 'verify', 'restore', 'all')]
  [string]$Phase = 'capture',
  [int]$WebPort = 8971,
  [int]$DaemonPort = 8972,
  # lead 2026-10-12 批准：capture 必须自证"配置槽位 = ExpectedSlot"（默认等于 DaemonPort）。
  # 故意红测试：-ExpectedSlot 8912 ⇒ capture 必须 exit 3（证明前置断言有区分力）。
  [int]$ExpectedSlot = 8972,
  [string]$NodeExe = 'C:\Users\l\AppData\Local\mise\shims\node.exe',
  [switch]$Go,
  [switch]$UseUserHome
)

# ── T73：默认**孤立** DSH_HOME（-UseUserHome 才用真实 home）＋ 用户全局 workspace.json 前后 sha 对照 ──
$script:T73Ws = Join-Path $env:USERPROFILE '.dsh\storages\workspace.json'
$script:T73ShaBefore = if (Test-Path $script:T73Ws) { (Get-FileHash $script:T73Ws -Algorithm SHA256).Hash } else { '<none>' }
if (-not $UseUserHome) {
  $env:DSH_HOME = Join-Path $env:TEMP 'reliability-inject-a-daemon-kill-home'
  New-Item -ItemType Directory -Force -Path (Join-Path $env:DSH_HOME 'storages') | Out-Null
  # ⚠️ 有些脚本另有 `param([string]$DshHome = $env:DSH_HOME)`：它的默认值在**本块之前**就求值成用户 home，
  #    会让脚本后面按用户 home 拼 profile 路径（T73 复跑实测：boot-testhost 因此去用户目录找 profile）⇒ 一并覆盖。
  if (Get-Variable -Name DshHome -Scope 0 -ErrorAction SilentlyContinue) { $DshHome = $env:DSH_HOME }
}
Write-Host "[T73] DSH_HOME=$env:DSH_HOME（UseUserHome=$([bool]$UseUserHome)） sha(前)=$($script:T73ShaBefore.Substring(0,[Math]::Min(16,$script:T73ShaBefore.Length)))"

$ErrorActionPreference = 'Stop'
$Dir = $PSScriptRoot
$Parent = Split-Path $Dir -Parent              # explorer-20261012\（复用它的 probe / revision / browser）
$Route = '/remote-wsl/api'
$LiveHostPort = 19387
$LiveHostPidBaseline = 47564                   # 2026-10-12 准备期实测；变了必须在报告里说明
$AllowedSlots = @(8972, 8973, 8974)

# ── 守卫 ────────────────────────────────────────────────────────────────────────
function Assert-Guards {
  $bad = @()
  foreach ($p in @($WebPort, $DaemonPort)) {
    if ($p -lt 8971 -or $p -gt 8980) { $bad += "端口 $p 不在 task-6 端口段 8971–8980" }
    if ($p -eq $LiveHostPort) { $bad += "端口 $p 是用户宿主端口，绝对禁止" }
    if ($p -eq 9910) { $bad += "端口 $p 是 proxy 端口，绝对禁止" }
  }
  if ($AllowedSlots -notcontains $DaemonPort) { $bad += "DaemonPort=$DaemonPort 不在自有槽位 {8972,8973,8974}" }
  if ($bad.Count) { throw "拒跑：`n - " + ($bad -join "`n - ") }
  if (-not (Test-Path $NodeExe)) { $script:NodeExe = 'node' }   # 回退到 PATH 上的 node
}

function Get-LiveHostPid {
  $c = Get-NetTCPConnection -LocalPort $LiveHostPort -State Listen -ErrorAction SilentlyContinue
  if ($c) { return [int]$c.OwningProcess } else { return $null }
}

function Assert-LiveHostUntouched([string]$when) {
  # ⚠ `$pid` 是 PowerShell **只读**自动变量（p0-verify 踩过同一个坑：daemon-invariance.ps1）⇒ 必须换名。
  $listenerPid = Get-LiveHostPid
  $line = "$(Get-Date -Format o)  [$when] 19387 listener pid = $(if ($listenerPid) { $listenerPid } else { '(none)' })  baseline=$LiveHostPidBaseline"
  Add-Content -Path (Join-Path $Dir 'out-A-00-livehost.txt') -Value $line -Encoding utf8
  if ($listenerPid -ne $LiveHostPidBaseline) {
    throw "活宿主 pid 由 $LiveHostPidBaseline 变为 $(if ($listenerPid) { $listenerPid } else { '(none)' }) —— 用户宿主状态已变，实验结论无效（停在这里，别继续）。"
  }
}

function Write-Json([string]$Name, $Obj) {
  $Obj | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $Dir $Name) -Encoding utf8
}

function Read-Json([string]$Name) {
  $p = Join-Path $Dir $Name
  if (-not (Test-Path $p)) { return $null }
  return Get-Content $p -Raw | ConvertFrom-Json
}

# 同源 POST（浏览器同源 fetch 的等价物：Origin 必须与 Host 同源）
function Invoke-Explorer {
  param([string]$Method, [hashtable]$Args = @{}, [string]$Out = $null)
  $body = @{ method = $Method; args = $Args } | ConvertTo-Json -Depth 8 -Compress
  # ★ 硬守卫：任何 daemon 动作都不得携带 all=true
  if ($body -match '"all"\s*:\s*true') { throw "拒跑：请求体出现 all=true（禁止波及其他人的槽位）" }
  $uri = "http://127.0.0.1:$WebPort$Route"
  $headers = @{ Origin = "http://127.0.0.1:$WebPort"; 'Sec-Fetch-Site' = 'same-origin' }
  try {
    $resp = Invoke-WebRequest -Uri $uri -Method Post -Headers $headers `
      -ContentType 'application/json' -Body $body -SkipHttpErrorCheck -TimeoutSec 30
  } catch {
    $rec = [ordered]@{ at = (Get-Date -Format o); method = $Method; args = $Args; transportError = $_.Exception.Message }
    if ($Out) { Write-Json $Out $rec }
    return [pscustomobject]@{ Status = $null; Body = $null; Raw = $rec }
  }
  $text = $resp.Content
  $parsed = $null
  try { $parsed = $text | ConvertFrom-Json } catch { }
  $rec = [ordered]@{
    at = (Get-Date -Format o); method = $Method; args = $Args
    request = [ordered]@{ uri = $uri; headers = $headers; body = $body }
    status = [int]$resp.StatusCode; responseText = $text
  }
  if ($Out) { Write-Json $Out $rec }
  return [pscustomobject]@{ Status = [int]$resp.StatusCode; Body = $parsed; Raw = $rec; Text = $text }
}

function Invoke-Probe {
  # 只回传输出；**不再自己落盘** —— 落盘交给 probe 自己的 `--out <file>`（避免两套写盘逻辑）。
  # ⚠ 踩过的两个坑（都写在这里，避免复犯）：
  #   ① `$out` 与 `$Out` 在 PowerShell 里是**同一个变量**（大小写不敏感）⇒ 原先把 probe 输出赋给 `$out`
  #      会覆盖 `$Out` 参数，于是 `Set-Content -Path (Join-Path $Dir $Out)` 把**整个 probe 输出当路径**，
  #      抛 `System.IO.IOException: 文件名、目录名或卷标语法不正确`，害得故意红测试 exit 1 而非 3。
  #   ② 不能带 EAP=Stop 去 `2>&1` 合并原生 stderr（会变 NativeCommandError 中止脚本）⇒ 局部降级。
  param([string[]]$ProbeArgs)
  $probe = Join-Path $Parent 'probe-ground-truth.ts'
  if (-not (Test-Path $probe)) { Write-Host "  (缺 $probe —— 该步记 UNKNOWN)"; return $null }
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $probeOut = & $script:NodeExe $probe @ProbeArgs 2>&1 | Out-String }
  finally { $ErrorActionPreference = $prevEap }
  return $probeOut
}

# 把"面板要显示的那几个数"归一化，供 before/after 比较
function Get-NormalizedState([string]$SnapshotFile, [string]$Out) {
  $snap = Read-Json $SnapshotFile
  $st = [ordered]@{
    at = (Get-Date -Format o)
    ok = ($null -ne $snap)
    daemonRunning = $snap.responseText -and ($snap.responseText | ConvertFrom-Json).result.daemon.running
    daemonSlot = $null; daemonPid = $null; daemonVersion = $null; daemonPort = $null
    keys = @(); distros = @(); workspaces = @(); webHosts = @()
    drift = $null; target = $null
  }
  if ($snap) {
    try {
      $r = ($snap.responseText | ConvertFrom-Json).result
      $st.daemonSlot = $r.daemon.slot; $st.daemonPid = $r.daemon.pid; $st.daemonVersion = $r.daemon.version
      $st.daemonPort = $r.daemon.port
      $st.keys = @($r.daemon.keys); $st.distros = @($r.distros | ForEach-Object { $_.name })
      $st.workspaces = @($r.workspaces | ForEach-Object { "$($_.distro):$($_.path)" })
      $st.webHosts = @($r.webHosts | ForEach-Object { $_.port })
      $st.drift = $r.drift; $st.target = $r.target
    } catch { $st.parseError = $_.Exception.Message }
  }
  if ($Out) { Write-Json $Out $st }
  return $st
}

# ── 计划（无 -Go 时只打印）─────────────────────────────────────────────────────
Assert-Guards
if (-not $Go) {
  @"
INJ-A 计划（未执行；加 -Go 才动作）
  阶段       capture → kill → [浏览器刷新+抽取] → verify → restore
  web 端口   $WebPort      （测试宿主：dsh --profile remote-wsl-test web --port $WebPort --no-open）
  守护槽位   $DaemonPort   （只允许 $($AllowedSlots -join '/')）
  活宿主     $LiveHostPort 基线 pid $LiveHostPidBaseline（每次动作前复验；不变才算实验有效）
  断言       面板在守护死后必须是「可读的 daemon 未运行」：非白屏、无旧 pid、有重试/启动入口
  复原       幂等 ensure（explorer.daemon action=ensure），after 与 before 的 slot/keys 必须一致
  argv 提示  浏览器步骤由 agent 用 $Parent\browser\extract-panel.js + 截图完成，产物名见 INJECTION-PLAN §3
"@ | Write-Host
  exit 0
}

Set-Content -Path (Join-Path $Dir 'out-A-00-livehost.txt') -Value "INJ-A livehost guard @ $(Get-Date -Format o) baseline=$LiveHostPidBaseline" -Encoding utf8
Assert-LiveHostUntouched 'start'

# ── capture ────────────────────────────────────────────────────────────────────
if ($Phase -in @('capture', 'all')) {
  Write-Host '[capture] 被验对象 revision 证据（**只读**）'
  # ★ 纪律修正（2026-10-12 15:49 自查发现）：**绝不**调用 `revision.ps1 -Mode Preview` ——
  #   它的 OutDir 默认是 task-4 的目录，会写别人的 `REVISION.preview.txt`（我已在 15:49:50 误覆盖过一次，
  #   详见 REPORT 的越界披露）。改为只读引用：p0-verify 的 REVISION.txt/preview + 我自算的 REVISION-observed.txt。
  $refs = @()
  foreach ($n in 'REVISION.txt', 'REVISION.preview.txt') {
    $f = Join-Path $Parent $n
    if (Test-Path $f) {
      $refs += "===== $n (mtime $((Get-Item $f).LastWriteTime.ToString('o')), $((Get-Item $f).Length) B) =====`n" + (Get-Content $f -Raw)
    }
  }
  $ownAnchor = Join-Path $Dir 'REVISION-observed.txt'
  if (Test-Path $ownAnchor) { $refs += "===== REVISION-observed.txt（task-6 自算，用于独立交叉复核）=====`n" + (Get-Content $ownAnchor -Raw) }
  if ($refs.Count) {
    $refs -join "`n" | Set-Content (Join-Path $Dir 'out-A-00-revision.txt') -Encoding utf8
    Write-Host '  revision → out-A-00-revision.txt（只读引用 + 自算锚点）'
  } else { Write-Host '  (没有可用 revision 证据 ⇒ 记 UNKNOWN)' }

  # ★ lead 2026-10-12 批准的加固①（阻断级）：先证明"这两次比对落在同一个、且**我拥有**的槽位上"。
  #   动机（实测 11:46 现场）：默认槽位 8731 上曾有**非我所有**的守护；若 --patch 未生效，
  #   capture 与 restore 会落在同一个 8731 上前后比对 ⇒ 会误报 RESTORED: yes 而我从未拥有守护。
  #   上半段只依赖 `wsl_status`（本地探针），因此**先于任何 HTTP 调用**执行：
  #   不满足 ⇒ exit 3 拒跑（带原始输出），既 fail-fast，也让"故意红"无需先起宿主。
  $statusText = Invoke-Probe -ProbeArgs @('--mode', 'status', '--port', "$DaemonPort", '--out', (Join-Path $Dir 'out-A-01-status-before.txt'))
  $statusHasConfigured = [bool]($statusText -match "configured=$ExpectedSlot(\D|$)")
  Write-Json 'out-A-01b-slot-precondition.json' ([ordered]@{
      at = (Get-Date -Format o); expectedSlot = $ExpectedSlot; daemonPort = $DaemonPort
      stage = 'status-only'; statusHasConfigured = $statusHasConfigured
    })
  if (-not $statusHasConfigured) {
    Write-Host "REJECT: wsl_status 未自证 'configured=$ExpectedSlot'（--patch 未生效？端口不对？）⇒ 拒绝实验，exit 3" -ForegroundColor Red
    Write-Host "  证据：out-A-01-status-before.txt、out-A-01b-slot-precondition.json"
    exit 3
  }

  $s = Invoke-Explorer -Method 'explorer.snapshot' -Out 'out-A-01-snapshot-before.json'
  Write-Host "  snapshot before: HTTP $($s.Status)"
  if ($s.Status -ne 200) { throw "capture 失败：同源 snapshot 返回 HTTP $($s.Status)（端口错？宿主没起？闸门把同源也拦了？）——先把这一条查清" }

  $st = Get-NormalizedState 'out-A-01-snapshot-before.json' 'out-A-01-state-before.json'
  Write-Host "  before: daemon.running=$($st.daemonRunning) slot=$($st.daemonSlot) pid=$($st.daemonPid) keys=$($st.keys.Count)"

  # 加固①下半段：快照到手后，再证明"若已有守护，它就在我自己的槽位上"。
  $slotCheck = [ordered]@{
    at = (Get-Date -Format o); expectedSlot = $ExpectedSlot; daemonPort = $DaemonPort
    stage = 'with-snapshot'; statusHasConfigured = $statusHasConfigured
    snapshotDaemonRunning = $st.daemonRunning; snapshotDaemonSlot = $st.daemonSlot
    snapshotSlotOk = [bool](($st.daemonRunning -ne $true) -or ([int]$st.daemonSlot -eq $ExpectedSlot))
  }
  Write-Json 'out-A-01b-slot-precondition.json' $slotCheck
  if (-not $slotCheck.snapshotSlotOk) {
    Write-Host "REJECT: 现有守护 slot=$($st.daemonSlot) ≠ ExpectedSlot=$ExpectedSlot ⇒ 拒绝实验（防打到别人的槽位），exit 3" -ForegroundColor Red
    Write-Host "  证据：out-A-01b-slot-precondition.json"
    exit 3
  }
  if ($st.daemonRunning -ne $true) {
    Write-Host '  ⚠ 守护当前未运行：INJ-A 需要一个"活着的守护"才有判别力。请先 explorer.daemon action=ensure（只停自己槽位）。'
  }
}

# ── kill ───────────────────────────────────────────────────────────────────────
if ($Phase -in @('kill', 'all')) {
  Assert-LiveHostUntouched 'before-kill'
  Write-Host "[kill] 只停自有槽位 $DaemonPort（无 all=true）"
  $k = Invoke-Explorer -Method 'explorer.daemon' -Args @{ action = 'stop'; slot = $ExpectedSlot } -Out 'out-A-03-stop.json'
  Write-Host "  explorer.daemon stop: HTTP $($k.Status)"
  if ($k.Status -ne 200) { throw "停止请求未成功（HTTP $($k.Status)）：$($k.Text)" }

  $a = Invoke-Explorer -Method 'explorer.snapshot' -Out 'out-A-03-snapshot-after-kill.json'
  $st = Get-NormalizedState 'out-A-03-snapshot-after-kill.json' 'out-A-03-state-after-kill.json'
  Write-Host "  after-kill: daemon.running=$($st.daemonRunning) pid=$($st.daemonPid)"
  if ($st.daemonRunning -eq $true) { throw '停止后快照仍显示 running=true —— 停错了槽位或状态源有问题，立刻查，别继续注入。' }
  Write-Host ''
  Write-Host '  下一步（浏览器，由 agent 执行）：'
  Write-Host "   1) 打开 http://127.0.0.1:$WebPort → 点侧栏我们的图标 → 抽取面板"
  Write-Host '      产物：out-A-02-panel-before.json（刷新前那次也应已抽过）、out-A-04-panel-after-kill.json、shot-A-04-panel-after-kill.png'
  Write-Host '      抽取脚本：' + (Join-Path $Parent 'browser\extract-panel.js')
  Write-Host '   2) 再按一次整页 F5（F18 变体）→ out-A-07-panel-reload-errorstate.json'
  Write-Host '   3) 然后跑 -Phase verify'
}

# ── verify（对面板侧断言）──────────────────────────────────────────────────────
if ($Phase -eq 'verify') {
  Write-Host '[verify] 断言"守护死掉"在界面上是可读状态，而不是白屏/挂死/陈旧 pid'
  $before = Read-Json 'out-A-01-state-before.json'
  $after = Read-Json 'out-A-04-panel-after-kill.json'
  $res = [ordered]@{
    at = (Get-Date -Format o); pidBefore = $before.daemonPid
    panelFile = 'out-A-04-panel-after-kill.json'; present = ($null -ne $after)
    checks = [ordered]@{}
  }
  if ($null -eq $after) {
    $res.checks['panel-extract-present'] = 'UNKNOWN（缺 out-A-04-panel-after-kill.json：浏览器步骤没做 ⇒ 不许当通过）'
    Write-Json 'out-A-04b-verify.json' $res
    Write-Json 'out-A-04b-verify.txt' $res
    Write-Host '  UNKNOWN：面板抽取缺失，见 INJECTION-PLAN §1 步骤 4'
    exit 3
  }
  # ★ 只扫**被观测到的字段**（text / statusBarText / buttons），**不含**我自己写的对比元数据
  #   （如 roundTrip.before）。否则会把自己的注释当成"面板里的陈旧 pid" ⇒ **假红**
  #   （2026-10-12 16:03 实测踩到：no-stale-pid 因元数据里的 914091 判红，而面板正文并没有它）。
  $scanParts = @()
  foreach ($fld in 'text', 'statusBarText') { if ($after.$fld) { $scanParts += [string]$after.$fld } }
  if ($after.buttons) { $scanParts += (@($after.buttons) -join "`n") }
  $text = ($scanParts -join "`n")
  $res.checks['non-blank'] = ($text.Length -gt 200)
  $res.checks['mentions-daemon-stopped'] = ($text -match 'daemon\s*未运行' -or $text -match '未运行')
  $res.checks['no-stale-pid'] = (-not ($null -ne $before.daemonPid -and $text -match [regex]::Escape("$($before.daemonPid)")))
  $res.checks['has-recovery-entry'] = ($text -match '启动守护' -or $text -match '重试')
  $red = @($res.checks.GetEnumerator() | Where-Object { $_.Value -eq $false })
  $res.verdict = if ($red.Count) { 'RED' } else { 'PASS' }
  Write-Json 'out-A-04b-verify.json' $res
  ($res | ConvertTo-Json -Depth 6) | Set-Content (Join-Path $Dir 'out-A-04b-verify.txt') -Encoding utf8
  Write-Host ($res | ConvertTo-Json -Depth 6)
  if ($red.Count) { Write-Host "  RED 项：$($red.Name -join ', ')"; exit 1 }
}

# ── restore ────────────────────────────────────────────────────────────────────
if ($Phase -eq 'restore') {
  Assert-LiveHostUntouched 'before-restore'
  Write-Host '[restore] 幂等 ensure（不传 slot ⇒ 回到配置槽位）'
  $e = Invoke-Explorer -Method 'explorer.daemon' -Args @{ action = 'ensure'; slot = $ExpectedSlot } -Out 'out-A-05-ensure.json'
  Write-Host "  ensure: HTTP $($e.Status)"
  $s = Invoke-Explorer -Method 'explorer.snapshot' -Out 'out-A-05-snapshot-after-restore.json'
  Invoke-Probe -ProbeArgs @('--mode', 'status', '--port', "$DaemonPort", '--out', (Join-Path $Dir 'out-A-05-status-after.txt')) | Out-Null
  $after = Get-NormalizedState 'out-A-05-snapshot-after-restore.json' 'out-A-05-state-after.json'
  $before = Read-Json 'out-A-01-state-before.json'

  $diff = [ordered]@{
    at = (Get-Date -Format o)
    before = [ordered]@{ slot = $before.daemonSlot; pid = $before.daemonPid; version = $before.daemonVersion; keys = $before.keys }
    after = [ordered]@{ slot = $after.daemonSlot; pid = $after.daemonPid; version = $after.daemonVersion; keys = $after.keys }
    slotSame = ($before.daemonSlot -eq $after.daemonSlot)
    keysSame = (@($before.keys).Count -eq @($after.keys).Count)
    pidNonEmpty = ($null -ne $after.daemonPid)
    versionSame = ($before.daemonVersion -eq $after.daemonVersion)
  }
  $diff.restored = ($diff.slotSame -and $diff.pidNonEmpty -and $diff.keysSame)
  Write-Json 'out-A-06-restore-diff.json' $diff
  Write-Host "  RESTORED: $(if ($diff.restored) { 'yes' } else { 'NO' })"
  if (-not $diff.restored) {
    Write-Host '  ⚠ 复原不完整 —— 报告里必须写清（不许掩盖）；缺口：' -NoNewline
    Write-Host ((@('slotSame', 'keysSame', 'pidNonEmpty', 'versionSame') | Where-Object { -not $diff.$_ }) -join ', ')
    exit 2
  }
  Write-Host "  下一步（浏览器）：切回面板截图 → out-A-06-panel-after-restore.json / shot-A-06-*.png；收尾跑 revision.ps1 -Mode Check"
}

Assert-LiveHostUntouched 'end'
Write-Host "INJ-A -Phase $Phase 完成；活宿主 pid 仍为 $LiveHostPidBaseline（未被碰）"

# ── T73 断言：用户全局 workspace.json 前后 sha 相同 ──
$script:T73ShaAfter = if (Test-Path $script:T73Ws) { (Get-FileHash $script:T73Ws -Algorithm SHA256).Hash } else { '<none>' }
if ($script:T73ShaAfter -ne $script:T73ShaBefore) { Write-Host "[T73] 失败：用户全局 workspace.json 被改写（$($script:T73ShaBefore) -> $($script:T73ShaAfter)）"; exit 9 }
Write-Host "[T73] 用户全局 workspace.json sha 前后相同 = True"
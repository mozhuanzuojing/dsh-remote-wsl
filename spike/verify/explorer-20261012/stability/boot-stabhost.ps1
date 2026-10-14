#!/usr/bin/env pwsh
# boot-stabhost.ps1 —— task-7（stability-engineer）的**测试宿主**启停（绝不碰用户正在用的宿主）。
#
# 与 p0-verify 的 boot-testhost.ps1 是**两份独立实例**：自己的 profile（remote-wsl-test-stab）
# 与自己的端口段（8981/8982），互不干扰。
#
# 纪律：
#   1) 启动前清掉继承的 DSH_PROFILE/DSH_PROFILE_DIR/DSH_SESSION_ID/DSH_WEB_URL/DSH_SHELL，只留 DSH_HOME；
#   2) 每步复算 19387 的 pid，必须等于基线（默认记到 out-00-livehost.txt），不等即 exit 4（说明碰到了用户宿主）；
#   3) 只写自己的 profile 目录；不动任何既有 profile；
#   4) -Stop 只按自己记录的 pid 停，且必须是 node 进程。
#
# 用法：
#   ./boot-stabhost.ps1 -DumpConfigOnly                    # 只做 compose 校验
#   ./boot-stabhost.ps1 -Port 8981 -DaemonPort 8982 -RequireClient
#   ./boot-stabhost.ps1 -Stop
[CmdletBinding()]
param(
  [int]$Port = 8981,
  [int]$DaemonPort = 8982,
  [switch]$Stop,
  [switch]$DumpConfigOnly,
  [switch]$RequireClient,
  [string]$Vendor = 'D:\project\dsh1\vendor\dsh-remote-wsl',
  [string]$DshHome = $env:DSH_HOME,
  [string]$DshCmd = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
  [string]$OutDir = $PSScriptRoot,
  [string]$ProfileName = 'remote-wsl-test-stab',
  [switch]$UseUserHome
)

# ── T73：默认**孤立** DSH_HOME（-UseUserHome 才用真实 home）＋ 用户全局 workspace.json 前后 sha 对照 ──
$script:T73Ws = Join-Path $env:USERPROFILE '.dsh\storages\workspace.json'
$script:T73ShaBefore = if (Test-Path $script:T73Ws) { (Get-FileHash $script:T73Ws -Algorithm SHA256).Hash } else { '<none>' }
if (-not $UseUserHome) {
  $env:DSH_HOME = Join-Path $env:TEMP 'stability-boot-stabhost-home'
  New-Item -ItemType Directory -Force -Path (Join-Path $env:DSH_HOME 'storages') | Out-Null
  # ⚠️ 有些脚本另有 `param([string]$DshHome = $env:DSH_HOME)`：它的默认值在**本块之前**就求值成用户 home，
  #    会让脚本后面按用户 home 拼 profile 路径（T73 复跑实测：boot-testhost 因此去用户目录找 profile）⇒ 一并覆盖。
  if (Get-Variable -Name DshHome -Scope 0 -ErrorAction SilentlyContinue) { $DshHome = $env:DSH_HOME }
}
Write-Host "[T73] DSH_HOME=$env:DSH_HOME（UseUserHome=$([bool]$UseUserHome)） sha(前)=$($script:T73ShaBefore.Substring(0,[Math]::Min(16,$script:T73ShaBefore.Length)))"
$ErrorActionPreference = 'Stop'
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
if ($Port -lt 8981 -or $Port -gt 8990) { Write-Host "端口 $Port 不在分配的 8981–8990 段内 —— 拒绝"; exit 5 }
if ($DaemonPort -lt 8981 -or $DaemonPort -gt 8990) { Write-Host "守护槽位 $DaemonPort 不在 8981–8990 段内 —— 拒绝"; exit 5 }

$profileDir = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
$pidFile = Join-Path $OutDir 'out-01-host.pid'
$logFile = Join-Path $OutDir ("out-01-host-{0}.log" -f $Port)
$ledger = Join-Path $OutDir 'out-00-pids.txt'
$liveFile = Join-Path $OutDir 'out-00-livehost.txt'

function Get-LiveHostPid { (Get-NetTCPConnection -LocalPort 19387 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }
function Add-Ledger([string]$what, [int]$p) { Add-Content -LiteralPath $ledger -Value ("{0}`t{1}`t{2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $p, $what) -Encoding utf8 }

# ---------- -Stop ----------
if ($Stop) {
  if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host "没有 pid 记录：$pidFile"; exit 0 }
  $p = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if ($proc) {
    if ($proc.ProcessName -notmatch 'node') { Write-Host "拒绝：pid $p 不是 node（$($proc.ProcessName)）—— 只停自己起的实例"; exit 2 }
    if ($p -eq (Get-LiveHostPid)) { Write-Host "拒绝：pid $p 是用户正在用的宿主 —— 绝不停"; exit 4 }
    Stop-Process -Id $p -Force
    Write-Host "已停测试宿主 pid=$p"
    Add-Ledger 'stop-stabhost' $p
  } else { Write-Host "pid $p 已不在" }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

# ---------- 0) 活宿主基线 ----------
$livePid = Get-LiveHostPid
if (Test-Path -LiteralPath $liveFile) {
  # 修正：原来把整份文本的非数字全删 ⇒ 把"记录时间 + 端口"里的数字也拼进来 ⇒ Int32 溢出。
  # 只认基线行的 `19387 pid=<pid>` 字段。
  $mm2 = [regex]::Match((Get-Content -LiteralPath $liveFile -Raw), '19387\s+pid=(\d+)')
  $recorded = if ($mm2.Success) { [int]$mm2.Groups[1].Value } else { 0 }
  Write-Host "活宿主基线文件已存在（记录 pid=$recorded），当前 pid=$livePid —— 必须相等"
  if ($recorded -and ([int]$recorded -ne [int]$livePid)) { Write-Host "!! 用户宿主 pid 变了：先报 lead，不要继续跑测试"; exit 4 }
} else {
  @(
    "记录时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    "用户正在用的宿主：127.0.0.1:19387 pid=$livePid（本验证绝不停/不重启）"
    "测试 profile=$ProfileName ｜ 测试端口=$Port ｜ 守护槽位=$DaemonPort ｜ 端口段=8981-8990"
  ) | Set-Content -LiteralPath $liveFile -Encoding utf8
  Write-Host "已记录活宿主基线 pid=$livePid -> $liveFile"
}
if (-not (Test-Path -LiteralPath $ledger)) { Set-Content -LiteralPath $ledger -Value "# task-7 自造进程账本（收工按此逐个核对）" -Encoding utf8 }

# ---------- 0.5) gate：client 半是否已被 host 声明（G2） ----------
# ★ 2026-10-12 自查抓到的自身缺陷 S4：原来用**文本 grep** 找字面量 `dsh.client`，
#   而真实声明是嵌套 JSON（`"dsh": { "client": { "platform": "web", "inject": [] } }`），
#   字面量根本不出现 ⇒ 闸门**假红**（明明已就绪却报"未就绪"）。
#   正确口径：解析 JSON 的路径 + 校验 exports["./client"] 指向真实文件。
$pkgPath = Join-Path $Vendor 'package.json'
$gate = [pscustomobject]@{ pass = $false; dshClient = $false; platform = $null; inject = $null; entry = $null; entryExists = $false; why = '' }
if (Test-Path -LiteralPath $pkgPath) {
  try {
    $pkgJson = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
    $client = $pkgJson.dsh.client
    $gate.dshClient = ($null -ne $client)
    if ($gate.dshClient) { $gate.platform = $client.platform; $gate.inject = ($client.inject -join ',') }
    $entry = $pkgJson.exports.'./client'
    $gate.entry = $entry
    if ($entry) { $gate.entryExists = Test-Path -LiteralPath (Join-Path $Vendor ($entry -replace '^\./','')) }
    $gate.pass = ($gate.dshClient -and $gate.entryExists)
    if (-not $gate.pass) { $gate.why = "dsh.client 存在=$($gate.dshClient) 入口存在=$($gate.entryExists)" }
  } catch { $gate.why = "package.json 解析失败：$($_.Exception.Message)" }
} else { $gate.why = 'package.json 不存在' }
$gateLine = "gate(G2): dsh.client=$($gate.dshClient) platform=$($gate.platform) inject=[$($gate.inject)] entry=$($gate.entry) 入口存在=$($gate.entryExists) ⇒ pass=$($gate.pass) $($gate.why) ｜ client/ 文件数=$((Get-ChildItem -LiteralPath (Join-Path $Vendor 'client') -File -ErrorAction SilentlyContinue).Count)"
Write-Host $gateLine
$gateLine | Set-Content -LiteralPath (Join-Path $OutDir 'out-02-gate.txt') -Encoding utf8
if ($RequireClient -and -not $gate.pass) {
  Write-Host "G2 未过：$($gate.why) ⇒ bundle 不会被注入，任何渲染读数都不可信。停。"
  exit 6
}

# ---------- 1) 确保 profile（只新建自己的） ----------
if (-not (Test-Path -LiteralPath $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
$pkg = [ordered]@{
  name = "dsh-profile-$ProfileName"
  private = $true
  dependencies = [ordered]@{ 'dsh-remote-wsl' = "link:$($Vendor -replace '\\','/')" }
  dsh = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-remote-wsl') } }
}
($pkg | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $profileDir 'package.json') -Encoding utf8
"# dsh profile root —— 由 task-7 稳定性脚本生成（$ProfileName）`n[]" | Set-Content -LiteralPath (Join-Path $profileDir 'cordis.yml') -Encoding utf8
@"
# $ProfileName：守护槽位钉在 task-7 的端口段（8981–8990），不占他人 87xx/89xx。
- id: remote-wsl
  config:
    distro: debian-u8-1
    dshVersion: ''
    daemonPort: $DaemonPort
"@ | Set-Content -LiteralPath (Join-Path $profileDir 'cordis.patch.yml') -Encoding utf8
$nm = Join-Path $profileDir 'node_modules'
if (-not (Test-Path -LiteralPath $nm)) { New-Item -ItemType Directory -Path $nm -Force | Out-Null }
$link = Join-Path $nm 'dsh-remote-wsl'
if (-not (Test-Path -LiteralPath $link)) { New-Item -ItemType Junction -Path $link -Target $Vendor | Out-Null; Write-Host "已建 junction: $link -> $Vendor" }

# ---------- 2) compose 校验 ----------
$dump = Join-Path $OutDir 'out-01-dumpconfig.txt'
& $DshCmd '--profile' $ProfileName '--dump-config' *>&1 | Out-File -Encoding utf8 $dump
Write-Host "--dump-config -> $dump (exit=$LASTEXITCODE)"
if ($DumpConfigOnly) { exit 0 }
if ($LASTEXITCODE -ne 0) { Write-Host "compose 失败，见 $dump —— 不启动"; exit 2 }

# ---------- 3) 启动（清 DSH_* 继承） ----------
$scrub = @('DSH_PROFILE','DSH_PROFILE_DIR','DSH_SESSION_ID','DSH_WEB_URL','DSH_SHELL')
$saved = @{}
foreach ($n in $scrub) { if (Test-Path "env:$n") { $saved[$n] = (Get-Item "env:$n").Value; Remove-Item "env:$n" -ErrorAction SilentlyContinue } }
try {
  $args = @('--profile', $ProfileName, '--port', "$Port", '--no-open')
  Write-Host "启动：$DshCmd $($args -join ' ')  (log=$logFile)"
  $proc = Start-Process -FilePath $DshCmd -ArgumentList $args -PassThru -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
  $proc.Id | Set-Content -LiteralPath $pidFile -Encoding utf8
  Add-Ledger "stabhost:$Port" $proc.Id
  Write-Host "host pid=$($proc.Id) -> $pidFile"
} finally {
  foreach ($k in $saved.Keys) { Set-Item "env:$k" $saved[$k] }
}

# ---------- 4) 等就绪 + 活宿主不变 ----------
$deadline = (Get-Date).AddSeconds(90)
$ready = $false
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 3
    $ready = $true; break
  } catch {
    # 401 = 服务已在听（web UI 要 ?token=）⇒ 视为就绪（上次误判 exit 3 的原因）
    $code = $null; try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
    if ($code -eq 401) { $ready = $true; break }
    Start-Sleep -Milliseconds 700
  }
}
if (Test-Path -LiteralPath $logFile) {
  $mm = [regex]::Match((Get-Content -LiteralPath $logFile -Raw), 'dsh web: (http://127\.0\.0\.1:\d+/\?token=\S+)')
  if ($mm.Success) { $mm.Groups[1].Value | Set-Content -LiteralPath (Join-Path $OutDir 'out-02-url.txt') -Encoding utf8; Write-Host "tokenURL 已落盘 out-02-url.txt" }
}
Write-Host "ready=$ready  url=http://127.0.0.1:$Port/"
if (-not $ready) { Write-Host "未就绪：看 $logFile / $logFile.err"; exit 3 }
$nowLive = Get-LiveHostPid
Write-Host "活宿主 pid 仍为 $nowLive（基线 $livePid）—— 必须相等"
if ($nowLive -ne $livePid) { Write-Host "!! 活宿主 pid 变了：立即停下报告 lead"; exit 4 }

# ---------- 5) bundle/chunk 可达性（G3） ----------
if ($gate.dshClient) {
  $probe = Join-Path $OutDir 'out-02-bundle-probe.txt'
  $lines = @("$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  testhost=http://127.0.0.1:$Port")
  foreach ($f in @('', 'client.api.js', 'client.panel.js', 'client.icon.js')) {
    $u = "http://127.0.0.1:$Port/plugins/dsh-remote-wsl/$f"
    try {
      $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 5
      $lines += ("{0}  ->  {1}  {2} bytes" -f $u, $r.StatusCode, ($r.RawContentLength))
    } catch {
      $code = $null; try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
      $lines += ("{0}  ->  {1}  ({2})" -f $u, $(if ($code) { $code } else { 'ERR' }), $_.Exception.Message)
    }
  }
  $lines | Set-Content -LiteralPath $probe -Encoding utf8
  $lines | ForEach-Object { Write-Host $_ }
} else {
  Write-Host "（未声明 dsh.client ⇒ 跳过 bundle 探测，避免把 404 误读成'面板没渲染'）"
}
# ── T73 断言：用户全局 workspace.json 前后 sha 相同 ──
$script:T73ShaAfter = if (Test-Path $script:T73Ws) { (Get-FileHash $script:T73Ws -Algorithm SHA256).Hash } else { '<none>' }
if ($script:T73ShaAfter -ne $script:T73ShaBefore) { Write-Host "[T73] 失败：用户全局 workspace.json 被改写（$($script:T73ShaBefore) -> $($script:T73ShaAfter)）"; exit 9 }
Write-Host "[T73] 用户全局 workspace.json sha 前后相同 = True"
exit 0

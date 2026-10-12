#!/usr/bin/env pwsh
# boot-testhost.ps1 —— 另起**测试宿主实例**（绝不重启用户正在用的 desktop 宿主）。
#
# 关键纪律：
#   1) 启动前清掉本会话继承的 DSH_PROFILE/DSH_PROFILE_DIR/DSH_SESSION_ID/DSH_WEB_URL/DSH_SHELL，
#      只保留 DSH_HOME —— 否则可能被当成 desktop profile 或贴到活宿主上（等于重启用户宿主）。
#   2) 只写自己的 profile 目录（新建 remote-wsl-test-web[-base]），不动用户已有 profile。
#   3) 端口只用 8931–8960；`--no-open` 不弹浏览器。
#
# 用法：
#   ./boot-testhost.ps1 -Port 8931 -DaemonPort 8932                 # 带插件（验收用）
#   ./boot-testhost.ps1 -Port 8934 -DaemonPort 8935 -NoPlugin       # 基线（强制红 R2 用）
#   ./boot-testhost.ps1 ... -Stop        # 按记录的 pid 停掉自己起的实例
[CmdletBinding()]
param(
  [int]$Port = 8931,
  [int]$DaemonPort = 8932,
  [switch]$NoPlugin,
  [switch]$Stop,
  [switch]$DumpConfigOnly,
  [string]$Vendor = 'D:\project\dsh1\vendor\dsh-remote-wsl',
  [string]$DshHome = $env:DSH_HOME,
  [string]$DshCmd = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
  [string]$OutDir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }

$suffix = if ($NoPlugin) { '-base' } else { '' }
$profileName = 'remote-wsl-test-web' + $suffix
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $profileName
$pidFile = Join-Path $OutDir ("out-03-host{0}.pid" -f $suffix)
$logFile = Join-Path $OutDir ("out-03-host{0}-{1}.log" -f $suffix, $Port)

function Get-LiveHostPid { (Get-NetTCPConnection -LocalPort 19387 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }

# ---------- -Stop ----------
if ($Stop) {
  if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host "没有 pid 记录：$pidFile"; exit 0 }
  $p = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if ($proc) {
    if ($proc.ProcessName -notmatch 'node') { Write-Host "拒绝：pid $p 不是 node（$($proc.ProcessName)）—— 只停自己起的实例"; exit 2 }
    Stop-Process -Id $p -Force
    Write-Host "已停 pid=$p"
  } else { Write-Host "pid $p 已不在" }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

# ---------- 0) 记录活宿主基线（收工必须不变） ----------
$livePid = Get-LiveHostPid
$liveFile = Join-Path $OutDir 'out-01-livehost-baseline.txt'
@(
  "记录时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  "用户正在用的宿主：127.0.0.1:19387 pid=$livePid（**本验证绝不停/重启它**）"
  "DSH_HOME=$DshHome ｜ 测试 profile=$profileName ｜ 测试端口=$Port ｜ 守护槽位=$DaemonPort"
) | Set-Content -LiteralPath $liveFile -Encoding utf8
Write-Host "活宿主 pid=$livePid（已记录到 $liveFile）"

# ---------- 1) 确保测试 profile（只新建自己的） ----------
if (-not (Test-Path -LiteralPath $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
$bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app')
if (-not $NoPlugin) { $bundles += 'dsh-remote-wsl' }
$pkg = [ordered]@{
  name    = "dsh-profile-$profileName"
  private = $true
  dependencies = if ($NoPlugin) { [ordered]@{} } else { [ordered]@{ 'dsh-remote-wsl' = "link:$($Vendor -replace '\\', '/')" } }
  dsh     = [ordered]@{ profile = [ordered]@{ bundles = $bundles } }
}
($pkg | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $profileDir 'package.json') -Encoding utf8
"# dsh profile root —— 由 task-4 验证脚本生成（$profileName）`n[]" | Set-Content -LiteralPath (Join-Path $profileDir 'cordis.yml') -Encoding utf8

if ($NoPlugin) {
  "# $profileName：**不带** dsh-remote-wsl 的基线（强制红 R2）`n[]" | Set-Content -LiteralPath (Join-Path $profileDir 'cordis.patch.yml') -Encoding utf8
} else {
  @"
# $profileName：把守护槽位钉在验证端口段（8931–8960），不占其它槽位（87xx/89xx）。
# 形式 A：同 id 覆盖 bundle 层已 insert 的 remote-wsl 条目 config。
- id: remote-wsl
  config:
    distro: debian-u8-1
    dshVersion: ''
    daemonPort: $DaemonPort
"@ | Set-Content -LiteralPath (Join-Path $profileDir 'cordis.patch.yml') -Encoding utf8
}

if (-not $NoPlugin) {
  $nm = Join-Path $profileDir 'node_modules'
  if (-not (Test-Path -LiteralPath $nm)) { New-Item -ItemType Directory -Path $nm -Force | Out-Null }
  $link = Join-Path $nm 'dsh-remote-wsl'
  if (-not (Test-Path -LiteralPath $link)) {
    New-Item -ItemType Junction -Path $link -Target $Vendor | Out-Null
    Write-Host "已建 junction: $link -> $Vendor"
  }
}

# ---------- 2) compose 校验（不 mount） ----------
$dump = Join-Path $OutDir ("out-03-dumpconfig{0}.txt" -f $suffix)
& $DshCmd '--profile' $profileName '--dump-config' *>&1 | Out-File -Encoding utf8 $dump
Write-Host "--dump-config -> $dump (exit=$LASTEXITCODE)"
if ($DumpConfigOnly) { exit 0 }
if ($LASTEXITCODE -ne 0) { Write-Host "compose 失败，见 $dump —— 不启动"; exit 2 }

# ---------- 3) 启动（清 DSH_* 继承，只留 DSH_HOME） ----------
$scrub = @('DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL')
$saved = @{}
foreach ($n in $scrub) { if (Test-Path "env:$n") { $saved[$n] = (Get-Item "env:$n").Value; Remove-Item "env:$n" -ErrorAction SilentlyContinue } }
try {
  $args = @('--profile', $profileName, '--port', "$Port", '--no-open')
  Write-Host "启动：$DshCmd $($args -join ' ')  (log=$logFile)"
  # ⚠️ 用户可见窗口硬规矩（lead 2026-10-12，用户投诉后）：**必须** -WindowStyle Hidden；
  # `-NoNewWindow` 只在调用方本身无控制台时才安全，这里一律不用。
  $proc = Start-Process -FilePath $DshCmd -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
  $proc.Id | Set-Content -LiteralPath $pidFile -Encoding utf8
  Write-Host "host pid=$($proc.Id) -> $pidFile"
} finally {
  foreach ($k in $saved.Keys) { Set-Item "env:$k" $saved[$k] }
}

# ---------- 4) 等就绪 ----------
$deadline = (Get-Date).AddSeconds(90)
$ready = $false
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch { Start-Sleep -Milliseconds 700 }
}
Write-Host "ready=$ready  url=http://127.0.0.1:$Port/"
if (-not $ready) { Write-Host "未就绪：看 $logFile / $logFile.err"; exit 3 }
$nowLive = Get-LiveHostPid
Write-Host "活宿主 pid 仍为 $nowLive（启动前 $livePid）—— 必须相等"
if ($nowLive -ne $livePid) { Write-Host "!! 活宿主 pid 变了：说明碰到了用户宿主，立即停下报告"; exit 4 }
exit 0

#!/usr/bin/env pwsh
# ux-boot.ps1 —— task-27：从**已提交版本 7cb3362**的 %TEMP% 副本起测试实例（**不弹可见窗口**）。
#
# 与 usab-run.ps1 的差别：
#   1) Vendor 指向 %TEMP%\usab-ux-7cb3362（git archive 出来的提交树），**不对工作区截图**；
#   2) 自建 profile `remote-wsl-ux-base`（只写我自己的 profile 目录）；
#   3) 起进程一律 `-WindowStyle Hidden` + 重定向 ⇒ 不弹窗；
#   4) 只读我的 8961 端口；守护槽位 8962（本段内）。
#
# 用法：
#   pwsh ./ux-boot.ps1 -Mode Setup     # 建 profile + overlay + dump-config 校验
#   pwsh ./ux-boot.ps1 -Mode Start     # 起实例（hidden），抽 token URL
#   pwsh ./ux-boot.ps1 -Mode Stop      # 只停自己的实例
#   pwsh ./ux-boot.ps1 -Mode Revision  # 复算被验副本的哈希
[CmdletBinding()]
param(
  [ValidateSet('Setup', 'Start', 'Stop', 'Revision')]
  [string]$Mode = 'Setup',
  [int]$Port = 8961,
  [int]$DaemonPort = 8962,
  [string]$Distro = 'debian-u8-1',
  [string]$WslHome = '/home/g',
  [string]$Cwd = '/home/g/project/dsh1',
  [string]$Profile = 'remote-wsl-ux-base',
  [string]$Vendor = "$env:TEMP\usab-ux-7cb3362",
  [string]$DshCmd = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
  [string]$OutDir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh' }

$profileDir = Join-Path (Join-Path $env:DSH_HOME 'profiles') $Profile
$patchFile = Join-Path $OutDir 'out-ux-patch.yml'
$pidFile = Join-Path $OutDir 'out-ux-host.pid'
$logFile = Join-Path $OutDir ("out-ux-host-{0}.log" -f $Port)
$repoProfile = Join-Path (Join-Path $env:DSH_HOME 'profiles') 'remote-wsl-test'

function Get-LiveHostPid { (Get-NetTCPConnection -LocalPort 19387 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }

switch ($Mode) {
  'Setup' {
    if (-not (Test-Path -LiteralPath (Join-Path $Vendor 'package.json'))) { Write-Host "副本不存在：$Vendor（先 git archive 7cb3362）"; exit 2 }
    if (-not (Test-Path -LiteralPath $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
    $pkg = [ordered]@{
      name         = "dsh-profile-$Profile"
      private      = $true
      dependencies = [ordered]@{ 'dsh-remote-wsl' = "link:$($Vendor -replace '\\', '/')" }
      dsh          = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remote-wsl') } }
    }
    ($pkg | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $profileDir 'package.json') -Encoding utf8
    "# $Profile —— task-27 UX 基线（由 ux-boot.ps1 生成）`n[]" | Set-Content -LiteralPath (Join-Path $profileDir 'cordis.yml') -Encoding utf8

    # overlay = 我的 remote-wsl 配置；llm 段从既有测试 profile **只读拷贝**（web 应用起 composer 需要）
    $lines = @("# task-27 UX 基线 overlay：钉场景与自有守护槽位（不改共享 profile）", '- id: remote-wsl', '  config:', "    distro: $Distro", "    wslHome: $WslHome", "    cwd: $Cwd", "    daemonPort: $DaemonPort", '')
    $src = Join-Path $repoProfile 'cordis.patch.yml'
    if (Test-Path -LiteralPath $src) { $lines += (Get-Content -LiteralPath $src) }
    $lines | Set-Content -LiteralPath $patchFile -Encoding utf8
    # profile 自身的 patch 也写一份（同内容），保证 profile 层就带上 llm 与 remote-wsl 配置
    $lines | Set-Content -LiteralPath (Join-Path $profileDir 'cordis.patch.yml') -Encoding utf8

    $nm = Join-Path $profileDir 'node_modules'
    if (-not (Test-Path -LiteralPath $nm)) { New-Item -ItemType Directory -Path $nm -Force | Out-Null }
    $link = Join-Path $nm 'dsh-remote-wsl'
    if (Test-Path -LiteralPath $link) { (Get-Item -LiteralPath $link).Delete() }
    New-Item -ItemType Junction -Path $link -Target $Vendor | Out-Null
    Write-Host "junction: $link -> $Vendor"

    $dump = Join-Path $OutDir 'out-ux-dumpconfig.txt'
    & $DshCmd '--profile' $Profile '--dump-config' *>&1 | Out-File -Encoding utf8 $dump
    $code = $LASTEXITCODE
    Write-Host "--dump-config exit=$code -> $dump"
    Select-String -Path $dump -Pattern 'daemonPort|cwd:' | Select-Object -Last 4 | ForEach-Object { Write-Host ("  " + $_.Line.Trim()) }
    if ($code -ne 0) { exit 2 }
  }

  'Start' {
    $liveBefore = Get-LiveHostPid
    $busy = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($busy) { Write-Host "端口 $Port 已被 pid $busy 占用 —— 先 -Mode Stop"; exit 2 }
    Write-Host "启动前活宿主 pid=$liveBefore"
    $scrub = @('DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL')
    $saved = @{}
    foreach ($n in $scrub) { if (Test-Path "env:$n") { $saved[$n] = (Get-Item "env:$n").Value; Remove-Item "env:$n" -ErrorAction SilentlyContinue } }
    try {
      $argList = @('--profile', $Profile, '--port', "$Port", '--no-open')
      Write-Host "启动（hidden）：$DshCmd $($argList -join ' ')"
      $proc = Start-Process -FilePath $DshCmd -ArgumentList $argList -PassThru -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
      $proc.Id | Set-Content -LiteralPath $pidFile -Encoding utf8
      Write-Host "wrapper pid=$($proc.Id)"
    } finally {
      foreach ($k in $saved.Keys) { Set-Item "env:$k" $saved[$k] }
    }
    $urlFile = Join-Path $OutDir 'out-ux-url.txt'
    $deadline = (Get-Date).AddSeconds(90)
    $tokenUrl = $null
    while ((Get-Date) -lt $deadline -and $null -eq $tokenUrl) {
      $m = (Select-String -Path $logFile, "$logFile.err" -Pattern 'https?://[^\s''"]*\?token=[A-Za-z0-9._-]+' -AllMatches -ErrorAction SilentlyContinue | ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } | Select-Object -Unique -Last 1)
      if ($m) { $tokenUrl = $m } else { Start-Sleep -Milliseconds 500 }
    }
    $probe = if ($tokenUrl) { $tokenUrl } else { "http://127.0.0.1:$Port/" }
    $ready = $false
    $d2 = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $d2) {
      try { $r = Invoke-WebRequest -Uri $probe -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch { Start-Sleep -Milliseconds 700 }
    }
    if ($tokenUrl) { @("$tokenUrl", "（来源：$logFile）") | Set-Content -LiteralPath $urlFile -Encoding utf8 }
    Write-Host "ready=$ready probe=$probe urlFile=$urlFile"
    $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($owner) { $owner | Set-Content -LiteralPath $pidFile -Encoding utf8; Write-Host "端口持有者 pid=$owner" }
    $liveAfter = Get-LiveHostPid
    Write-Host "活宿主 pid 仍为 $liveAfter（启动前 $liveBefore）"
    if ($liveAfter -ne $liveBefore) { Write-Host "!! 碰到了用户宿主"; exit 4 }
    if (-not $ready) { exit 3 }
  }

  'Stop' {
    $livePid = Get-LiveHostPid
    $mine = @()
    if (Test-Path -LiteralPath $pidFile) { $p = [int](Get-Content -LiteralPath $pidFile -Raw).Trim(); if ($p -gt 0) { $mine += $p } }
    $mine += (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess })
    $mine += (Get-CimInstance Win32_Process -Filter "Name='cmd.exe' OR Name='node.exe' OR Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and ($_.CommandLine -match "--port $Port\b" -or $_.CommandLine -match [regex]::Escape($Profile)) } | ForEach-Object { $_.ProcessId })
    $mine = $mine | Where-Object { $_ } | Select-Object -Unique
    if (-not $mine) { Write-Host "没有找到我的实例"; exit 0 }
    foreach ($p in $mine) {
      if ($p -eq $livePid) { Write-Host "拒绝：pid $p 是用户活宿主"; continue }
      $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
      if (-not $proc) { continue }
      if ($proc.ProcessName -notmatch '^(node|cmd|DeepSeek Harness)$') { continue }
      $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue).CommandLine
      if (-not $cl -or -not ($cl -match "--port $Port\b" -or $cl -match [regex]::Escape($Profile))) { Write-Host "拒绝：pid $p 不像我的"; continue }
      try { Stop-Process -Id $p -Force -ErrorAction Stop; Write-Host "已停 pid=$p ($($proc.ProcessName))" } catch { Write-Host "停 pid=$p 失败：$($_.Exception.Message)" }
    }
    Start-Sleep -Seconds 2
    $left = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }) -join ','
    Write-Host "端口 $Port 残留：$(if($left){$left}else{'无'})"
    if (-not $left) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }
    Write-Host "活宿主 pid=$(Get-LiveHostPid)（基线 $livePid）"
  }

  'Revision' {
    $revFile = Join-Path $OutDir 'out-ux-revision.txt'
    $lines = @("# 7cb3362 副本 revision（只读复算） $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    foreach ($d in @('src', 'client')) {
      $dir = Join-Path $Vendor $d
      if (Test-Path -LiteralPath $dir) {
        foreach ($f in (Get-ChildItem -LiteralPath $dir -File | Sort-Object Name)) {
          $lines += ("{0}/{1}`t{2}`t{3}" -f $d, $f.Name, $f.Length, (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash)
        }
      }
    }
    $f = Join-Path $Vendor 'package.json'
    $lines += ("advisory/package.json`t{0}`t{1}" -f (Get-Item $f).Length, (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash)
    $lines | Set-Content -LiteralPath $revFile -Encoding utf8
    $lines | ForEach-Object { Write-Host $_ }
  }
}
exit 0

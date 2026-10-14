#!/usr/bin/env pwsh
# p04-boot.ps1 —— task-40：从 **P0.4 (`63320b4`)** 的 %TEMP% 副本起实例（**不弹可见窗口**）。
#
# 变体：
#   -Variant pristine → profile `remote-wsl-p04`     ，副本 %TEMP%\usab-p04     ，端口 8961 / 守护槽 8962
#   -Variant red      → profile `remote-wsl-p04-red` ，副本 %TEMP%\usab-p04-red ，端口 8963 / 守护槽 8964
#   （red = **故意红**变体：把"当前项"的形状通道去掉、只留填充 ⇒ V7/M15 断言必须红）
#
# 用法：pwsh ./p04-boot.ps1 -Mode Setup|Start|Stop|Revision [-Variant pristine|red]
[CmdletBinding()]
param(
  [ValidateSet('Setup', 'Start', 'Stop', 'Revision')]
  [string]$Mode = 'Setup',
  [ValidateSet('pristine', 'red')]
  [string]$Variant = 'pristine',
  [string]$DshCmd = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
  [string]$OutDir = $PSScriptRoot,
  [switch]$UseUserHome
)

# ── T73：默认**孤立** DSH_HOME（-UseUserHome 才用真实 home）＋ 用户全局 workspace.json 前后 sha 对照 ──
$script:T73Ws = Join-Path $env:USERPROFILE '.dsh\storages\workspace.json'
$script:T73ShaBefore = if (Test-Path $script:T73Ws) { (Get-FileHash $script:T73Ws -Algorithm SHA256).Hash } else { '<none>' }
if (-not $UseUserHome) {
  $env:DSH_HOME = Join-Path $env:TEMP 'usability-p04-boot-home'
  New-Item -ItemType Directory -Force -Path (Join-Path $env:DSH_HOME 'storages') | Out-Null
  # ⚠️ 有些脚本另有 `param([string]$DshHome = $env:DSH_HOME)`：它的默认值在**本块之前**就求值成用户 home，
  #    会让脚本后面按用户 home 拼 profile 路径（T73 复跑实测：boot-testhost 因此去用户目录找 profile）⇒ 一并覆盖。
  if (Get-Variable -Name DshHome -Scope 0 -ErrorAction SilentlyContinue) { $DshHome = $env:DSH_HOME }
}
Write-Host "[T73] DSH_HOME=$env:DSH_HOME（UseUserHome=$([bool]$UseUserHome)） sha(前)=$($script:T73ShaBefore.Substring(0,[Math]::Min(16,$script:T73ShaBefore.Length)))"
$ErrorActionPreference = 'Stop'
if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh' }

if ($Variant -eq 'red') {
  $Profile = 'remote-wsl-p04-red'; $Vendor = "$env:TEMP\usab-p04-red"; $Port = 8963; $DaemonPort = 8964
} else {
  $Profile = 'remote-wsl-p04'; $Vendor = "$env:TEMP\usab-p04"; $Port = 8961; $DaemonPort = 8962
}
$profileDir = Join-Path (Join-Path $env:DSH_HOME 'profiles') $Profile
$pidFile = Join-Path $OutDir "out-p04-$Variant.pid"
$logFile = Join-Path $OutDir "out-p04-$Variant-$Port.log"
$urlFile = Join-Path $OutDir "out-p04-$Variant-url.txt"
$srcProfile = Join-Path (Join-Path $env:DSH_HOME 'profiles') 'remote-wsl-test'

function Get-LiveHostPid { (Get-NetTCPConnection -LocalPort 19387 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }

switch ($Mode) {
  'Setup' {
    if (-not (Test-Path -LiteralPath (Join-Path $Vendor 'package.json'))) { Write-Host "副本不存在：$Vendor"; exit 2 }
    if (-not (Test-Path -LiteralPath $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
    $pkg = [ordered]@{
      name         = "dsh-profile-$Profile"
      private      = $true
      dependencies = [ordered]@{ 'dsh-remote-wsl' = "link:$($Vendor -replace '\\', '/')" }
      dsh          = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remote-wsl') } }
    }
    ($pkg | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $profileDir 'package.json') -Encoding utf8
    "# $Profile —— task-40 P0.4 复验（由 p04-boot.ps1 生成）`n[]" | Set-Content -LiteralPath (Join-Path $profileDir 'cordis.yml') -Encoding utf8
    $lines = @("# $Profile overlay：钉场景与守护槽位（不改共享 profile）", '- id: remote-wsl', '  config:', '    distro: debian-u8-1', '    wslHome: /home/g', '    cwd: /home/g/project/dsh1', "    daemonPort: $DaemonPort", '')
    if (Test-Path -LiteralPath (Join-Path $srcProfile 'cordis.patch.yml')) { $lines += (Get-Content -LiteralPath (Join-Path $srcProfile 'cordis.patch.yml')) }
    $lines | Set-Content -LiteralPath (Join-Path $profileDir 'cordis.patch.yml') -Encoding utf8
    $nm = Join-Path $profileDir 'node_modules'
    if (-not (Test-Path -LiteralPath $nm)) { New-Item -ItemType Directory -Path $nm -Force | Out-Null }
    $link = Join-Path $nm 'dsh-remote-wsl'
    if (Test-Path -LiteralPath $link) { (Get-Item -LiteralPath $link).Delete() }
    New-Item -ItemType Junction -Path $link -Target $Vendor | Out-Null
    Write-Host "[$Variant] junction: $link -> $Vendor"
    $dump = Join-Path $OutDir "out-p04-$Variant-dumpconfig.txt"
    & $DshCmd '--profile' $Profile '--dump-config' *>&1 | Out-File -Encoding utf8 $dump
    Write-Host "[$Variant] --dump-config exit=$LASTEXITCODE -> $dump"
    Select-String -Path $dump -Pattern 'daemonPort|cwd:' | Select-Object -Last 3 | ForEach-Object { Write-Host ("  " + $_.Line.Trim()) }
    if ($LASTEXITCODE -ne 0) { exit 2 }
  }

  'Start' {
    $liveBefore = Get-LiveHostPid
    $busy = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($busy) { Write-Host "端口 $Port 已被 pid $busy 占用 —— 先 Stop"; exit 2 }
    $scrub = @('DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL')
    $saved = @{}
    foreach ($n in $scrub) { if (Test-Path "env:$n") { $saved[$n] = (Get-Item "env:$n").Value; Remove-Item "env:$n" -ErrorAction SilentlyContinue } }
    try {
      $argList = @('--profile', $Profile, '--port', "$Port", '--no-open')
      Write-Host "[$Variant] 启动（hidden）：$DshCmd $($argList -join ' ')"
      $proc = Start-Process -FilePath $DshCmd -ArgumentList $argList -PassThru -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
      Write-Host "[$Variant] wrapper pid=$($proc.Id)"
    } finally { foreach ($k in $saved.Keys) { Set-Item "env:$k" $saved[$k] } }
    $deadline = (Get-Date).AddSeconds(90); $tokenUrl = $null
    while ((Get-Date) -lt $deadline -and $null -eq $tokenUrl) {
      $m = (Select-String -Path $logFile, "$logFile.err" -Pattern 'https?://[^\s''"]*\?token=[A-Za-z0-9._-]+' -AllMatches -ErrorAction SilentlyContinue | ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } | Select-Object -Unique -Last 1)
      if ($m) { $tokenUrl = $m } else { Start-Sleep -Milliseconds 500 }
    }
    $probe = if ($tokenUrl) { $tokenUrl } else { "http://127.0.0.1:$Port/" }
    $ready = $false; $d2 = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $d2) { try { $r = Invoke-WebRequest -Uri $probe -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch { Start-Sleep -Milliseconds 700 } }
    if ($tokenUrl) { @("$tokenUrl", "（来源：$logFile）") | Set-Content -LiteralPath $urlFile -Encoding utf8 }
    $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($owner) { $owner | Set-Content -LiteralPath $pidFile -Encoding utf8 }
    $liveAfter = Get-LiveHostPid
    Write-Host "[$Variant] ready=$ready port=$Port owner=$owner liveHost=$liveAfter (before $liveBefore)"
    if ($liveAfter -ne $liveBefore) { Write-Host "!! 碰到用户宿主"; exit 4 }
    if (-not $ready) { exit 3 }
  }

  'Stop' {
    $livePid = Get-LiveHostPid; $mine = @()
    if (Test-Path -LiteralPath $pidFile) { $p = [int](Get-Content -LiteralPath $pidFile -Raw).Trim(); if ($p -gt 0) { $mine += $p } }
    $mine += (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess })
    $mine += (Get-CimInstance Win32_Process -Filter "Name='cmd.exe' OR Name='node.exe' OR Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and ($_.CommandLine -match "--port $Port\b" -or $_.CommandLine -match [regex]::Escape($Profile)) } | ForEach-Object { $_.ProcessId })
    $mine = $mine | Where-Object { $_ } | Select-Object -Unique
    if (-not $mine) { Write-Host "[$Variant] 没有找到我的实例"; exit 0 }
    foreach ($p in $mine) {
      if ($p -eq $livePid) { Write-Host "拒绝：pid $p 是用户活宿主"; continue }
      $proc = Get-Process -Id $p -ErrorAction SilentlyContinue; if (-not $proc) { continue }
      if ($proc.ProcessName -notmatch '^(node|cmd|DeepSeek Harness)$') { continue }
      $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue).CommandLine
      if (-not $cl -or -not ($cl -match "--port $Port\b" -or $cl -match [regex]::Escape($Profile))) { Write-Host "拒绝：pid $p 不像我的"; continue }
      try { Stop-Process -Id $p -Force -ErrorAction Stop; Write-Host "[$Variant] 已停 pid=$p ($($proc.ProcessName))" } catch { Write-Host "停 pid=$p 失败：$($_.Exception.Message)" }
    }
    Start-Sleep -Seconds 2
    $left = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }) -join ','
    Write-Host "[$Variant] 端口 $Port 残留：$(if($left){$left}else{'无'})"
    if (-not $left) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }
  }

  'Revision' {
    $revFile = Join-Path $OutDir "out-p04-$Variant-revision.txt"
    $lines = @("# 63320b4 副本 revision [$Variant] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    foreach ($d in @('src', 'client')) {
      foreach ($f in (Get-ChildItem -LiteralPath (Join-Path $Vendor $d) -File | Sort-Object Name)) {
        $lines += ("{0}/{1}`t{2}`t{3}" -f $d, $f.Name, $f.Length, (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash)
      }
    }
    $lines | Set-Content -LiteralPath $revFile -Encoding utf8
    $lines | ForEach-Object { Write-Host $_ }
  }
}
# ── T73 断言：用户全局 workspace.json 前后 sha 相同 ──
$script:T73ShaAfter = if (Test-Path $script:T73Ws) { (Get-FileHash $script:T73Ws -Algorithm SHA256).Hash } else { '<none>' }
if ($script:T73ShaAfter -ne $script:T73ShaBefore) { Write-Host "[T73] 失败：用户全局 workspace.json 被改写（$($script:T73ShaBefore) -> $($script:T73ShaAfter)）"; exit 9 }
Write-Host "[T73] 用户全局 workspace.json sha 前后相同 = True"
exit 0

#!/usr/bin/env pwsh
# p05-boot.ps1 —— task-50：**孤立 DSH_HOME** 起 P0.5 实例（不弹可见窗口、不碰用户全局存储）
#
# 关键纪律（本轮新增）：
#   · DSH_HOME 一律指向 %TEMP%\usab-p05-home **副本**（绝不继承用户 ~/.dsh）⇒ profile/storages 都写在孤立 home 里
#   · 起进程前后都对**用户全局存储**取 sha 清单（-Mode ShaBefore/ShaAfter），收尾可对照证明未触碰
#   · 变体 pristine = 8961/守护 8962 ；red = 8963/守护 8964（red 副本用于"故意红"）
[CmdletBinding()]
param(
  [ValidateSet('Setup', 'Start', 'Stop', 'ShaBefore', 'ShaAfter', 'ShaDiff')]
  [string]$Mode = 'Setup',
  [ValidateSet('pristine', 'red')]
  [string]$Variant = 'pristine',
  [string]$DshCmd = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
  [string]$OutDir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'

$Home0 = Join-Path $env:TEMP 'usab-p05-home'
if ($Variant -eq 'red') {
  $Profile = 'p05-red'; $Vendor = "$env:TEMP\usab-p05-red"; $Port = 8963; $DaemonPort = 8964
} else {
  $Profile = 'p05'; $Vendor = "$env:TEMP\usab-p05"; $Port = 8961; $DaemonPort = 8962
}
$profDir = Join-Path (Join-Path $Home0 'profiles') $Profile
$pidFile = Join-Path $OutDir "out-p05-$Variant.pid"
$logFile = Join-Path $OutDir "out-p05-$Variant-$Port.log"
$urlFile = Join-Path $OutDir "out-p05-$Variant-url.txt"
$userStorages = Join-Path $env:USERPROFILE '.dsh\storages'
$userWorkspaceJson = Join-Path $userStorages 'workspace.json'

function Get-LiveHostPid { (Get-NetTCPConnection -LocalPort 19387 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess }
function Get-StorageManifest {
  $lines = @()
  if (Test-Path $userWorkspaceJson) { $lines += "workspace.json`t$((Get-Item $userWorkspaceJson).Length)`t$((Get-FileHash $userWorkspaceJson -Algorithm SHA256).Hash)" } else { $lines += "workspace.json`tMISSING`t-" }
  if (Test-Path $userStorages) {
    $all = Get-ChildItem $userStorages -Recurse -File
    $lines += "storagesFileCount`t$($all.Count)`t-"
    $lines += "storagesTreeHash`t-`t$((($all | Sort-Object FullName | ForEach-Object { (Get-FileHash $_.FullName -Algorithm SHA256).Hash }) -join '') | ForEach-Object { $_ })"
  }
  return $lines
}

switch ($Mode) {
  'ShaBefore' { Get-StorageManifest | Set-Content -LiteralPath (Join-Path $OutDir 'out-p05-userstorages-before.txt') -Encoding utf8; Get-StorageManifest | ForEach-Object { Write-Host $_ } }
  'ShaAfter'  { Get-StorageManifest | Set-Content -LiteralPath (Join-Path $OutDir 'out-p05-userstorages-after.txt')  -Encoding utf8; Get-StorageManifest | ForEach-Object { Write-Host $_ } }
  'ShaDiff' {
    $a = Get-Content (Join-Path $OutDir 'out-p05-userstorages-before.txt'); $b = Get-Content (Join-Path $OutDir 'out-p05-userstorages-after.txt')
    $d = Compare-Object $a $b
    if ($d) { Write-Host "!! 用户存储发生变化："; $d | Format-Table -AutoSize } else { Write-Host "用户存储【未变】（workspace.json sha 与 storages 树哈希都相同）" }
  }

  'Setup' {
    if (-not (Test-Path -LiteralPath (Join-Path $Vendor 'package.json'))) { Write-Host "副本不存在：$Vendor"; exit 2 }
    New-Item -ItemType Directory -Path $profDir -Force | Out-Null
    $pkg = [ordered]@{
      name         = "dsh-profile-$Profile"
      private      = $true
      dependencies = [ordered]@{ 'dsh-remote-wsl' = "link:$($Vendor -replace '\\', '/')" }
      dsh          = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remote-wsl') } }
    }
    ($pkg | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $profDir 'package.json') -Encoding utf8
    "# $Profile —— task-50 残余项复验（孤立 DSH_HOME，由 p05-boot.ps1 生成）`n[]" | Set-Content -LiteralPath (Join-Path $profDir 'cordis.yml') -Encoding utf8
    $lines = @("# $Profile overlay：钉场景与守护槽位（孤立 home，不碰用户 profile）", '- id: remote-wsl', '  config:', '    distro: debian-u8-1', '    wslHome: /home/g', '    cwd: /home/g/project/dsh1', "    daemonPort: $DaemonPort", '')
    $srcPatch = Join-Path $env:USERPROFILE '.dsh\profiles\remote-wsl-test\cordis.patch.yml'
    if (Test-Path -LiteralPath $srcPatch) { $lines += (Get-Content -LiteralPath $srcPatch) }
    $lines | Set-Content -LiteralPath (Join-Path $profDir 'cordis.patch.yml') -Encoding utf8
    $nm = Join-Path $profDir 'node_modules'; New-Item -ItemType Directory -Path $nm -Force | Out-Null
    $link = Join-Path $nm 'dsh-remote-wsl'
    if (Test-Path -LiteralPath $link) { (Get-Item -LiteralPath $link).Delete() }
    New-Item -ItemType Junction -Path $link -Target $Vendor | Out-Null
    Write-Host "[$Variant] DSH_HOME=$Home0"
    Write-Host "[$Variant] junction: $link -> $Vendor"
    $env:DSH_HOME = $Home0
    $dump = Join-Path $OutDir "out-p05-$Variant-dumpconfig.txt"
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
    $env:DSH_HOME = $Home0
    Write-Host "[$Variant] DSH_HOME（孤立）=$env:DSH_HOME"
    try {
      $argList = @('--profile', $Profile, '--port', "$Port", '--no-open')
      $proc = Start-Process -FilePath $DshCmd -ArgumentList $argList -PassThru -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
      Write-Host "[$Variant] wrapper pid=$($proc.Id)"
    } finally {
      foreach ($k in $saved.Keys) { Set-Item "env:$k" $saved[$k] }
      Remove-Item env:DSH_HOME -ErrorAction SilentlyContinue
    }
    $deadline = (Get-Date).AddSeconds(90); $tokenUrl = $null
    while ((Get-Date) -lt $deadline -and $null -eq $tokenUrl) {
      $m = (Select-String -Path $logFile, "$logFile.err" -Pattern 'https?://[^\s''"]*\?token=[A-Za-z0-9._-]+' -AllMatches -ErrorAction SilentlyContinue | ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } | Select-Object -Unique -Last 1)
      if ($m) { $tokenUrl = $m } else { Start-Sleep -Milliseconds 500 }
    }
    $probe = if ($tokenUrl) { $tokenUrl } else { "http://127.0.0.1:$Port/" }
    $ready = $false; $d2 = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $d2) { try { $r = Invoke-WebRequest -Uri $probe -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch { Start-Sleep -Milliseconds 700 } }
    if ($tokenUrl) { @("$tokenUrl", "（来源：$logFile；DSH_HOME=$Home0）") | Set-Content -LiteralPath $urlFile -Encoding utf8 }
    $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($owner) { $owner | Set-Content -LiteralPath $pidFile -Encoding utf8 }
    Write-Host "[$Variant] ready=$ready port=$Port owner=$owner liveHost=$(Get-LiveHostPid) (before $liveBefore)"
    if ((Get-LiveHostPid) -ne $liveBefore) { exit 4 }
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
      try { Stop-Process -Id $p -Force -ErrorAction Stop; Write-Host "[$Variant] 已停 pid=$p ($($proc.ProcessName))" } catch {}
    }
    Start-Sleep -Seconds 2
    $left = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }) -join ','
    Write-Host "[$Variant] 端口 $Port 残留：$(if($left){$left}else{'无'})"
    if (-not $left) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }
  }
}
exit 0

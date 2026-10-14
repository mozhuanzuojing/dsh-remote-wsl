#!/usr/bin/env pwsh
# p06-boot.ps1 —— task-54：**孤立 DSH_HOME** 起 P0.6 实例（不弹可见窗口、不碰用户全局存储）
#
# 与 p05-boot.ps1 同构（沿用其已验证的做法），只换本轮的隔离值与端口：
#   · DSH_HOME 一律 = %TEMP%\usab-p06-home（**副本**，绝不继承用户 ~/.dsh）
#   · 插件副本 = %TEMP%\usab-p06（由 `git archive HEAD` 导出 ⇒ **逐字节代表 HEAD**，不受工作区脏文件影响）
#   · 端口：实例 8966 / 守护槽位 8967（落在任务指定段 8961–8970 内）
#   · 起进程前后对**用户全局存储**取 sha 清单 ⇒ 收尾可对照证明未触碰
[CmdletBinding()]
param(
  [ValidateSet('Vendor', 'Setup', 'Start', 'Stop', 'ShaBefore', 'ShaAfter', 'ShaDiff', 'UnitAudit')]
  [string]$Mode = 'Vendor',
  [string]$PluginRepo = 'D:\project\dsh1\vendor\dsh-remote-wsl',
  [string]$DshCmd = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
  [string]$OutDir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'

$Profile = 'p06'
$Vendor = Join-Path $env:TEMP 'usab-p06'
$Home0 = Join-Path $env:TEMP 'usab-p06-home'
$Port = 8966
$DaemonPort = 8967
$profDir = Join-Path (Join-Path $Home0 'profiles') $Profile
$pidFile = Join-Path $OutDir 'out-p06-instance.pid'
$logFile = Join-Path $OutDir "out-p06-host-$Port.log"
$urlFile = Join-Path $OutDir 'out-p06-url.txt'
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
  # ① 用 git archive 导出**恰好 HEAD** 的插件副本（评审可核：与工作区脏文件无关）
  'Vendor' {
    if (Test-Path $Vendor) { Remove-Item -Recurse -Force $Vendor }
    New-Item -ItemType Directory -Path $Vendor -Force | Out-Null
    Push-Location $PluginRepo
    try { & git archive HEAD | tar -x -C $Vendor } finally { Pop-Location }
    $head = (& git -C $PluginRepo rev-parse HEAD).Trim()
    $entrySha = (Get-FileHash (Join-Path $Vendor 'client\index.js') -Algorithm SHA256).Hash
    Write-Host "HEAD = $head"
    Write-Host "vendor = $Vendor"
    Write-Host "vendor/client/index.js sha256 = $entrySha"
    @("HEAD=$head", "vendor=$Vendor", "index.js sha256=$entrySha") | Set-Content -LiteralPath (Join-Path $OutDir 'out-p06-vendor.txt') -Encoding utf8
  }

  'ShaBefore' { Get-StorageManifest | Set-Content -LiteralPath (Join-Path $OutDir 'out-p06-userstorages-before.txt') -Encoding utf8; Get-StorageManifest | ForEach-Object { Write-Host $_ } }
  'ShaAfter'  { Get-StorageManifest | Set-Content -LiteralPath (Join-Path $OutDir 'out-p06-userstorages-after.txt')  -Encoding utf8; Get-StorageManifest | ForEach-Object { Write-Host $_ } }
  'ShaDiff' {
    $a = Get-Content (Join-Path $OutDir 'out-p06-userstorages-before.txt'); $b = Get-Content (Join-Path $OutDir 'out-p06-userstorages-after.txt')
    $d = Compare-Object $a $b
    if ($d) { Write-Host "!! 用户存储发生变化："; $d | Format-Table -AutoSize; exit 5 } else { Write-Host "用户存储【未变】（workspace.json sha 与 storages 树哈希都相同）" }
  }

  # 守护/单元残留审计（宿主无 systemctl ⇒ 只报 Windows 侧与端口，WSL 侧由 wsl 命令在报告里另证）
  'UnitAudit' {
    $units = (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh-rwsl|remote-wsl' }) | Select-Object ProcessId, Name
    Write-Host "Windows 侧 dsh-rwsl/remote-wsl 进程：$(if($units){($units | ForEach-Object { "$($_.ProcessId):$($_.Name)" }) -join ', '}else{'无'})"
    foreach ($p in 8931..8970) { $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; if ($c) { Write-Host "  port ${p} 监听 pid=$($c.OwningProcess)" } }
  }

  'Setup' {
    if (-not (Test-Path -LiteralPath (Join-Path $Vendor 'package.json'))) { Write-Host "副本不存在：$Vendor（先跑 -Mode Vendor）"; exit 2 }
    New-Item -ItemType Directory -Path $profDir -Force | Out-Null
    $pkg = [ordered]@{
      name         = "dsh-profile-$Profile"
      private      = $true
      dependencies = [ordered]@{ 'dsh-remote-wsl' = "link:$($Vendor -replace '\\', '/')" }
      dsh          = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remote-wsl') } }
    }
    ($pkg | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $profDir 'package.json') -Encoding utf8
    "# $Profile —— task-54 成品图复拍（孤立 DSH_HOME，由 p06-boot.ps1 生成）`n[]" | Set-Content -LiteralPath (Join-Path $profDir 'cordis.yml') -Encoding utf8
    $lines = @("# $Profile overlay：钉场景与守护槽位（孤立 home，不碰用户 profile）", '- id: remote-wsl', '  config:', '    distro: debian-u8-1', '    wslHome: /home/g', '    cwd: /home/g/project/dsh1', "    daemonPort: $DaemonPort", '')
    $lines | Set-Content -LiteralPath (Join-Path $profDir 'cordis.patch.yml') -Encoding utf8
    $nm = Join-Path $profDir 'node_modules'; New-Item -ItemType Directory -Path $nm -Force | Out-Null
    $link = Join-Path $nm 'dsh-remote-wsl'
    if (Test-Path -LiteralPath $link) { (Get-Item -LiteralPath $link).Delete() }
    New-Item -ItemType Junction -Path $link -Target $Vendor | Out-Null
    Write-Host "[$Profile] DSH_HOME=$Home0"
    Write-Host "[$Profile] junction: $link -> $Vendor"
    $env:DSH_HOME = $Home0
    $dump = Join-Path $OutDir 'out-p06-dumpconfig.txt'
    & $DshCmd '--profile' $Profile '--dump-config' *>&1 | Out-File -Encoding utf8 $dump
    Write-Host "[$Profile] --dump-config exit=$LASTEXITCODE -> $dump"
    Select-String -Path $dump -Pattern 'daemonPort|cwd:|distro:' | Select-Object -Last 4 | ForEach-Object { Write-Host ("  " + $_.Line.Trim()) }
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
    Write-Host "[$Profile] DSH_HOME（孤立）=$env:DSH_HOME"
    try {
      $argList = @('--profile', $Profile, '--port', "$Port", '--no-open')
      $proc = Start-Process -FilePath $DshCmd -ArgumentList $argList -PassThru -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
      Write-Host "[$Profile] wrapper pid=$($proc.Id)"
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
    Write-Host "[$Profile] ready=$ready port=$Port owner=$owner liveHost=$(Get-LiveHostPid) (before $liveBefore)"
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
    if (-not $mine) { Write-Host "[$Profile] 没有找到我的实例"; exit 0 }
    foreach ($p in $mine) {
      if ($p -eq $livePid) { Write-Host "拒绝：pid $p 是用户活宿主"; continue }
      $proc = Get-Process -Id $p -ErrorAction SilentlyContinue; if (-not $proc) { continue }
      if ($proc.ProcessName -notmatch '^(node|cmd|DeepSeek Harness)$') { continue }
      $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue).CommandLine
      if (-not $cl -or -not ($cl -match "--port $Port\b" -or $cl -match [regex]::Escape($Profile))) { Write-Host "拒绝：pid $p 不像我的"; continue }
      try { Stop-Process -Id $p -Force -ErrorAction Stop; Write-Host "[$Profile] 已停 pid=$p ($($proc.ProcessName))" } catch {}
    }
    Start-Sleep -Seconds 2
    $left = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }) -join ','
    Write-Host "[$Profile] 端口 $Port 残留：$(if($left){$left}else{'无'})"
    if (-not $left) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }
  }
}
exit 0

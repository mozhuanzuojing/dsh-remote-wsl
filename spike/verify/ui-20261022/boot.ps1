#!/usr/bin/env pwsh
# boot.ps1 —— 2026-10-22 B1/B2 实测用的**隔离实例 + headless Chrome** 起停脚本。
#
# 为什么要隔离：本轮要量真实渲染（320/360 两档 + 代理徽标三态），必须起一个真 dsh web 实例；
# 但**不能**碰用户自己的 desktop profile / storages（那个 profile 正在跑用户会话）。
#   · DSH_HOME = %TEMP%\rwui-1022-home（一次性）
#   · profile  = rwui1022，只挂 base + web-app + 本插件三个 bundle
#   · 插件不是 git archive 副本，而是 **junction 到工作区**（D:\project\dsh1\dsh-remote-wsl）
#     ⇒ 量的就是**工作区当前字节**（含本轮未提交改动），这是本轮唯一正确的目标
#   · 端口：实例 8917（任务指定），headless Chrome 调试口 9333（避开插件守护号段 8911–8990）
#   · 守护不会被启动（快照只读探测；不点启动按钮 ⇒ 不占 8911–8990）
#
# 用法：
#   pwsh -File boot.ps1 -Mode Setup     # 建隔离 home/profile + 打印 --dump-config 自检
#   pwsh -File boot.ps1 -Mode Start     # 起实例 + 起 headless Chrome，写 out-*.txt
#   pwsh -File boot.ps1 -Mode Status    # 只读体检（端口/进程/URL）
#   pwsh -File boot.ps1 -Mode Stop      # 停 Chrome + 实例，并报告端口残留
[CmdletBinding()]
param(
  [ValidateSet('Setup', 'Start', 'Status', 'Stop')]
  [string]$Mode = 'Setup',
  [int]$Port = 8917,
  [int]$ChromePort = 9333,
  [string]$DshCmd = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
  [string]$Repo = 'D:\project\dsh1\dsh-remote-wsl',
  [string]$OutDir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'

$Profile = 'rwui1022'
$Home0 = Join-Path $env:TEMP 'rwui-1022-home'
$ChromeData = Join-Path $env:TEMP 'rwui-1022-chrome'
$profDir = Join-Path (Join-Path $Home0 'profiles') $Profile
$logFile = Join-Path $OutDir "out-instance-$Port.log"
$urlFile = Join-Path $OutDir 'out-url.txt'
$pidFile = Join-Path $OutDir 'out-instance.pid'
$chromePidFile = Join-Path $OutDir 'out-chrome.pid'
$chromeExe = 'C:\Program Files\Google\Chrome\Application\chrome.exe'

function Write-Line([string]$text) { Write-Host $text; Add-Content -LiteralPath (Join-Path $OutDir 'out-boot.log') -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $text) -Encoding utf8 }

switch ($Mode) {
  'Setup' {
    New-Item -ItemType Directory -Path $profDir -Force | Out-Null
    $pkg = [ordered]@{
      name         = "dsh-profile-$Profile"
      private      = $true
      dependencies = [ordered]@{ 'dsh-remote-wsl' = "link:$($Repo -replace '\\', '/')" }
      dsh          = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remote-wsl') } }
    }
    ($pkg | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $profDir 'package.json') -Encoding utf8
    "# $Profile —— 2026-10-22 B1/B2 实测图（隔离 home，由 boot.ps1 生成）`n[]" | Set-Content -LiteralPath (Join-Path $profDir 'cordis.yml') -Encoding utf8
    "# 无覆写：distro/wslHome 全用插件默认（debian-u8-1 / /home/g）`n[]" | Set-Content -LiteralPath (Join-Path $profDir 'cordis.patch.yml') -Encoding utf8
    $nm = Join-Path $profDir 'node_modules'; New-Item -ItemType Directory -Path $nm -Force | Out-Null
    $link = Join-Path $nm 'dsh-remote-wsl'
    if (Test-Path -LiteralPath $link) { (Get-Item -LiteralPath $link).Delete() }
    New-Item -ItemType Junction -Path $link -Target $Repo | Out-Null
    Write-Line "DSH_HOME=$Home0"
    Write-Line "junction: $link -> $Repo"
    $env:DSH_HOME = $Home0
    $dump = Join-Path $OutDir 'out-dumpconfig.txt'
    & $DshCmd '--profile' $Profile '--dump-config' *>&1 | Out-File -Encoding utf8 $dump
    $code = $LASTEXITCODE
    Write-Line "--dump-config exit=$code -> $dump"
    Select-String -Path $dump -Pattern 'remote-wsl|daemonPort' | Select-Object -First 5 | ForEach-Object { Write-Line ("  " + $_.Line.Trim()) }
    if ($code -ne 0) { exit 2 }
  }

  'Start' {
    if (-not (Test-Path -LiteralPath (Join-Path $profDir 'package.json'))) { Write-Line "profile 未建：先跑 -Mode Setup"; exit 2 }
    $busy = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($busy) { Write-Line "端口 $Port 已被 pid $busy 占用 —— 先 Stop"; exit 2 }
    $env:DSH_HOME = $Home0
    try {
      $argList = @('--profile', $Profile, '--port', "$Port", '--no-open')
      $proc = Start-Process -FilePath $DshCmd -ArgumentList $argList -PassThru -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
      Write-Line "[$Profile] wrapper pid=$($proc.Id) port=$Port"
    } finally { Remove-Item env:DSH_HOME -ErrorAction SilentlyContinue }
    $deadline = (Get-Date).AddSeconds(120); $tokenUrl = $null
    while ((Get-Date) -lt $deadline -and $null -eq $tokenUrl) {
      $m = (Select-String -Path $logFile, "$logFile.err" -Pattern 'https?://[^\s''"]*\?token=[A-Za-z0-9._-]+' -AllMatches -ErrorAction SilentlyContinue | ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } | Select-Object -Unique -Last 1)
      if ($m) { $tokenUrl = $m } else { Start-Sleep -Milliseconds 500 }
    }
    if (-not $tokenUrl) { Write-Line "没有从日志里拿到 token URL"; exit 3 }
    $ready = $false; $d2 = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $d2) { try { $r = Invoke-WebRequest -Uri $tokenUrl -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch { Start-Sleep -Milliseconds 700 } }
    $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($owner) { $owner | Set-Content -LiteralPath $pidFile -Encoding utf8 }
    @($tokenUrl, "（来源：$logFile；DSH_HOME=$Home0）") | Set-Content -LiteralPath $urlFile -Encoding utf8
    Write-Line "[$Profile] ready=$ready port=$Port owner=$owner url=$tokenUrl"
    if (-not $ready) { exit 3 }
    if (Test-Path -LiteralPath $ChromeData) { Remove-Item -Recurse -Force $ChromeData -ErrorAction SilentlyContinue }
    $chromeArgs = @("--headless=new", "--remote-debugging-port=$ChromePort", "--user-data-dir=$ChromeData", "--window-size=1280,900", "--no-first-run", "--no-default-browser-check", "--disable-gpu", $tokenUrl)
    $chrome = Start-Process -FilePath $chromeExe -ArgumentList $chromeArgs -PassThru -WindowStyle Hidden
    $chrome.Id | Set-Content -LiteralPath $chromePidFile -Encoding utf8
    $up = $false; $d3 = (Get-Date).AddSeconds(40)
    while ((Get-Date) -lt $d3) { try { $v = Invoke-RestMethod -Uri "http://127.0.0.1:$ChromePort/json/version" -TimeoutSec 2; if ($v.Browser) { $up = $true; break } } catch { Start-Sleep -Milliseconds 400 } }
    Write-Line "[chrome] pid=$($chrome.Id) cdp=$ChromePort up=$up data=$ChromeData"
    if (-not $up) { exit 4 }
    Write-Line "就绪：实例 $Port / CDP $ChromePort"
  }

  'Status' {
    $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    Write-Line "instance port $Port owner=$(if($owner){$owner}else{'无'})"
    Write-Line "chrome cdp $ChromePort = $(try { (Invoke-RestMethod -Uri "http://127.0.0.1:$ChromePort/json/version" -TimeoutSec 2).Browser } catch { '无' })"
    if (Test-Path -LiteralPath $urlFile) { Write-Line ("url: " + (Get-Content -LiteralPath $urlFile -TotalCount 1)) }
    foreach ($p in 8911..8920) { $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; if ($c) { Write-Line "  port ${p} 监听 pid=$($c.OwningProcess)" } }
  }

  'Stop' {
    $killed = @()
    if (Test-Path -LiteralPath $chromePidFile) {
      $cp = [int](Get-Content -LiteralPath $chromePidFile -Raw).Trim()
      $mine = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($ChromeData) }
      foreach ($c in @($mine) + @(Get-Process -Id $cp -ErrorAction SilentlyContinue)) {
        if ($c) { $id = if ($c.ProcessId) { $c.ProcessId } else { $cp }; try { Stop-Process -Id $id -Force -ErrorAction Stop; $killed += "chrome:$id" } catch {} }
      }
    }
    $ids = @()
    if (Test-Path -LiteralPath $pidFile) { $ids += [int](Get-Content -LiteralPath $pidFile -Raw).Trim() }
    $ids += (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess })
    $ids += (Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and ($_.CommandLine -match "--port $Port\b" -or $_.CommandLine -match [regex]::Escape($Profile)) } | ForEach-Object { $_.ProcessId })
    foreach ($p in ($ids | Where-Object { $_ } | Select-Object -Unique)) {
      $proc = Get-Process -Id $p -ErrorAction SilentlyContinue; if (-not $proc) { continue }
      $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue).CommandLine
      if (-not $cl -or -not ($cl -match "--port $Port\b" -or $cl -match [regex]::Escape($Profile))) { Write-Line "拒绝停 pid $p（不像本轮实例）: $cl"; continue }
      try { Stop-Process -Id $p -Force -ErrorAction Stop; $killed += "instance:$p" } catch {}
    }
    Start-Sleep -Seconds 2
    $left = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }) -join ','
    $leftCdp = (Get-NetTCPConnection -LocalPort $ChromePort -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }) -join ','
    Write-Line "killed: $(if($killed){$killed -join ','}else{'无'})"
    Write-Line "端口残留：instance=$Port -> $(if($left){$left}else{'无'})；cdp=$ChromePort -> $(if($leftCdp){$leftCdp}else{'无'})"
    if (-not $left -and -not $leftCdp) { Remove-Item -LiteralPath $pidFile, $chromePidFile -Force -ErrorAction SilentlyContinue }
  }
}
exit 0

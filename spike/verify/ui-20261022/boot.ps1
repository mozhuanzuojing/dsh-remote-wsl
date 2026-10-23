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
#
# ⚠️ 两个使用纪律（都是踩过的）：
#   1. **不要把 Start 的输出接管道/重定向**（`& boot.ps1 -Mode Start | Select-Object`）：dsh.exe 经 cmd.exe
#      继承了调用方的 stdout 句柄，管道会一直等写端关闭 ⇒ 脚本其实早已 exit，调用方却挂住（实测 5 分钟才被杀）。
#      直接 `& boot.ps1 -Mode Start` 运行即可。
#   2. **启动 URL 里的 launch token 绝不写进仓库目录**（2026-10-23 review ②：以前写进 out-instance-*.log /
#      out-url.txt，导致每跑一次就要手工打码一次）。现在：dsh 的原始 stdout/stderr 落 `%TEMP%\rwui-1022-instance*`，
#      仓库里的 out-instance-*.log / out-url.txt 只有打码版本；**真 URL 只在 `%TEMP%\rwui-1022-live-url.txt`**
#      （Chrome 由脚本用内存里的真值启动，probe-render 走 CDP 的 page.url，不需要仓库里有真 URL）。
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

# 原始（含 token）日志与真 URL 只落 %TEMP%，不进仓库。
$logRaw = Join-Path $env:TEMP "rwui-1022-instance-$Port.log"
$logRawErr = "$logRaw.err"
$liveUrlFile = Join-Path $env:TEMP 'rwui-1022-live-url.txt'

# 打码：把 URL 里 token= 之后的值替换掉（保留结构，便于核对"确实取到过 URL"）。
function Redact([string]$text) { return ($text -replace '(?<=token=)[A-Za-z0-9._-]+', '<REDACTED>') }

# 把 %TEMP% 里的原始日志重写成仓库里的打码副本（原始日志不动）。
function Write-RedactedLogCopy {
  foreach ($pair in @(@($logRaw, $logFile), @($logRawErr, "$logFile.err"))) {
    $src = $pair[0]; $dst = $pair[1]
    if (-not (Test-Path -LiteralPath $src)) { continue }
    try { (Redact (Get-Content -LiteralPath $src -Raw -ErrorAction Stop)) | Set-Content -LiteralPath $dst -Encoding utf8 } catch { }
  }
}

function Write-Line([string]$text) { Write-Host $text; Add-Content -LiteralPath (Join-Path $OutDir 'out-boot.log') -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), (Redact $text)) -Encoding utf8 }

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
      # 原始 stdout/stderr（含 token URL）落 %TEMP%，仓库里只留打码副本（见文件头纪律 2）。
      $proc = Start-Process -FilePath $DshCmd -ArgumentList $argList -PassThru -WindowStyle Hidden -RedirectStandardOutput $logRaw -RedirectStandardError $logRawErr
      Write-Line "[$Profile] wrapper pid=$($proc.Id) port=$Port"
    } finally { Remove-Item env:DSH_HOME -ErrorAction SilentlyContinue }
    $deadline = (Get-Date).AddSeconds(120); $tokenUrl = $null
    while ((Get-Date) -lt $deadline -and $null -eq $tokenUrl) {
      $m = (Select-String -Path $logRaw, $logRawErr -Pattern 'https?://[^\s''"]*\?token=[A-Za-z0-9._-]+' -AllMatches -ErrorAction SilentlyContinue | ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } | Select-Object -Unique -Last 1)
      if ($m) { $tokenUrl = $m } else { Start-Sleep -Milliseconds 500 }
    }
    if (-not $tokenUrl) { Write-Line "没有从日志里拿到 token URL（原始日志：$logRaw）"; exit 3 }
    $ready = $false; $d2 = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $d2) { try { $r = Invoke-WebRequest -Uri $tokenUrl -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch { Start-Sleep -Milliseconds 700 } }
    $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($owner) { $owner | Set-Content -LiteralPath $pidFile -Encoding utf8 }
    # 仓库：只写打码 URL；真 URL 只到 %TEMP%（probe-render 走 CDP 的 page.url，不需要它）。
    @((Redact $tokenUrl), "（打码：真 URL 在 $liveUrlFile；原始日志 $logRaw；DSH_HOME=$Home0）") | Set-Content -LiteralPath $urlFile -Encoding utf8
    Set-Content -LiteralPath $liveUrlFile -Value $tokenUrl -Encoding utf8
    Write-RedactedLogCopy
    Write-Line "[$Profile] ready=$ready port=$Port owner=$owner url=$(Redact $tokenUrl)"
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
      # 归属判据与 instance 分支一致：**命令行必须带本轮 user-data-dir** 才许杀。
      # 2026-10-22 review 修：原先 pidfile 里的 PID 被无条件 Stop-Process —— PID 复用时会误杀别人的窗口。
      $cands = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($ChromeData) })
      $own = Get-CimInstance Win32_Process -Filter "ProcessId=$cp" -ErrorAction SilentlyContinue
      if ($own -and $own.Name -eq 'chrome.exe' -and $own.CommandLine -and $own.CommandLine -match [regex]::Escape($ChromeData)) {
        $cands = @($cands) + @($own)
      } elseif ($own) {
        Write-Line "拒绝停 chrome pid $cp（命令行不含本轮 user-data-dir，疑似 PID 复用）"
      }
      foreach ($c in ($cands | Sort-Object ProcessId -Unique)) {
        try { Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop; $killed += "chrome:$($c.ProcessId)" } catch {}
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
    if (-not $left -and -not $leftCdp) {
      Remove-Item -LiteralPath $pidFile, $chromePidFile -Force -ErrorAction SilentlyContinue
      # 进程已退出 ⇒ 原始日志不再被占用：刷新一次打码副本，并删掉 %TEMP% 里的真 URL。
      Write-RedactedLogCopy
      Remove-Item -LiteralPath $liveUrlFile -Force -ErrorAction SilentlyContinue
    } elseif (Test-Path -LiteralPath $liveUrlFile) {
      Write-Line "真 URL 仍在 $liveUrlFile（端口未清干净，保留以便续查）"
    }
  }
}
exit 0

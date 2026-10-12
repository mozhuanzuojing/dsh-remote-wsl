#!/usr/bin/env pwsh
# usab-run.ps1 —— task-5 可用性评估的**实例与证据骨架**（等 lead 说 go 之后才执行）。
#
# 只做四件事，全部可复算：
#   1) 记录/复核**用户正在用的宿主**（127.0.0.1:19387）的 pid —— 开工前后必须一致；
#   2) 生成**我自己的** --patch overlay（distro / cwd / daemonPort），先 --dump-config 校验再启动；
#   3) 另起一个**测试实例**（端口 8961，自有守护槽位 8962），只在 8961 上做评估；
#   4) 复算被验对象 revision（client/** + src/*.ts 的 SHA256+size）。
#
# 纪律：
#   · 绝不重启/停掉用户宿主（19387）；绝不全局 pkill；只按自己写的 pid 文件停自己的进程；
#   · 不写共享 profile（`remote-wsl-test`）的任何文件 —— 配置只经 `--patch` 传入；
#   · 端口只用 8961–8970；守护槽位只用 8962（不占他人 8731/8932/…）。
#
# 用法：
#   pwsh ./usab-run.ps1 -Mode Baseline                       # 记活宿主 pid
#   pwsh ./usab-run.ps1 -Mode DumpConfig                     # 只 compose 校验（不起实例）
#   pwsh ./usab-run.ps1 -Mode Start                          # 起测试实例 8961
#   pwsh ./usab-run.ps1 -Mode Start -Cwd /home/g             # 对照run：默认场景（验 D2）
#   pwsh ./usab-run.ps1 -Mode Revision                       # 复算被验对象 revision
#   pwsh ./usab-run.ps1 -Mode Stop                           # 只停自己起的实例
#   pwsh ./usab-run.ps1 -Mode Checklist                      # 打印浏览器取证步骤
[CmdletBinding()]
param(
  [ValidateSet('Baseline', 'DumpConfig', 'Start', 'Stop', 'Revision', 'Checklist')]
  [string]$Mode = 'Baseline',
  [int]$Port = 8961,
  [int]$DaemonPort = 8962,
  [string]$Distro = 'debian-u8-1',
  [string]$WslHome = '/home/g',
  [string]$Cwd = '/home/g/project/dsh1',
  [string]$Profile = 'remote-wsl-test',
  [string]$Vendor = 'D:\project\dsh1\vendor\dsh-remote-wsl',
  [string]$DshCmd = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
  [string]$OutDir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh' }

$pidFile = Join-Path $OutDir 'out-03-usabhost.pid'
$patchFile = Join-Path $OutDir 'out-11-patch.yml'
$logFile = Join-Path $OutDir ("out-03-usabhost-{0}.log" -f $Port)

function Get-LiveHostPid {
  (Get-NetTCPConnection -LocalPort 19387 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
}

switch ($Mode) {
  # ---------------------------------------------------------------- Baseline
  'Baseline' {
    $livePid = Get-LiveHostPid
    $liveFile = Join-Path $OutDir 'out-10-livehost-baseline.txt'
    @(
      "记录时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
      "用户正在用的宿主：127.0.0.1:19387 pid=$livePid —— 本评估绝不停/不重启它"
      "测试实例端口=$Port ｜ 自有守护槽位=$DaemonPort ｜ profile=$Profile（只读，配置走 --patch）"
      "被验对象=$Vendor（只读）"
    ) | Set-Content -LiteralPath $liveFile -Encoding utf8
    Write-Host "活宿主 pid=$livePid -> $liveFile"
    if (-not $livePid) { Write-Host "警告：19387 没在监听 —— 用户宿主可能已退出，需向 lead 报告"; exit 3 }
  }

  # ---------------------------------------------------------------- DumpConfig
  'DumpConfig' {
    @(
      "# task-5 可用性评估的 overlay（**不改共享 profile**，只经 dsh --patch 传入）"
      "# 目的：把场景钉在 /home/g/project/dsh1，把守护槽位钉在 8962（自有，不占他人）"
      "- id: remote-wsl"
      "  config:"
      "    distro: $Distro"
      "    wslHome: $WslHome"
      "    cwd: $Cwd"
      "    daemonPort: $DaemonPort"
    ) | Set-Content -LiteralPath $patchFile -Encoding utf8
    $dump = Join-Path $OutDir ("out-11-dumpconfig-{0}.txt" -f ($Cwd -replace '[\\/]', '_'))
    & $DshCmd '--profile' $Profile '--patch' $patchFile '--dump-config' *>&1 | Out-File -Encoding utf8 $dump
    $code = $LASTEXITCODE
    Write-Host "--dump-config exit=$code -> $dump"
    # 复核覆盖真的生效（否则后面的评估全建立在错的配置上）
    $hit = Select-String -Path $dump -Pattern 'daemonPort' -SimpleMatch | Select-Object -Last 3
    $hit | ForEach-Object { Write-Host ("  " + $_.Line.Trim()) }
    if ($code -ne 0) { exit 2 }
  }

  # ---------------------------------------------------------------- Start
  'Start' {
    if (-not (Test-Path -LiteralPath $patchFile)) { Write-Host "先跑 -Mode DumpConfig 生成 overlay"; exit 2 }
    # 端口自检：已被占就直接拒绝 —— 否则新实例会 EADDRINUSE 失败，而且 Start-Process 的重定向
    # 会**截断**上一份日志（实测踩过：合并了两个实例的日志，丢掉第一条 token URL）。
    $busyOwner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($busyOwner) { Write-Host "端口 $Port 已被 pid $busyOwner 占用 —— 先 -Mode Stop（拒绝启动以免截断日志/端口打架）"; exit 2 }
    $liveBefore = Get-LiveHostPid
    Write-Host "启动前活宿主 pid=$liveBefore"

    # 清掉从本会话继承的 DSH_*，只留 DSH_HOME（否则可能贴到用户宿主上）
    $scrub = @('DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL')
    $saved = @{}
    foreach ($n in $scrub) { if (Test-Path "env:$n") { $saved[$n] = (Get-Item "env:$n").Value; Remove-Item "env:$n" -ErrorAction SilentlyContinue } }
    try {
      # 不加 `web`：profile 的 bundles 已含 dsh-web-app，app 由 profile 决定；
      # 传 `web` 会被当作 app 参数 ⇒ 实测 `error: too many arguments. Expected 0 arguments but got 1: web.`
      $argList = @('--profile', $Profile, '--patch', $patchFile, '--port', "$Port", '--no-open')
      Write-Host "启动：$DshCmd $($argList -join ' ')  (log=$logFile)"
      $proc = Start-Process -FilePath $DshCmd -ArgumentList $argList -PassThru -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
      $proc.Id | Set-Content -LiteralPath $pidFile -Encoding utf8
      Write-Host "实例 pid=$($proc.Id) -> $pidFile"
    } finally {
      foreach ($k in $saved.Keys) { Set-Item "env:$k" $saved[$k] }
    }

    # 就绪判定：必须先用**日志里的带 token URL**（client-contract §8.4）——
    # 裸 `http://127.0.0.1:<port>/` 不是应用态，探测拿不到 200（实测过）。
    $urlFile = Join-Path $OutDir 'out-04-url.txt'
    $deadline = (Get-Date).AddSeconds(90)
    $tokenUrl = $null
    while ((Get-Date) -lt $deadline -and $null -eq $tokenUrl) {
      $m = (Select-String -Path $logFile, "$logFile.err" -Pattern 'https?://[^\s''"]*\?token=[A-Za-z0-9._-]+' -AllMatches -ErrorAction SilentlyContinue |
        ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } | Select-Object -Unique -Last 1)
      if ($m) { $tokenUrl = $m } else { Start-Sleep -Milliseconds 500 }
    }
    $probeUrl = if ($tokenUrl) { $tokenUrl } else { "http://127.0.0.1:$Port/" }
    if ($tokenUrl) {
      @("$tokenUrl", "（来源：$logFile —— 浏览器取证必须用这条 URL，不要用裸 http://127.0.0.1:$Port/）") |
        Set-Content -LiteralPath $urlFile -Encoding utf8
      Write-Host "带 token 的 URL -> $urlFile"
    } else {
      "未在日志里找到 token URL ⇒ 用裸 http://127.0.0.1:$Port/ 试，若页面不是应用态则记 unknown 并查日志" |
        Set-Content -LiteralPath $urlFile -Encoding utf8
      Write-Host "警告：没找到 ?token= URL（见 $urlFile）；可能该 profile 不需要 token"
    }

    $ready = $false
    $deadline2 = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline2) {
      try {
        $r = Invoke-WebRequest -Uri $probeUrl -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $ready = $true; break }
      } catch { Start-Sleep -Milliseconds 700 }
    }
    Write-Host "ready=$ready  probe=$probeUrl"
    if (-not $ready) { Write-Host "未就绪：看 $logFile / $logFile.err"; exit 3 }

    # 记录**真正持有端口的进程 pid**（`dsh.cmd` → cmd.exe → "DeepSeek Harness.exe" 三层，
    # Start-Process 拿到的只是最外层 cmd ⇒ 不能拿它当实例 pid，否则 Stop 会拒绝/杀不干净）
    $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($owner) {
      $owner | Set-Content -LiteralPath $pidFile -Encoding utf8
      Write-Host "端口 $Port 的持有者 pid=$owner -> $pidFile"
    } else {
      Write-Host "警告：没解析到端口 $Port 的持有者 pid；Stop 将退化为按 cmdline 匹配"
    }

    $liveAfter = Get-LiveHostPid
    Write-Host "活宿主 pid 仍为 $liveAfter（启动前 $liveBefore）—— 必须相等"
    if ($liveAfter -ne $liveBefore) { Write-Host "!! 碰到了用户宿主，立即停手报告"; exit 4 }
  }

  # ---------------------------------------------------------------- Stop
  'Stop' {
    # 安全前提：只停**能证明是我起的**实例 —— 判据是命令行里有我的 profile 或我的端口，
    # 且 pid ≠ 用户活宿主。dsh.cmd 是三层包装（cmd.exe → DeepSeek Harness.exe），
    # 所以既按 pid 文件、也按端口持有者来找，两层都验"是我的"。
    $livePid = Get-LiveHostPid
    $mine = @()
    if (Test-Path -LiteralPath $pidFile) {
      $p = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
      if ($p -gt 0) { $mine += $p }
    }
    $mine += (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess })
    $mine += (Get-CimInstance Win32_Process -Filter "Name='cmd.exe' OR Name='node.exe' OR Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and ($_.CommandLine -match "--port $Port\b" -or $_.CommandLine -match [regex]::Escape($patchFile)) } |
      ForEach-Object { $_.ProcessId })
    $mine = $mine | Where-Object { $_ } | Select-Object -Unique

    if (-not $mine) { Write-Host "没有找到我的实例（端口 $Port 无监听、无 pid 记录、无命令行匹配）"; exit 0 }

    $stopped = @()
    foreach ($p in $mine) {
      if ($p -eq $livePid) { Write-Host "拒绝：pid $p 是用户活宿主（19387）—— 绝不碰"; continue }
      $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
      if (-not $proc) { continue }
      if ($proc.ProcessName -notmatch '^(node|cmd|DeepSeek Harness)$') { Write-Host "拒绝：pid $p 名字异常（$($proc.ProcessName)）"; continue }
      $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue).CommandLine
      if (-not $cl -or -not ($cl -match "--port $Port\b" -or $cl -match [regex]::Escape($patchFile) -or $cl -match [regex]::Escape($Profile))) {
        Write-Host "拒绝：pid $p 的命令行看不出是我的实例（防误杀）"; continue
      }
      try { Stop-Process -Id $p -Force -ErrorAction Stop; $stopped += "$p($($proc.ProcessName))"; Write-Host "已停 pid=$p ($($proc.ProcessName))" }
      catch { Write-Host "停 pid=$p 失败：$($_.Exception.Message)" }
    }
    Start-Sleep -Seconds 2
    $left = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }) -join ','
    Write-Host "停掉的：$($stopped -join ' ') ｜ 端口 $Port 残留监听：$(if($left){$left}else{'无'})"
    if (-not $left) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }
    Write-Host "活宿主 pid=$(Get-LiveHostPid)（应仍与基线一致：$livePid）"
    if (-not $left) { exit 0 } else { exit 2 }
  }

  # ---------------------------------------------------------------- Revision
  'Revision' {
    $revFile = Join-Path $OutDir 'out-98-revision.txt'
    $lines = @()
    $lines += "# 被验对象 revision（只读复算） $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    foreach ($f in (Get-ChildItem -LiteralPath (Join-Path $Vendor 'src') -Filter '*.ts' -File | Sort-Object Name)) {
      $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
      $lines += ("src/{0}`t{1}`t{2}" -f $f.Name, $f.Length, $h)
    }
    $cl = Join-Path $Vendor 'client'
    if (Test-Path -LiteralPath $cl) {
      foreach ($f in (Get-ChildItem -LiteralPath $cl -File | Sort-Object Name)) {
        $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
        $lines += ("client/{0}`t{1}`t{2}" -f $f.Name, $f.Length, $h)
      }
    } else { $lines += "client/`t(MISSING)`t-" }
    # advisory：会改变打包/契约，但不算"被验对象自身"
    foreach ($n in @('package.json', 'cordis.patch.yml')) {
      $p = Join-Path $Vendor $n
      if (Test-Path -LiteralPath $p) {
        $h = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
        $lines += ("advisory/{0}`t{1}`t{2}" -f $n, (Get-Item $p).Length, $h)
      }
    }
    $lines | Set-Content -LiteralPath $revFile -Encoding utf8
    $lines | ForEach-Object { Write-Host $_ }
    Write-Host "-> $revFile"
  }

  # ---------------------------------------------------------------- Checklist
  'Checklist' {
    @'
浏览器取证步骤（chrome-devtools-mcp；每步落盘到本目录）
 0. pwsh ./usab-run.ps1 -Mode Baseline      → out-10-livehost-baseline.txt
 1. pwsh ./usab-run.ps1 -Mode DumpConfig    → out-11-patch.yml + out-11-dumpconfig-*.txt  （必须看到 daemonPort: 8962）
 2. pwsh ./usab-run.ps1 -Mode Start         → out-03-usabhost.pid / .log（ready=true）
 3. pwsh ./usab-run.ps1 -Mode Revision      → out-98-revision.txt
 4. list_pages → new_page(background:true) → navigate **out-04-url.txt 里的带 token URL**
        （裸 http://127.0.0.1:8961/ 不是应用态；契约 §8.4）
 5. 注入探针：evaluate_script(function = usab-instrument.js 内容)         → out-21 起点
 6. 截图 shot-01-rail-collapsed.png（先折叠侧栏，看图标可辨识性）
 7. 点 rail 图标（用 take_snapshot 拿 uid → click；**不用** 坐标猜）
 8. 抽取：evaluate_script(function = usab-dom.js 内容, filePath = out-12-dom-controls.json)
 8b. 范围探针：evaluate_script(function = usab-p0scope.js 内容)           → out-15-p0scope.json
        （lead Q3：缺口 G-* 不计分；偏差 X-* 必记；若 X-1 命中 ⇒ M6 由 N/A 改为"评停止有无确认"）
 8c. 若 X-1 命中：截图 shot-09-dev-controls.png（状态条上的起停控件，作偏差证据）
 9. 截图 shot-02-panel-open-light.png
10. 点「在新会话中打开」→ 抽取 + 截图 shot-06-action-note.png
        + 读注入探针（out-22-requests.json：看真实请求体，证明动作打了哪个 method）
11. 主题：evaluate_script(function = usab-theme.js 内容) → out-14-theme-*.json + shot-03-panel-open-dark.png
12. 持久性实验（D4）：改 distro 筛选 → 切走面板 → 切回 → 再抽一次 out-13-states.json
        + shot-07-{before,after}.png
13. 键盘（M10）：逐个 press_key Tab，记录 activeElement → out-23-focus-order.txt
14. 错误态：init script 注入 fetch 失败（或在无插件基线上取快照错误）→ shot-04-panel-error.png
        （必要时用自有 8962 槽位制造"守护不可达"；这是错误态用例，**不是** M6）
15. 空态：-Cwd 指向不存在路径 或 用不存在 distro 起实例 → shot-05-panel-empty.png
15b. 对照场景 S-CTRL（lead Q2 要求保留）：pwsh ./usab-run.ps1 -Mode Start -Cwd /home/g
        → 重跑步骤 7/8/8b + 截图 shot-08-ctrl-default-cwd.png → 数"用户要把 dsh1 弄进来"的真实成本（G-1）
16. console：list_console_messages → out-24-console.txt
17. pwsh ./usab-run.ps1 -Mode Revision（复算，须与步骤 3 相同）+ -Mode Stop
18. 写 REPORT-usability.md（结论 ≤450 字 + 动作序列 + 认知负荷清单 + ≥3 可发现性缺陷
        + P0 缺口表 + 偏差表 + ≥2 截图 + 未测项）

禁忌：不 bring_to_front 用户窗口；截图/点击只对 127.0.0.1:8961（对照 8963/8961 的 S-CTRL 实例）；
      不碰 19387（用户宿主）、不碰他人槽位；守护只动自己的 8962（且只在自己 ensure 起来之后）；
      **M6 在设计 P0 无对象 ⇒ 记 not-applicable，不为它去点不存在的东西或改实现**；
      发现"实现超出设计"的控件时：只读取证 + 截图，不改、不点破坏性动作，写进 §3.1 偏差表。
'@ | Write-Host
  }
}

exit 0

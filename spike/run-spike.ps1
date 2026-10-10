#!/usr/bin/env pwsh
#requires -Version 7.0
<#
.SYNOPSIS
  dsh-remote-wsl 「跨进程重连」spike 的一键演示：守护持有运行时 ⇒ 客户端退出后重连仍记得上下文。

.DESCRIPTION
  依次执行并打印每步原始输出：
    0. 前置清点（**记录基线**；共享 WSL 宿主下不断言"全局为 0"）
    1. 在 WSL 里起 daemon.ts（127.0.0.1:<Port>；`mise exec -- node`，零构建直跑 TS）
    2. client 第 1 轮（记住数字 7 / 只回 ACK）→ 客户端进程退出
    3. --status #1
    4. client 第 2 轮（**另一个进程**问同一个 key）→ 期望 7
    5. --status #2（证明 sessionId / runtimePid 未变）
    6. 第二个 key 验证互不干扰 + k1 再问一次仍记得 7
    7. 负向对照：收尾探针必须**能**看见自己活着的运行时（否则后面的"没了"是假 0）
    8. --shutdown（唯一会回收运行时的入口）
    9. 收尾核对（身份归属 + 基线差值）
   10. 反证实验：不走守护、两个独立进程复用同一 sessionId → 期望 -32603 already exists
   11. 附：--mode stale 对照（-WithStale）
   12. 反证实验后的最终清点
   13. 空闲回收（-WithIdle）
   14. 空闲回收后的清点

  **并发安全判据（为什么不再断言"全局为 0"）**
  本机 WSL 宿主被多个 agent / 多个 DSH 会话共享：别人的 `--profile sdk` 运行时会让
  `profile_sdk_procs=0`、`/tmp/dsh-rwsl-*=0` 这类全局断言**必然假红**；为了让它变绿而写
  全局 `pkill -f 'profile sd[k]'` 则会**误伤别人正在采集证据的活进程**。所以判据改成三条：
    (a) **身份归属**：只断言本次运行自己创建的 pid —— client 响应里的 `runtimePid`、
        ready 行/status 里的 `daemonPid` —— 在收尾时全部不存在；只断言**自己的端口**无监听、
        **自己的 pid 文件**已删。
    (b) **基线差值**：跑前采样 runtime PID 集合与 `/tmp/dsh-rwsl-*` 文件集合，跑后只对
        "本窗口新增"的 pid 逐个做存活判定：**新增且已死 = 残留**（断言为 0），
        **新增但活着 = 别人的活进程**（只报告、不判定）。
    (c) **禁止全局回收**：本脚本不出现全局 `pkill`；异常路径只按自己的 pid 文件精确 `kill`。
  端口隔离：`-Port`（默认 8731）默认与 `webPort`(3082) 错开；并发验收请传唯一端口（如 8741）。

  本脚本只读/只跑，不修改插件任何文件。写作用域限 spike/ 与系统临时目录。

  迁移后（.mjs → .ts，零构建）：Windows 侧客户端一律用 node 26.10 直跑 client.ts
  （Node 原生 type stripping，无 tsc / 无 dist）；WSL 侧一律 `mise exec -- node xxx.ts`。

.EXAMPLE
  pwsh -File D:\project\dsh1\vendor\dsh-remote-wsl\spike\run-spike.ps1 -Port 8741 -WithStale -WithIdle
#>
[CmdletBinding()]
param(
  [int]$Port = 8731,
  [string]$Distro = 'debian-u8-1',
  [string]$Version = '0.2.0-rc.2',
  [string]$Cwd = '/home/g',
  [int]$IdleMs = 1800000,
  [string]$Key1 = 'k1',
  [string]$Key2 = 'k2',
  [string]$NodeExe = 'C:\Users\l\AppData\Local\mise\shims\node.exe',
  [switch]$SkipRepro,
  [switch]$WithStale,
  [switch]$WithIdle
)

$ErrorActionPreference = 'Stop'
$script:Failures = @()
$script:StepNo = 0

function Step([string]$title) {
  $script:StepNo++
  Write-Host ''
  Write-Host ("=" * 78) -ForegroundColor DarkCyan
  Write-Host ("STEP {0}: {1}" -f $script:StepNo, $title) -ForegroundColor Cyan
  Write-Host ("=" * 78) -ForegroundColor DarkCyan
}
function Check([bool]$cond, [string]$msg) {
  if ($cond) { Write-Host "  [PASS] $msg" -ForegroundColor Green }
  else { Write-Host "  [FAIL] $msg" -ForegroundColor Red; $script:Failures += $msg }
}
function Note([string]$msg) { Write-Host "  [note] $msg" -ForegroundColor DarkGray }

function Invoke-Wsl([string]$bash) {
  $out = & wsl.exe -d $Distro -u g -- bash -c $bash 2>&1
  return @($out | ForEach-Object { "$_" })
}

# Windows 路径 → WSL /mnt 路径（D:\a\b → /mnt/d/a/b）
function ConvertTo-WslPath([string]$p) {
  $full = (Resolve-Path -LiteralPath $p).Path
  $drive = $full.Substring(0, 1).ToLower()
  $rest = $full.Substring(2).Replace('\', '/')
  return "/mnt/$drive$rest"
}

$SpikeDir = $PSScriptRoot
$WslSpike = ConvertTo-WslPath $SpikeDir
$ClientTs = Join-Path $SpikeDir 'client.ts'
$DaemonWsl = "$WslSpike/daemon.ts"
$ReproWsl = "$WslSpike/repro-conflict.ts"

# ── 自作用域回收的锚点：自己的 pid 文件（Windows %TEMP%，不属于 /tmp，也不与别人的 dsh-rwsl-* 混淆）
function PidFileFor([int]$p) { return (Join-Path $env:TEMP "dsh-rwsl-spike-ownpid-$p.pid") }

$daemonOut = Join-Path $env:TEMP "dsh-rwsl-spike-daemon-$Port.out.log"
$daemonErr = Join-Path $env:TEMP "dsh-rwsl-spike-daemon-$Port.err.log"
Remove-Item -LiteralPath $daemonOut, $daemonErr -ErrorAction SilentlyContinue
# 上一次本脚本自己的 pid 文件（只清自己的命名空间）
Remove-Item -LiteralPath (PidFileFor $Port), (PidFileFor ($Port + 1)) -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $NodeExe)) { throw "Windows node 不存在: $NodeExe（用 -NodeExe 指定）" }

# 客户端调用：stdout 是要贴的原始 JSON；stderr 是诊断，单独显示成灰色，避免污染 JSON
# 注意：参数名不能叫 $args（PowerShell 自动变量），否则 @args splat 会变成空数组、node 收不到任何参数
function Invoke-Client([string[]]$clientArgs) {
  $lines = & $NodeExe $ClientTs @clientArgs 2>&1
  $code = $LASTEXITCODE
  $stdout = @()
  foreach ($l in $lines) {
    if ($l -is [System.Management.Automation.ErrorRecord]) { Write-Host "      (client stderr) $l" -ForegroundColor DarkGray }
    else { $stdout += "$l" }
  }
  return [pscustomobject]@{ Raw = ($stdout -join "`n"); Exit = $code }
}
function Show-Raw([string]$label, $r) {
  Write-Host "  $label (exit=$($r.Exit)):" -ForegroundColor Yellow
  Write-Host "    $($r.Raw)"
}
function To-Json2($raw) { try { return $raw.Trim() | ConvertFrom-Json } catch { return $null } }

# 起一个守护：把 bash 启动脚本落地成文件再 `bash <file>` —— 绕开 pwsh→wsl.exe→bash 三层引号
# （实测 Start-Process 不会给参数加引号；内联 `bash -c "... | ... | ..."` 会被拆成多个参数而静默失败）
function Start-SpikeDaemon([int]$p, [int]$idle, [string]$tag) {
  $out = Join-Path $env:TEMP "dsh-rwsl-spike-$tag-$p.out.log"
  $err = Join-Path $env:TEMP "dsh-rwsl-spike-$tag-$p.err.log"
  Remove-Item -LiteralPath $out, $err -ErrorAction SilentlyContinue
  $bash = @'
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
exec mise exec -- node __DAEMON__ --port __PORT__ --version __VERSION__ --cwd __CWD__ --idle-ms __IDLE__
'@
  $bash = $bash.Replace('__DAEMON__', $DaemonWsl).Replace('__PORT__', [string]$p).
    Replace('__VERSION__', $Version).Replace('__CWD__', $Cwd).Replace('__IDLE__', [string]$idle)
  $win = Join-Path $env:TEMP "dsh-rwsl-spike-$tag-$p.sh"
  [IO.File]::WriteAllText($win, $bash.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
  $proc = Start-Process -FilePath 'wsl.exe' `
    -ArgumentList @('-d', $Distro, '-u', 'g', '--', 'bash', (ConvertTo-WslPath $win)) `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
  return [pscustomobject]@{ Proc = $proc; Out = $out; Err = $err }
}
function Wait-SpikeReady([int]$p, $d) {
  for ($i = 1; $i -le 60; $i++) {
    Start-Sleep -Milliseconds 750
    $r = Invoke-Client @('--port', "$p", '--status')
    if ($r.Exit -eq 0) { return @{ Status = (To-Json2 $r.Raw); Tries = $i; Last = $r } }
    if ($d.Proc.HasExited) { return @{ Status = $null; Tries = $i; Last = $r } }
  }
  return @{ Status = $null; Tries = 60; Last = $null }
}

# WSL 侧清点（纯展示用：全局量在共享宿主下不具归因性，故只显示、不断言）
# pgrep 用 'profile sd[k]' 正则，避免匹配到检查命令自身；
# find 不用 glob，避免 zsh nomatch 干扰（本发行版 `bash -lc` 会落到 zsh）。
# ⚠ 下面每行都是"自足的一行"：多行内联脚本里每行会各自在**全新 shell** 中执行，
#   所以第一行的 `export PATH` 实际上带不到后面几行（pgrep/find/ss 都在 /usr/bin，不依赖它）。
$checkTpl = @'
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
echo "profile_sdk_procs=$(pgrep -f -- 'profile sd[k]' | wc -l)"
echo "dsh_rwsl_tmp=$(find /tmp -maxdepth 1 -name 'dsh-rwsl-*' -print 2>/dev/null | wc -l)"
echo "port_listeners=$(ss -ltn | awk '$4 ~ /:__PORT__$/ {n++} END {print n+0}')"
'@
$checkScript = $checkTpl.Replace('__PORT__', [string]$Port)
function Get-Counts {
  $h = @{}
  foreach ($line in (Invoke-Wsl $checkScript)) {
    if ($line -match '^(\w+)=(\d+)$') { $h[$Matches[1]] = [int]$Matches[2] }
  }
  return $h
}
function Show-Counts($h) { Write-Host ("  " + (($h.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join '  ')) }
# 任意端口上的监听数（自作用域断言用；返回 -1 = 探针没解析出来，绝不当成 0）
# 注意不要写 `Check ((Invoke-Wsl ...) -match '…')`：Invoke-Wsl 返回**数组**，
# `-match` 在数组上返回匹配到的**子数组**，多元素时无法转 [bool] 会抛参数绑定错（迁移时踩过一次）。
function Get-PortListeners([int]$p) {
  foreach ($line in (Invoke-Wsl $checkTpl.Replace('__PORT__', [string]$p))) {
    if ($line -match '^port_listeners=(\d+)$') { return [int]$Matches[1] }
  }
  return -1
}

# ── 并发安全的核心：基线快照 + 差值 + 逐个存活判定 ────────────────────────────
# 取"全局"观测量（runtime PID 集合、/tmp/dsh-rwsl-* 文件名集合）**只为做差值**，不作为归因。
function Get-Snapshot {
  $tpl = @'
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
echo "RUNTIME_PIDS=$(pgrep -f -- 'profile sd[k]' | sort -n | tr '\n' ',')"
echo "TMP_FILES=$(find /tmp -maxdepth 1 -name 'dsh-rwsl-*' -printf '%f,' 2>/dev/null)"
echo "MY_PORT_LISTEN=$(ss -ltn | awk '$4 ~ /:__PORT__$/ {n++} END {print n+0}')"
'@
  $h = @{ RuntimePids = @(); TmpFiles = @(); MyPortListen = -1 }
  foreach ($line in (Invoke-Wsl $tpl.Replace('__PORT__', [string]$Port))) {
    if ($line -match '^RUNTIME_PIDS=(.*)$') {
      $h.RuntimePids = @(($Matches[1] -split ',') | Where-Object { $_ } | ForEach-Object { [int]$_ })
    } elseif ($line -match '^TMP_FILES=(.*)$') {
      $h.TmpFiles = @(($Matches[1] -split ',') | Where-Object { $_ })
    } elseif ($line -match '^MY_PORT_LISTEN=(\d+)$') {
      $h.MyPortListen = [int]$Matches[1]
    }
  }
  return $h
}
function New-Since($baselineSet, $nowSet) {
  # 本窗口"新增"的集合。只声称"基线里没有"，不声称"这些是我们的"（并发下无法归因）
  return @($nowSet | Where-Object { $baselineSet -notcontains $_ })
}
function Get-AliveMap([int[]]$pids) {
  # 逐个 pid 的存活判定 —— 用来把"本窗口新增"分成 活(=别人的活进程) / 已死(=残留候选)。
  #
  # ⚠ 必须写成**单行 `echo "KEY=$(pipeline)"`**，不能用多行 `for p in …; do … done`：
  #   实测本发行版里 `bash -c <多行脚本>` 的**每一行都各自在全新 shell 里执行**
  #   （`export PATH=…` / `cd …` / `x=5` 都不会带到下一行；`$0` 甚至落到 /usr/bin/zsh），
  #   于是多行 for 循环里的 `$p` 恒为空、`n=$(…)` 换行后读回也恒为空 —— 探针会"静默通过"。
  #   规律：① 单行 `;` 串联 = 同一个 shell；② 写成脚本文件再 `bash <file>` = 同一个 shell；
  #         ③ 多行内联 = 每行一个 shell（只有"每行自足"的 echo 行才安全）。
  $map = @{}
  $list = @($pids | Where-Object { $null -ne $_ } | Sort-Object -Unique)
  if ($list.Count -eq 0) { return $map }
  $tpl = @'
echo "LIVE_PIDS=$(ps -p __PIDS__ -o pid= 2>/dev/null | tr -d ' ' | tr '\n' ',')"
'@
  $live = @()
  foreach ($line in (Invoke-Wsl $tpl.Replace('__PIDS__', ($list -join ',')))) {
    if ($line -match '^LIVE_PIDS=(.*)$') {
      $live = @(($Matches[1] -split ',') | Where-Object { $_ } | ForEach-Object { [int]$_ })
    }
  }
  foreach ($p in $list) {
    if ($live -contains [int]$p) { $map[[int]$p] = 'alive' } else { $map[[int]$p] = 'dead' }
  }
  return $map
}
function Is-Alive($map, $pid) { return ($map[[int]$pid] -eq 'alive') }
function Test-AllDead([int[]]$pids) {
  $list = @($pids | Where-Object { $null -ne $_ } | ForEach-Object { [int]$_ })
  if ($list.Count -eq 0) { return $true }
  $map = Get-AliveMap $list
  $alive = @($list | Where-Object { $map[$_] -eq 'alive' })
  return [pscustomobject]@{ AllDead = ($alive.Count -eq 0); Alive = $alive; Map = $map }
}
function Show-DiffReport([string]$label, $baseline, $now) {
  $newPids = New-Since $baseline.RuntimePids $now.RuntimePids
  $newTmp = New-Since $baseline.TmpFiles $now.TmpFiles
  $map = Get-AliveMap $newPids
  $dead = @($newPids | Where-Object { $map[$_] -eq 'dead' })
  $live = @($newPids | Where-Object { $map[$_] -eq 'alive' })
  Note "$label 本窗口新增 runtime pid=[$($newPids -join ',')] 存活=[$($live -join ',')] 已死=[$($dead -join ',')]"
  Note "$label 本窗口新增 /tmp/dsh-rwsl-* = [$($newTmp -join ',')]"
  return [pscustomobject]@{ NewPids = $newPids; LiveNewPids = $live; DeadNewPids = $dead; NewTmp = $newTmp }
}
function Get-TmpResidueForPort([int]$p) {
  # 自作用域残留探针：本 spike 的启动脚本落在 Windows %TEMP%，守护直接 spawn bash -c，**从不写 /tmp**。
  # 所以"引用我这次唯一端口号"的 /tmp/dsh-rwsl-* 文件若存在，就一定是异常残留（与别人的文件无关）。
  # ⚠ 两个坑叠在这里，都必须绕开：
  #   ① 本发行版的 `bash` 侧 glob 未匹配时计数会假 0（README §6.4）⇒ 用 `find -name`，不写 `/tmp/dsh-rwsl-*`；
  #   ② 多行内联脚本会被"逐行拆成独立命令"执行（README §6.8）⇒ 不能写两行 `n=$(…)` / `echo $n`，
  #      必须压成**单行** `echo "KEY=$(单行管道)"`（实测两行版本里 `$n` 恒为空 ⇒ 探针恒返回 -1）。
  $tpl = @'
echo "RESIDUE=$(find /tmp -maxdepth 1 -name 'dsh-rwsl-*' -exec grep -l -- '__PORT__' {} + 2>/dev/null | wc -l)"
'@
  foreach ($line in (Invoke-Wsl $tpl.Replace('__PORT__', [string]$p))) {
    if ($line -match '^RESIDUE=(\d+)$') { return [int]$Matches[1] }
  }
  return -1
}

$daemonProc = $null
$shutdownDone = $false
$baseline = $null
$ownRuntimePids = @()
$ownDaemonPids = @()

try {
  # ── STEP 1 ────────────────────────────────────────────────────────────────
  Step "前置清点（记录基线；共享 WSL 宿主下**不断言全局为 0**）"
  $baseline = Get-Snapshot
  $before = Get-Counts
  Show-Counts $before
  Note "基线 runtime pids = [$($baseline.RuntimePids -join ',')]（含别的 agent/会话的进程，不清除、不算失败）"
  Note "基线 /tmp/dsh-rwsl-* = [$($baseline.TmpFiles -join ',')]"
  Check ($baseline.MyPortListen -eq 0) "起始 $Port 端口空闲（只断言自己的端口）"

  # 零构建的前提：Node 必须够新。23.6 起 type stripping 默认开启；本 spike 基线 26.10，
  # 低于它就可能被 Node 拒绝解析 .ts（或需要实验开关），所以这里显式当一条验收项。
  $winNodeVer = ((& $NodeExe --version 2>&1) | ForEach-Object { "$_" }) -join ''
  $wslNodeVer = (Invoke-Wsl 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"; mise exec -- node --version' | Select-Object -First 1)
  Note "node(win)=$winNodeVer  node(wsl)=$wslNodeVer（.ts 直跑依赖 Node 原生 type stripping）"
  $winNodeOk = $false
  if ($winNodeVer -match '^v(\d+)\.(\d+)') {
    $winNodeOk = ([int]$Matches[1] -gt 26) -or (([int]$Matches[1] -eq 26) -and ([int]$Matches[2] -ge 10))
  }
  Check $winNodeOk "Windows 侧 node ≥ 26.10（实测 $winNodeVer）"
  $wslNodeOk = $false
  if ("$wslNodeVer" -match '^v(\d+)\.(\d+)') {
    $wslNodeOk = ([int]$Matches[1] -gt 26) -or (([int]$Matches[1] -eq 26) -and ([int]$Matches[2] -ge 10))
  }
  Check $wslNodeOk "WSL 侧 node ≥ 26.10（实测 $wslNodeVer）"

  # ── STEP 2 ────────────────────────────────────────────────────────────────
  Step "起守护进程（WSL 内 mise exec -- node daemon.ts，监听 127.0.0.1:$Port）"
  Note '启动方式：把 bash 启动脚本落地成文件再 bash <file> —— 绕开 pwsh→wsl.exe→bash 三层引号'
  Note '（实测 Start-Process 不会给参数加引号，内联 bash -c ... 会被拆成多个参数而静默失败）'
  $d1 = Start-SpikeDaemon $Port $IdleMs 'main'
  $daemonProc = $d1.Proc
  $daemonOut = $d1.Out
  $daemonErr = $d1.Err

  $ready = Wait-SpikeReady $Port $d1
  $status = $ready.Status
  if (Test-Path -LiteralPath $daemonOut) { Write-Host "  daemon stdout: $(Get-Content -LiteralPath $daemonOut -Raw)" }
  Check ($null -ne $status -and $status.ok -eq $true) "守护进程就绪（--status ok:true，尝试 $($ready.Tries) 次）"
  if ($null -eq $status -and $null -ne $ready.Last) { Write-Host "  最后一次 --status: exit=$($ready.Last.Exit) raw=$($ready.Last.Raw)" -ForegroundColor Yellow }
  Start-Sleep -Milliseconds 300
  if (Test-Path -LiteralPath $daemonErr) { Write-Host "  daemon log head:"; Get-Content -LiteralPath $daemonErr | Select-Object -First 3 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
  if ($null -eq $status) { throw "守护进程未就绪：$(if (Test-Path $daemonErr) { Get-Content $daemonErr -Raw } else { 'no log' })" }
  $daemonPid = [int]$status.daemonPid
  $ownDaemonPids += $daemonPid
  Set-Content -LiteralPath (PidFileFor $Port) -Value "$daemonPid" -NoNewline
  Note "daemonPid=$daemonPid（已写入自己的 pid 文件 $(PidFileFor $Port)） dsh@$($status.version) cwd=$($status.cwd) idleMs=$($status.idleMs)"

  # ── STEP 3 ────────────────────────────────────────────────────────────────
  Step "client 第 1 轮（新进程）：记住数字 7，只回 ACK"
  $r1 = Invoke-Client @('--host', '127.0.0.1', '--port', "$Port", '--key', $Key1, '--text', '记住数字 7，只回 ACK')
  Show-Raw 'round1 raw response' $r1
  $j1 = To-Json2 $r1.Raw
  Check ($r1.Exit -eq 0 -and $j1.ok -eq $true) "round1 ok:true"
  Check ($j1.answer -match 'ACK') "round1 answer 含 ACK（实际: $($j1.answer)）"
  $s1 = $j1.sessionId; $p1 = [int]$j1.runtimePid
  $ownRuntimePids += $p1
  Note "sessionId=$s1 runtimePid=$p1 completedBy=$($j1.completedBy)"
  Note "客户端进程已退出（exit=$($r1.Exit)）—— 守护与运行时必须还活着"

  # ── STEP 4 ────────────────────────────────────────────────────────────────
  Step "--status #1（客户端退出后第一次观察）"
  $st1 = Invoke-Client @('--port', "$Port", '--status')
  Show-Raw 'status #1 raw response' $st1
  $k1a = (To-Json2 $st1.Raw).keys | Where-Object { $_.key -eq $Key1 }
  Check ($null -ne $k1a) "status #1 里 key=$Key1 仍在（运行时没被客户端退出带走）"
  Check ($k1a.sessionId -eq $s1) "status #1 sessionId 与 round1 一致"

  # ── STEP 5 ────────────────────────────────────────────────────────────────
  Step "client 第 2 轮（**另一个独立进程**）：刚才让你记的数字？只回数字 —— 期望 7"
  $r2 = Invoke-Client @('--host', '127.0.0.1', '--port', "$Port", '--key', $Key1, '--text', '刚才让你记的数字？只回数字')
  Show-Raw 'round2 raw response' $r2
  $j2 = To-Json2 $r2.Raw
  Check ($j2.ok -eq $true) "round2 ok:true"
  Check ($j2.answer.Trim() -eq '7') "round2 answer 恰为 7（跨进程上下文保留 = 重连成立）；实际: '$($j2.answer)'"
  Check ($j2.sessionId -eq $s1) "round2 sessionId 与 round1 一致"
  Check ($j2.runtimePid -eq $p1) "round2 runtimePid 与 round1 一致"
  Check ($j2.turns -eq 2) "round2 turns=2"

  # ── STEP 6 ────────────────────────────────────────────────────────────────
  Step "--status #2（对比 sessionId / runtimePid 是否未变）"
  $st2 = Invoke-Client @('--port', "$Port", '--status')
  Show-Raw 'status #2 raw response' $st2
  $jst2 = To-Json2 $st2.Raw
  $k1b = $jst2.keys | Where-Object { $_.key -eq $Key1 }
  Check ($k1b.sessionId -eq $s1) "status #2 sessionId 未变（$s1）"
  Check ($k1b.runtimePid -eq $p1) "status #2 runtimePid 未变（$p1）"
  Check ($jst2.daemonPid -eq $daemonPid) "status #2 daemonPid 未变（$daemonPid）"
  Check ($k1b.turns -eq 2) "status #2 turns=2"

  # ── STEP 7 ────────────────────────────────────────────────────────────────
  Step "第二个 key（$Key2）验证各自独立运行时；再回头问 $Key1 验证互不干扰"
  $r3 = Invoke-Client @('--host', '127.0.0.1', '--port', "$Port", '--key', $Key2, '--text', '只回复 SECOND')
  Show-Raw "key=$Key2 raw response" $r3
  $j3 = To-Json2 $r3.Raw
  Check ($j3.ok -eq $true -and $j3.answer -match 'SECOND') "$Key2 ok 且 answer 含 SECOND（实际: $($j3.answer)）"
  Check ($j3.sessionId -ne $s1) "$Key2 的 sessionId 与 $Key1 不同"
  Check ($j3.runtimePid -ne $p1) "$Key2 的 runtimePid 与 $Key1 不同（各持一个独立运行时）"
  $p3 = [int]$j3.runtimePid
  $ownRuntimePids += $p3

  $st3 = Invoke-Client @('--port', "$Port", '--status')
  Show-Raw 'status #3 raw response（应有 2 个 key）' $st3
  $jst3 = To-Json2 $st3.Raw
  Check ($jst3.keys.Count -eq 2) "status #3 有 2 个 key"

  $r4 = Invoke-Client @('--host', '127.0.0.1', '--port', "$Port", '--key', $Key1, '--text', '再重复一次刚才那个数字，只回数字')
  Show-Raw "回到 $Key1 raw response" $r4
  $j4 = To-Json2 $r4.Raw
  Check ($j4.answer.Trim() -eq '7') "$Key1 在 $Key2 活动之后仍记得 7；实际: '$($j4.answer)'"
  Check ($j4.sessionId -eq $s1 -and $j4.runtimePid -eq $p1) "$Key1 仍是同一 sessionId/runtimePid"

  # ── STEP 8 ────────────────────────────────────────────────────────────────
  Step "负向对照：探针必须**能**看见本次运行自己活着的运行时与监听端口（否则后面的"没了"是假 0）"
  $live = Get-Snapshot
  Show-Counts (Get-Counts)
  Note "此刻 runtime pids=[$($live.RuntimePids -join ',')]（含别人的；只用来对照）"
  Check ($live.MyPortListen -eq 1) "探针能查到自己在 $Port 上监听（实测 $($live.MyPortListen)）"
  $mySeen = @($ownRuntimePids | Where-Object { $live.RuntimePids -contains $_ })
  Check ($mySeen.Count -eq $ownRuntimePids.Count) "探针能查到本次运行的两个运行时 pid=[$($ownRuntimePids -join ',')]（查到 [$($mySeen -join ',')]）"

  # ── STEP 9 ────────────────────────────────────────────────────────────────
  Step "--shutdown（唯一会回收运行时的入口）"
  $rs = Invoke-Client @('--port', "$Port", '--shutdown')
  Show-Raw 'shutdown raw response' $rs
  $js = To-Json2 $rs.Raw
  Check ($js.ok -eq $true -and $js.reaped.Count -eq 2) "shutdown ok 且回收 2 个运行时"
  $shutdownDone = $true
  Start-Sleep -Seconds 2

  # ── STEP 10 ───────────────────────────────────────────────────────────────
  Step "收尾核对：身份归属（本次运行的 pid）+ 基线差值（并发下不判别人的活进程）"
  $after = Get-Snapshot
  Show-Counts (Get-Counts)
  $rdead = Invoke-Client @('--port', "$Port", '--status')
  Check ($rdead.Exit -eq 2) "守护已退出：--status 传输层失败（exit=2）：$($rdead.Raw)"
  $own = Test-AllDead $ownRuntimePids
  Check $own.AllDead "本次运行创建的运行时 pid 全部已消失：[$($ownRuntimePids -join ',')]（仍存活=[$($own.Alive -join ',')]）"
  $ownD = Test-AllDead $ownDaemonPids
  Check $ownD.AllDead "本次运行创建的守护 pid 全部已消失：[$($ownDaemonPids -join ',')]（仍存活=[$($ownD.Alive -join ',')]）"
  Check ($after.MyPortListen -eq 0) "自己的端口 $Port 无监听"
  $rep = Show-DiffReport '收尾' $baseline $after
  Check ($rep.DeadNewPids.Count -eq 0) "本窗口新增且已死的 runtime pid = 0（新增但活着的 [$($rep.LiveNewPids -join ',')] 是别人的活进程，不判）"
  $resid = Get-TmpResidueForPort $Port
  Check ($resid -eq 0) "/tmp/dsh-rwsl-* 中引用本运行端口 $Port 的残留 = 0（自己作用域；实测 $resid）"
  # 守护已确认退出 ⇒ 这个 pid 文件完成使命；删掉后再断言"自己的产物零残留"
  Remove-Item -LiteralPath (PidFileFor $Port) -Force -ErrorAction SilentlyContinue
  Check (-not (Test-Path -LiteralPath (PidFileFor $Port))) "自己的 pid 文件已清理（$(PidFileFor $Port)）"

  # ── STEP 11 ───────────────────────────────────────────────────────────────
  if (-not $SkipRepro) {
    Step "反证实验：不走守护，两个独立进程各自起 dsh --profile sdk 复用同一 sessionId"
    Note "用法: mise exec -- node repro-conflict.ts --mode alive （A 先建会话并保持存活，B 拿同一 id 发 prompt）"
    $reproScript = "export PATH=`"`$HOME/.local/bin:`$HOME/.local/share/mise/shims:`$PATH`"; cd $WslSpike; mise exec -- node repro-conflict.ts --mode alive --version $Version --cwd $Cwd"
    $reproOut = Invoke-Wsl $reproScript
    $reproText = $reproOut -join "`n"
    Write-Host $reproText
    Check ($reproText -match 'already exists') "直连复现到 'already exists'"
    Check ($reproText -match '-32603') "直连复现到 JSON-RPC 错误码 -32603"

    if ($WithStale) {
      Step "附：--mode stale 对照（A 已 shutdown 后再复用同一 id）"
      $staleOut = Invoke-Wsl "export PATH=`"`$HOME/.local/bin:`$HOME/.local/share/mise/shims:`$PATH`"; cd $WslSpike; mise exec -- node repro-conflict.ts --mode stale --version $Version --cwd $Cwd"
      Write-Host ($staleOut -join "`n")
    }

    Step "反证实验后的最终清点"
    Show-Counts (Get-Counts)
    # 反证实验自己通过 SdkRuntime.close() 回收进程组；这里只做基线差值（不归因、不全局 pkill）
    $finalSnap = Get-Snapshot
    $rep2 = Show-DiffReport '反证后' $baseline $finalSnap
    Check ($rep2.DeadNewPids.Count -eq 0) "反证实验后：本窗口新增且已死的 runtime pid = 0（存活=[$($rep2.LiveNewPids -join ',')] 不判）"
    Check ($finalSnap.MyPortListen -eq 0) "自己的端口 $Port 无监听"
    Check ((Get-TmpResidueForPort $Port) -eq 0) "/tmp/dsh-rwsl-* 中引用本运行端口 $Port 的残留 = 0"
  }

  # ── STEP 14（-WithIdle）───────────────────────────────────────────────────
  if ($WithIdle) {
    $idlePort = $Port + 1
    $idleMs2 = 15000
    Step "空闲回收（--idle-ms $idleMs2，端口 $idlePort）：无人连接的运行时被守护回收；同 key 再来 ⇒ 新 sessionId（上下文丢失）"
    $d2 = Start-SpikeDaemon $idlePort $idleMs2 'idle'
    $idleShutdownDone = $false
    $idleRuntimePids = @()
    $idleDaemonPid = $null
    try {
      $rd = Wait-SpikeReady $idlePort $d2
      Check ($null -ne $rd.Status -and $rd.Status.ok -eq $true) "idle 守护就绪（尝试 $($rd.Tries) 次）"
      if ($null -ne $rd.Status) {
        $idleDaemonPid = [int]$rd.Status.daemonPid
        $ownDaemonPids += $idleDaemonPid
        Set-Content -LiteralPath (PidFileFor $idlePort) -Value "$idleDaemonPid" -NoNewline
      }
      $ri = Invoke-Client @('--host', '127.0.0.1', '--port', "$idlePort", '--key', $Key1, '--text', '只回复 IDLE-OK')
      Show-Raw 'idle 场景第 1 轮 raw response' $ri
      $ji = To-Json2 $ri.Raw
      Check ($ji.ok -eq $true) "idle 场景第 1 轮 ok:true"
      $sIdle = $ji.sessionId
      $pIdle = [int]$ji.runtimePid
      $idleRuntimePids += $pIdle
      $stBefore = Invoke-Client @('--port', "$idlePort", '--status')
      Show-Raw 'idle 回收前 status' $stBefore
      Check ((To-Json2 $stBefore.Raw).keys.Count -eq 1) "回收前 keys=1（sessionId=$sIdle runtimePid=$pIdle）"
      $waitS = [int]($idleMs2 / 1000) + 6
      Note "等待 ${waitS}s（首轮 prompt 结束时才开始计时）"
      Start-Sleep -Seconds $waitS
      $stAfter = Invoke-Client @('--port', "$idlePort", '--status')
      Show-Raw 'idle 回收后 status' $stAfter
      Check ((To-Json2 $stAfter.Raw).keys.Count -eq 0) "空闲超时后 keys=0（运行时被守护回收）"
      $pIdleAlive = Test-AllDead @($pIdle)
      Check $pIdleAlive.AllDead "被回收的运行时进程 $pIdle 已不存在（仍存活=[$($pIdleAlive.Alive -join ',')]）"
      $ri2 = Invoke-Client @('--host', '127.0.0.1', '--port', "$idlePort", '--key', $Key1, '--text', '只回复 AGAIN')
      Show-Raw '同 key 在回收后再 prompt' $ri2
      $ji2 = To-Json2 $ri2.Raw
      Check ($ji2.sessionId -ne $sIdle -and $ji2.turns -eq 1) "回收后同 key 拿到新 sessionId 且 turns=1（上下文丢失 = 空闲回收的代价，已知缺陷）"
      if ($null -ne $ji2.runtimePid) { $idleRuntimePids += [int]$ji2.runtimePid }
      $null = Invoke-Client @('--port', "$idlePort", '--shutdown')
      $idleShutdownDone = $true
      Start-Sleep -Seconds 2
    }
    finally {
      # 自作用域回收：只按自己的 pid 文件精确 kill（不再 pkill 'profile sd[k]' —— 会误伤别人的活进程）
      if (-not $idleShutdownDone -and (Test-Path -LiteralPath (PidFileFor $idlePort))) {
        $dp = (Get-Content -LiteralPath (PidFileFor $idlePort) -Raw).Trim()
        if ($dp -match '^\d+$') {
          $null = Invoke-Wsl "kill -TERM $dp 2>/dev/null; sleep 1; kill -KILL $dp 2>/dev/null; true"
          Write-Host "  已按自己的 pid 文件回收 idle daemon pid=$dp" -ForegroundColor DarkGray
        }
      }
      if ($d2.Proc -and -not $d2.Proc.HasExited) { try { Stop-Process -Id $d2.Proc.Id -Force -ErrorAction SilentlyContinue } catch { } }
      Write-Host "  idle daemon 日志尾部:" -ForegroundColor DarkGray
      if (Test-Path -LiteralPath $d2.Err) { Get-Content -LiteralPath $d2.Err | Select-Object -Last 8 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
    }
    try {
      $idleAfter = Get-Snapshot
      Show-Counts (Get-Counts)
      $idleOwn = Test-AllDead $idleRuntimePids
      Check $idleOwn.AllDead "idle 场景本次创建的运行时 pid 全部已消失：[$($idleRuntimePids -join ',')]（仍存活=[$($idleOwn.Alive -join ',')]）"
      $idleDaemonAlive = Test-AllDead @($idleDaemonPid)
      Check $idleDaemonAlive.AllDead "idle 守护 pid=$idleDaemonPid 已消失"
      Check ($idleAfter.MyPortListen -eq 0) "自己的端口 $Port 无监听"
      Check ((Get-PortListeners $idlePort) -eq 0) "自己的 idle 端口 $idlePort 无监听"
      $rep3 = Show-DiffReport 'idle 后' $baseline $idleAfter
      Check ($rep3.DeadNewPids.Count -eq 0) "idle 后：本窗口新增且已死的 runtime pid = 0（存活=[$($rep3.LiveNewPids -join ',')] 不判）"
      Check ((Get-TmpResidueForPort $Port) -eq 0) "/tmp/dsh-rwsl-* 中引用本运行端口 $Port 的残留 = 0"
      Check ((Get-TmpResidueForPort $idlePort) -eq 0) "/tmp/dsh-rwsl-* 中引用本运行 idle 端口 $idlePort 的残留 = 0"
      Remove-Item -LiteralPath (PidFileFor $idlePort) -Force -ErrorAction SilentlyContinue
      Check (-not (Test-Path -LiteralPath (PidFileFor $idlePort))) "自己的 idle pid 文件已清理（$(PidFileFor $idlePort)）"
    } finally {
      Remove-Item -LiteralPath (PidFileFor $idlePort) -Force -ErrorAction SilentlyContinue
    }
  }
}
finally {
  if (-not $shutdownDone) {
    Write-Host ''
    Write-Host "!! 异常退出：尽力回收（只回收本次运行自己的 pid：--shutdown + 按 pid 文件 kill）" -ForegroundColor Yellow
    $null = Invoke-Client @('--port', "$Port", '--shutdown') 2>$null
    Start-Sleep -Seconds 1
    foreach ($pf in @((PidFileFor $Port), (PidFileFor ($Port + 1)))) {
      if (Test-Path -LiteralPath $pf) {
        $dp = (Get-Content -LiteralPath $pf -Raw).Trim()
        if ($dp -match '^\d+$') {
          $null = Invoke-Wsl "kill -TERM $dp 2>/dev/null; sleep 1; kill -KILL $dp 2>/dev/null; true"
          Write-Host "  已按自己的 pid 文件回收 daemon pid=$dp（$pf）" -ForegroundColor DarkGray
        }
      }
    }
  }
  if ($daemonProc -and -not $daemonProc.HasExited) {
    try { Stop-Process -Id $daemonProc.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
  # 自己的 pid 文件属于本次运行的产物：无论成败都要清掉
  Remove-Item -LiteralPath (PidFileFor $Port), (PidFileFor ($Port + 1)) -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  if ($null -ne $baseline) {
    $tailSnap = Get-Snapshot
    Show-Counts (Get-Counts)
    $null = Show-DiffReport '最终' $baseline $tailSnap
    $leftoverPidFiles = @(@((PidFileFor $Port), (PidFileFor ($Port + 1))) | Where-Object { Test-Path -LiteralPath $_ })
    Note "自己的 pid 文件残留 = $($leftoverPidFiles.Count)"
  }
  if (Test-Path -LiteralPath $daemonErr) {
    Write-Host "  daemon 日志尾部（证据：client disconnected (runtimes kept alive)）:" -ForegroundColor DarkGray
    Get-Content -LiteralPath $daemonErr | Select-Object -Last 6 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
  }
}

Write-Host ''
Write-Host ("=" * 78) -ForegroundColor DarkCyan
if ($script:Failures.Count -eq 0) {
  Write-Host "SPIKE RESULT: ALL CHECKS PASSED" -ForegroundColor Green
  exit 0
} else {
  Write-Host "SPIKE RESULT: $($script:Failures.Count) CHECK(S) FAILED" -ForegroundColor Red
  $script:Failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}

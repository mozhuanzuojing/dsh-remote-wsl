#!/usr/bin/env pwsh
# daemon-invariance.ps1 —— 验收⑤「关闭/切换面板不杀守护（前后对比 pid/端口/keys）」
#
# 子命令：
#   -Mode Capture  -Port 8932 -Out out-11-daemon-before.json   # 采集事实（probe status + WSL pgrep/ss）
#   -Mode Compare  -Before a.json -After b.json -Out out-11-*.json
#   -Mode SelfTest                                             # 证明比较器有区分力
#
# 退出码：0 = 守护事实无变化；1 = 有变化（红）；3 = 证据不足（守护根本没在跑 / 无法解析 => 不可判，绝不算通过）
[CmdletBinding()]
param(
  [ValidateSet('Capture', 'Compare', 'SelfTest')][string]$Mode = 'SelfTest',
  [switch]$SelfTest,
  [int]$Port = 8932,
  [string]$Distro = 'debian-u8-1',
  [string]$Probe,
  [string]$Node = 'C:\Users\l\AppData\Local\mise\shims\node.exe',
  [string]$Out, [string]$Before, [string]$After, [string]$OutFile,
  [string]$OutDir = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
if ($SelfTest) { $Mode = 'SelfTest' }
if (-not $Probe) { $Probe = Join-Path $OutDir 'probe-ground-truth.ts' }

function Wsl-Bash([string]$script) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
  return ((& wsl.exe -d $Distro -u g -- bash -c "echo $b64 | base64 -d | bash" 2>&1) -join "`n")
}

function Parse-Probe([string]$text) {
  # 实盘格式（2026-10-12 实测）：
  #   `daemon: pid=750364 actualPort=8932 slot=8932 version=0.2.0-rc.2 cwd=/home/g profile=sdk`
  #   `machine: slot=8932 pid=750364 port=8932 version=0.2.0-rc.2 keys=0 orphans=0`
  #   `keys (0): (none)` / `keys (1): k session=… turns=… runtimePid=… idleForMs=…`
  # 也兼容旧式 `daemon: pid=… port=… version=…`（只认这些形状，未命中即 unknown/不判通过）
  $r = [ordered]@{ pid = $null; port = $null; slot = $null; version = $null; running = $false; keys = @(); keyCount = $null; scopedToSlot = $null; unscopedNote = $null; raw = '' }
  $dl = @($text -split "`n" | Where-Object { $_ -match '^daemon:' }) | Select-Object -First 1
  if ($dl) {
    $m = [regex]::Match($dl, 'pid=(\d+)'); if ($m.Success) { $r.pid = [int]$m.Groups[1].Value; $r.running = $true }
    $m = [regex]::Match($dl, '(?:actualPort|port)=(\d+)'); if ($m.Success) { $r.port = [int]$m.Groups[1].Value }
    $m = [regex]::Match($dl, 'slot=(\d+)'); if ($m.Success) { $r.slot = [int]$m.Groups[1].Value }
    $m = [regex]::Match($dl, 'version=(\S+)'); if ($m.Success) { $r.version = $m.Groups[1].Value }
  } elseif ($text -match 'daemon:\s*not running') { $r.running = $false }

  $mk = [regex]::Match($text, '(?m)^keys \((\d+)\):\s*(.+?)\s*$')
  if ($mk.Success) {
    $r.keyCount = [int]$mk.Groups[1].Value
    $tail = $mk.Groups[2].Value.Trim()
    if ($tail -ne '(none)') {
      $r.keys = @([regex]::Matches($tail, '(?<k>[A-Za-z0-9_.:/@\-]+)\s+session=(?<s>\S+)(?:.*?runtimePid=(?<rp>\d+))?') | ForEach-Object { [pscustomobject]@{ key = $_.Groups['k'].Value; session = $_.Groups['s'].Value; runtimePid = $(if ($_.Groups['rp'].Success) { [int]$_.Groups['rp'].Value } else { $null }) } })
    }
  }
  $r.raw = ($text -split "`n" | Where-Object { $_ -match '^(daemon|machine|keys) ?\(?' }) -join "`n"
  return [pscustomobject]$r
}

function Capture($port) {
  if (-not (Test-Path -LiteralPath $Probe)) { throw "找不到 probe: $Probe" }
  $tmp = Join-Path $OutDir ("tmp-probe-daemon-{0}.txt" -f (Get-Date -Format 'HHmmss'))
  $q = '"' + $Probe + '" --mode daemon --action status --port ' + $port
  # ⚠️ 用户可见窗口硬规矩（lead 2026-10-12）：起外部进程一律 `-WindowStyle Hidden`（`-NoNewWindow` 不算安全）
  $p = Start-Process -FilePath $Node -ArgumentList $q -WindowStyle Hidden -PassThru -RedirectStandardOutput $tmp -RedirectStandardError "$tmp.err"
  $p.WaitForExit()
  $probeText = if (Test-Path -LiteralPath $tmp) { (Get-Content -LiteralPath $tmp -Raw) } else { '' }
  $probeParsed = Parse-Probe $probeText

  # ⚠️ 实测（2026-10-12）：`wsl_daemon status`/`wsl_status` 报的是**被发现的那个**守护，不保证是我方槽位。
  # 我把我方 8932 停掉后，probe 立刻改报**其它槽位** 8912 的 pid/port —— 若不设这道闸，
  # ⑤ 的 pid/port 比对就会被非本方槽位的守护带跑（假绿或假红）。只有 slot/port 命中我方槽位才认这些值。
  # 措辞（lead 2026-10-12 更正）：8912 属 T2 端口段 8911–8920、8731 是插件默认口 ⇒ 是**同队其它槽位**（属主未确认），不是环境污染。
  $probeParsed.scopedToSlot = ($null -ne $probeParsed.slot -and $probeParsed.slot -eq $port)
  if ($probeParsed.running -and -not $probeParsed.scopedToSlot) {
    $probeParsed.unscopedNote = "probe 报的守护在 slot=$($probeParsed.slot) port=$($probeParsed.port)（≠ 我方 $port）=> pid/port/version 一律记 unknown，不得当通过"
  }

  # ⚠️ 必须**只数自己的槽位**：同一发行版里可能有**同队其它槽位**的守护（准备期实测 8912、8731）。
  # 若用 `pgrep -af daemon.ts` 全量比对，其它槽位守护的启停会变成我的假红。
  $pgrepMine = Wsl-Bash ("pgrep -af 'daemon\.t[s] --port $port' || true")
  $pgrepAll = Wsl-Bash ("pgrep -af 'daemon\.t[s]' || true")
  $ss = Wsl-Bash ("ss -ltnp 2>/dev/null | grep ':$port ' || echo '(no listener on $port)'")

  return [pscustomobject]@{
    capturedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    port = $port; distro = $Distro
    probeExit = $p.ExitCode; probeRaw = $probeText; probeFile = $tmp
    status = $probeParsed
    pgrep = @($pgrepMine -split "`n" | Where-Object { $_.Trim() })
    pgrepPids = @([regex]::Matches($pgrepMine, '(?m)^(\d+)\s') | ForEach-Object { [int]$_.Groups[1].Value })
    pgrepAll = @($pgrepAll -split "`n" | Where-Object { $_.Trim() })
    pgrepAllPids = @([regex]::Matches($pgrepAll, '(?m)^(\d+)\s') | ForEach-Object { [int]$_.Groups[1].Value })
    otherSlotDaemons = @([regex]::Matches($pgrepAll, '(?m)^(\d+)\s.*--port (\d+)') | Where-Object { [int]$_.Groups[2].Value -ne $port } | ForEach-Object { "pid=$($_.Groups[1].Value) slot=$($_.Groups[2].Value)" })
    listeners = @($ss -split "`n" | Where-Object { $_.Trim() })
    hasListener = ($ss -notmatch 'no listener')
  }
}

function Compare-Facts($b, $a) {
  $items = New-Object System.Collections.Generic.List[object]
  function C([string]$id, $bv, $av, [string]$level, [string]$note) {
    $verdict = 'unknown'
    if ($null -ne $bv -and $null -ne $av) {
      if ($bv -is [array] -or $av -is [array]) {
        $x = @($bv | Sort-Object -Unique); $y = @($av | Sort-Object -Unique)
        $oa = @($x | Where-Object { $y -notcontains $_ }); $ob = @($y | Where-Object { $x -notcontains $_ })
        $verdict = if ($oa.Count -eq 0 -and $ob.Count -eq 0) { 'match' } else { 'mismatch' }
        $note += " symdiff before-only=[$($oa -join ',')] after-only=[$($ob -join ',')]"
      } else { $verdict = if ("$bv" -eq "$av") { 'match' } else { 'mismatch' } }
    }
    $items.Add([pscustomobject]@{ id = $id; before = $bv; after = $av; verdict = $verdict; level = $level; note = $note.Trim() })
  }
  # 我方槽位的**权威**存活判据 = WSL 侧按槽位 pgrep（不依赖"被发现的那个守护是谁"）
  C 'daemon.alive(mine)' (@($b.pgrepPids).Count -gt 0) (@($a.pgrepPids).Count -gt 0) 'hard' "我方槽位 $($b.port) 的守护进程是否存在（pgrep --port $($b.port)）"
  C 'daemon.slotScoped(probe)' $b.status.scopedToSlot $a.status.scopedToSlot 'hard' '真相源是否作用域到我方槽位（False => 下列 probe 值记 unknown，不能当通过）'
  $bp = if ($b.status.scopedToSlot) { $b.status.pid } else { $null }
  $ap = if ($a.status.scopedToSlot) { $a.status.pid } else { $null }
  C 'daemon.pid(probe,scoped)' $bp $ap 'hard' 'probe 读到的守护 pid（仅当作用域命中我方槽位）'
  $bpr = if ($b.status.scopedToSlot) { $b.status.port } else { $null }
  $apr = if ($a.status.scopedToSlot) { $a.status.port } else { $null }
  C 'daemon.port(scoped)' $bpr $apr 'hard' '守护端口（仅当作用域命中我方槽位）'
  $bv = if ($b.status.scopedToSlot) { $b.status.version } else { $null }
  $av = if ($a.status.scopedToSlot) { $a.status.version } else { $null }
  C 'daemon.version(scoped)' $bv $av 'hard' '守护版本（仅当作用域命中我方槽位）'
  C 'daemon.pgrepPids' $b.pgrepPids $a.pgrepPids 'hard' "WSL 侧 pgrep -af 'daemon.ts --port $($b.port)'（按槽位，天然排除其它槽位守护）"
  C 'daemon.keys' @($b.status.keys | ForEach-Object { "$($_.key)@$($_.session)" }) @($a.status.keys | ForEach-Object { "$($_.key)@$($_.session)" }) 'hard' 'keys 集合（key@session）；两侧都空 => 弱证据，需配合 alive/listener'
  C 'listener.port' $b.hasListener $a.hasListener 'hard' "WSL 侧 ss 是否仍监听 $($b.port)"
  C 'keys.runtimePid' @($b.status.keys | ForEach-Object { $_.runtimePid }) @($a.status.keys | ForEach-Object { $_.runtimePid }) 'warn' 'runtimePid 变化允许，但必须记录解释'
  C 'otherSlotDaemons' @($b.otherSlotDaemons) @($a.otherSlotDaemons) 'info' '同发行版里**其它槽位**守护（同队其它测试实例；属主未确认；信息项，不参与判红/判绿）'
  return $items
}

function Exit-Of($items) {
  # 顺序很重要：**真实硬不一致优先判红**，再看"证据不足"的闸门。
  # （教训：把 scoping 闸放在前面，会让"我方守护确实被杀了"退化成 exit 3。）
  if (@($items | Where-Object { $_.verdict -eq 'mismatch' -and $_.level -eq 'hard' }).Count -gt 0) { return 1 }
  $alive = $items | Where-Object { $_.id -eq 'daemon.alive(mine)' }
  if ($alive -and -not $alive.before) { return 3 }   # 我方守护本来就不在跑 => 不可判（绝不当通过）
  $scoped = $items | Where-Object { $_.id -eq 'daemon.slotScoped(probe)' }
  # 只有"两侧都明确 False"才算 probe 值不可用；$null = 字段缺失/未知，不能当成 False
  if ($scoped -and ($scoped.before -eq $false) -and ($scoped.after -eq $false)) { return 3 }
  if (@($items | Where-Object { $_.verdict -eq 'match' -and $_.level -eq 'hard' }).Count -eq 0) { return 3 }
  return 0
}

function Render($items) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($it in $items) {
    $bv = if ($it.before -is [array]) { '[' + ($it.before -join ',') + ']' } else { "$($it.before)" }
    $av = if ($it.after -is [array]) { '[' + ($it.after -join ',') + ']' } else { "$($it.after)" }
    [void]$sb.AppendLine(("{0,-22} {1,-9} {2,-5} before={3}  after={4}" -f $it.id, $it.verdict.ToUpper(), $it.level, $bv, $av))
    if ($it.verdict -ne 'match') { [void]$sb.AppendLine('    note: ' + $it.note) }
  }
  return $sb.ToString()
}

if ($Mode -eq 'SelfTest') {
  # 注意：$pid 是 PowerShell 只读自动变量，参数名不能叫 pid
  $mk = { param($daemonPid, $keys) [pscustomobject]@{ status = [pscustomobject]@{ running = $true; pid = $daemonPid; port = 8932; slot = 8932; version = '0.2.0-rc.2'; keys = $keys; scopedToSlot = $true; unscopedNote = $null }; pgrepPids = @($daemonPid); hasListener = $true; port = 8932; otherSlotDaemons = @() } }
  $k = @([pscustomobject]@{ key = 'k1'; session = 'remote-wsl-k1-aaa'; runtimePid = 100 })
  $b = & $mk 158529 $k
  $same = & $mk 158529 $k
  $killed = & $mk 159999 $k
  $log = New-Object System.Text.StringBuilder
  [void]$log.AppendLine('===== daemon-invariance 自测 =====')
  $ok = $true
  foreach ($c in @(
      @{ n = 'A 完全一致（期望 0）'; a = $same; e = 0 },
      @{ n = 'B 守护被杀（期望 1）'; a = $killed; e = 1 }
    )) {
    $items = Compare-Facts $b $c.a
    $code = Exit-Of $items
    $pass = ($code -eq $c.e); if (-not $pass) { $ok = $false }
    [void]$log.AppendLine("")
    [void]$log.AppendLine("--- $($c.n) => exit=$code (期望 $($c.e)) $(if ($pass) { 'PASS' } else { 'FAIL' })")
    [void]$log.AppendLine((Render $items))
  }
  $o = Join-Path $OutDir 'out-00-selftest-daemon.txt'

  # P) 解析器自测：必须认**实盘格式**（2026-10-12 实测），旧格式/缺字段不得蒙对
  [void]$log.AppendLine("")
  [void]$log.AppendLine("--- P 解析器（实盘文本形状）---")
  $realText = "daemon: pid=750364 actualPort=8932 slot=8932 version=0.2.0-rc.2 cwd=/home/g profile=sdk`nmachine: slot=8932 pid=750364 port=8932 version=0.2.0-rc.2 keys=0 orphans=0`nuptime=153s idleMs=1800000 lingerMs=600000 queueLimit=4`nkeys (0): (none)"
  $notRunText = "daemon: not running（absent: 没有守护元数据（守护未运行））"
  $pr = Parse-Probe $realText; $pn = Parse-Probe $notRunText
  $pChecks = @(
    @{ n = 'running 实盘: pid=750364'; got = $pr.pid; want = 750364 },
    @{ n = 'running 实盘: actualPort=8932 → port'; got = $pr.port; want = 8932 },
    @{ n = 'running 实盘: slot=8932'; got = $pr.slot; want = 8932 },
    @{ n = 'running 实盘: version'; got = $pr.version; want = '0.2.0-rc.2' },
    @{ n = 'running 实盘: running=true'; got = $pr.running; want = $true },
    @{ n = 'not running: running=false'; got = $pn.running; want = $false },
    @{ n = 'not running: pid 必须为空（不许蒙）'; got = $pn.pid; want = $null }
  )
  foreach ($c in $pChecks) {
    $pass = ("$($c.got)" -eq "$($c.want)"); if (-not $pass) { $ok = $false }
    [void]$log.AppendLine(("  {0} => got={1} want={2} {3}" -f $c.n, $c.got, $c.want, $(if ($pass) { 'PASS' } else { 'FAIL' })))
  }

  Set-Content -LiteralPath $o -Value $log.ToString() -Encoding utf8
  Write-Host $log.ToString()
  Write-Host "自测总判：$(if ($ok) { 'PASS' } else { 'FAIL' }) -> $o"
  if (-not $ok) { exit 1 } else { exit 0 }
}

if ($Mode -eq 'Capture') {
  $facts = Capture $Port
  if (-not $Out) { $Out = Join-Path $OutDir 'out-11-daemon-facts.json' }
  ($facts | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $Out -Encoding utf8
  Write-Host "captured -> $Out"
  Write-Host ("  running={0} pid={1} port={2} slot={3} keys={4} pgrepMine=[{5}] listener={6}" -f $facts.status.running, $facts.status.pid, $facts.status.port, $facts.status.slot, @($facts.status.keys).Count, ($facts.pgrepPids -join ','), $facts.hasListener)
  if (@($facts.otherSlotDaemons).Count -gt 0) { Write-Host ("  NOTE: 同发行版还有**其它槽位**守护（同队其它测试实例，属主未确认；未纳入比对）：" + ($facts.otherSlotDaemons -join ', ')) }
  exit 0
}

if ($Mode -eq 'Compare') {
  if (-not $Before -or -not $After) { throw '需要 -Before a.json -After b.json' }
  $b = Get-Content -LiteralPath $Before -Raw | ConvertFrom-Json
  $a = Get-Content -LiteralPath $After -Raw | ConvertFrom-Json
  $items = Compare-Facts $b $a
  $code = Exit-Of $items
  $body = Render $items
  if (-not $OutFile) { $OutFile = Join-Path $OutDir 'out-11-daemon-invariance.json' }
  ([ordered]@{ generatedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); before = $Before; after = $After; exitCode = $code; items = $items } | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $OutFile -Encoding utf8
  Set-Content -LiteralPath ($OutFile -replace '\.json$', '.txt') -Value $body -Encoding utf8
  Write-Host $body
  Write-Host "exit=$code -> $OutFile"
  exit $code
}

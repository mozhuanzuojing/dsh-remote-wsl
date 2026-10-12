#!/usr/bin/env pwsh
# diff-panel-vs-status.ps1 —— 验收③「树上每个数字与 wsl_status 逐项一致（同源，不许两套数）」
#
# 设计要点（反假绿）：
#   1) 映射表驱动，**逐项**比对；未映射项一律 unknown（绝不写通过）。
#   2) 集合类项做**对称差**，不做包含判断。
#   3) 两侧都为空集的 "match" 标 weak=true（0==0 不构成一致证据）；若**只有** weak 项可比 => exit 3。
#   4) -SelfTest 用合成输入证明比较器有区分力（一致=>0、换 distro=>1、改 pid=>1）。
#
# 退出码：0 = 全部可比项一致且非空证据；1 = 存在不一致（红）；3 = 无可比项/只有空集证据（不可判）
[CmdletBinding()]
param(
  [string]$Panel,
  [string]$Status,
  [string]$OutFile,
  [int]$ExpectedSlot = 0,   # >0 时强制"真相源报的守护槽位 = 我方槽位"（实测：停掉我方守护后工具会改报**同队其它槽位**）
  [string]$Snapshot,        # ③ 第三条真相面：route 的 explorer.snapshot JSON（T10 起用于 F33 更严语义判定）
  [switch]$F33StrictSlot,   # 打开 T10 的 F33 语义：snapshot.daemon 只报配置槽位、别槽进 others[]
  [string]$OutDir = $PSScriptRoot,
  [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'

function Parse-Status([string]$text) {
  # 只解析工具输出段：probe 的 stdout 里混有前言（[probe ...]/注册工具/#### 标记）。
  # 取最后一个 "#### ... ####" 标记之后的内容，保证"原始文件自洽（含前言）"与"解析面干净"两不误。
  $marker = [regex]::Matches($text, '(?m)^#{4,}.*#{4,}\s*$')
  if ($marker.Count -gt 0) { $text = $text.Substring($marker[$marker.Count - 1].Index + $marker[$marker.Count - 1].Length) }
  $r = [ordered]@{}
  $r.body = $text.Trim()
  $m = [regex]::Match($text, '(?m)^distros:\s*(.+?)\s*$')
  if ($m.Success) {
    $vals = @($m.Groups[1].Value -split '\s+' | Where-Object { $_ -and $_ -ne '(none)' })
    $r.distros = $vals
  } else { $r.distros = $null }

  # 实盘格式（2026-10-12 实测；以实现实际输出为准）：
  #   running:     `daemon: running pid=750364 actualPort=8932 slot=8932 version=0.2.0-rc.2 uptime=152s idleMs=1800000 lingerMs=600000 keys=0 [(none)]`
  #   not running: `daemon: not running（absent: 没有守护元数据（守护未运行））`
  # 与 2026-10-10 旧样本（`daemon: pid=… port=… version=…`）**不同** —— 解析器只认实测格式（未命中即 unknown，不猜）。
  $m = [regex]::Match($text, '(?m)^daemon:\s*running\s+pid=(\d+)\s+actualPort=(\d+)\s+slot=(\d+)\s+version=(\S+)(.*)$')
  if ($m.Success) {
    $tail = $m.Groups[5].Value
    $keysN = $null; $keyNames = @()
    $mk = [regex]::Match($tail, 'keys=(\d+)\s*\[(.*?)\]\s*$')
    if ($mk.Success) {
      $keysN = [int]$mk.Groups[1].Value
      $inner = $mk.Groups[2].Value.Trim()
      if ($inner -ne '(none)') { $keyNames = @([regex]::Matches($inner, '(?<k>[A-Za-z0-9_.:/@\-]+)\s*\(') | ForEach-Object { $_.Groups['k'].Value }) }
    }
    $r.daemon = [ordered]@{ running = $true; pid = [int]$m.Groups[1].Value; port = [int]$m.Groups[2].Value; slot = [int]$m.Groups[3].Value; version = $m.Groups[4].Value; keysCount = $keysN; keyNames = $keyNames; raw = $m.Value }
  } elseif ($text -match '(?m)^daemon:\s*not running') {
    $r.daemon = [ordered]@{ running = $false; pid = $null; port = $null; slot = $null; version = $null; keysCount = $null; keyNames = @(); raw = 'daemon: not running' }
  } else { $r.daemon = $null }

  $r.keys = $null
  $mk = [regex]::Match($text, '(?m)^keys \((\d+)\):\s*(.+?)\s*$')
  if ($mk.Success) {
    $n = [int]$mk.Groups[1].Value
    $tail = $mk.Groups[2].Value
    $pairs = @([regex]::Matches($tail, '(?<k>[A-Za-z0-9_.:/@\-]+)\s+session=(?<s>\S+)') | ForEach-Object { [pscustomobject]@{ key = $_.Groups['k'].Value; session = $_.Groups['s'].Value } })
    $conf = if ($pairs.Count -eq $n) { 'high' } else { 'low' }
    $r.keys = [ordered]@{ count = $n; pairs = $pairs; confidence = $conf; raw = $tail; sessionsAvailable = $true }
  } elseif ($null -ne $r.daemon -and $null -ne $r.daemon.keysCount) {
    # wsl_status 没有独立 keys 行：key 名内嵌在 `keys=N [k1(turn 2,pidNNN), …]`，**没有 session**
    $pairs = @($r.daemon.keyNames | ForEach-Object { [pscustomobject]@{ key = $_; session = $null } })
    $conf = if ($pairs.Count -eq $r.daemon.keysCount) { 'medium' } else { 'low' }
    $r.keys = [ordered]@{ count = $r.daemon.keysCount; pairs = $pairs; confidence = $conf; raw = $r.daemon.raw; sessionsAvailable = $false }
  }

  # `daemon ports:` 行 —— 与 `daemon:` 行的 actualPort/slot 做**真相源内部一致性**检查（防"工具自己两套数"）
  # 实盘：`daemon ports: configured=8932(+3 回退) actual=8932 slot=8932`（configured 后面带中文后缀，不能只吃非空白）
  $m = [regex]::Match($text, '(?m)^daemon ports:\s*configured=(\d+)[^\n]*?\bactual=(\d+|\(未运行\))(?:\s+slot=(\d+))?')
  if ($m.Success) {
    $r.portsLine = [ordered]@{
      configured = [int]$m.Groups[1].Value
      actual     = if ($m.Groups[2].Value -match '^\d+$') { [int]$m.Groups[2].Value } else { $null }
      slot       = if ($m.Groups[3].Success) { [int]$m.Groups[3].Value } else { $null }
    }
  } else { $r.portsLine = $null }

  $m = [regex]::Match($text, '(?m)^drift:\s*(\S+)')
  $r.drifted = if ($m.Success) { if ($m.Groups[1].Value -match '^(no|none|false)$') { $false } elseif ($m.Groups[1].Value -match '^(yes|true)') { $true } else { $null } } else { $null }
  $m = [regex]::Match($text, '(?m)^desktop dsh version:\s*(\S+)')
  $r.desktopVersion = if ($m.Success) { $m.Groups[1].Value } else { $null }
  $m = [regex]::Match($text, '(?m)^wsl pin:\s*(\S+)')
  $r.pin = if ($m.Success) { $m.Groups[1].Value } else { $null }

  $r.webHosts = $null
  $m = [regex]::Match($text, '(?m)^web hosts:\s*(.+?)\s*$')
  if ($m.Success) {
    $line = $m.Groups[1].Value
    if ($line -match '^\(none\)') { $r.webHosts = @() }
    else {
      $ports = @([regex]::Matches($line, ':(\d{2,5})') | ForEach-Object { [int]$_.Groups[1].Value } | Sort-Object -Unique)
      if ($ports.Count -gt 0) { $r.webHosts = $ports } else { $r.webHosts = $null }  # 格式不认识 => unknown
    }
  }

  # 防漏项：把 wsl_status 里**没被本比较器映射**的行列出来 —— 这些字段若面板也显示而没进比对，就是漏项
  $mappedPat = @('^distros:', '^daemon:', '^daemon ports:', '^keys \(', '^drift:', '^desktop dsh version:', '^wsl pin:', '^web hosts:')
  $r.allLines = @($text -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $r.unmappedLines = @($r.allLines | Where-Object { $l = $_; -not ($mappedPat | Where-Object { $l -match $_ }) })
  return [pscustomobject]$r
}

function Set-Diff($a, $b) {
  if ($null -eq $a -or $null -eq $b) { return $null }
  $x = @($a | Sort-Object -Unique); $y = @($b | Sort-Object -Unique)
  $onlyA = @($x | Where-Object { $y -notcontains $_ })
  $onlyB = @($y | Where-Object { $x -notcontains $_ })
  return [pscustomobject]@{ onlyPanel = $onlyA; onlyStatus = $onlyB; equal = ($onlyA.Count -eq 0 -and $onlyB.Count -eq 0) }
}

# As-Arr —— 关键防线：区分「不可用」（null / 全 null 的数组）与「真的是空集」（@()）。
# 教训：`@($null | ForEach-Object { $_.port })` 得到 @($null)，经 Sort-Object 后 $null 被**静默丢弃**，
# 于是"面板抽不到"看起来和"面板显示为空"完全一样 => 会判成 MATCH（假绿）。必须在这里挡住。
function As-Arr($v) {
  if ($null -eq $v) { return $null }
  $orig = @($v)
  $vals = @($orig | Where-Object { $null -ne $_ -and "$_" -ne '' })
  if ($vals.Count -eq 0 -and $orig.Count -gt 0) { return $null }   # 全是 null/空 => 不可用
  return , $vals   # 逗号返回：保住"真空集 @()"（否则会被 PS 展开成 $null，弱证据就丢了）
}

function Test-F33Scope($st, $snapObj, [int]$expectedSlot) {
  # T10 / F32+F33 判定口径（lead 2026-10-12 预备通知）：
  #   · snapshot.daemon **只报配置槽位**（无守护 ⇒ running:false，**不回落 live[0]**）；别槽进 **others[]**（加法字段）
  #   · wsl_status 的 daemon 行仍走 daemonStatus()/live[0]（任何槽位）
  #   ⇒ 唯一允许的差异场景 =「配置槽位无守护、别处有守护」：status 报别槽、snapshot 报 running:false 且别槽在 others[]
  #      —— 这是**更严**行为（F33 目的），判 pass；其余场景仍要求逐项一致。
  $items = New-Object System.Collections.Generic.List[object]
  $mk = { param($id, $pv, $sv, $verdict, $note) [pscustomobject]@{ id = $id; panel = $pv; status = $sv; verdict = $verdict; weak = $false; note = $note } }
  if ($null -eq $snapObj) { $items.Add((& $mk 'f33.snapshot-scope' 'snapshot 缺失' $null 'unknown' '未提供 route snapshot JSON ⇒ F33 口径不可判（不得当通过）')); return $items }
  $snapD = $null
  # 兼容两种落盘形状：① route 原始响应 `{ok,result}`；② 我自己的封装 `{capturedAt,status,bodyJson:{ok,result}}`
  # （T10 自查发现的 harness 缺陷：只认 ① 时，喂封装文件会判「形状不符 ⇒ unknown」，把 F33 判成不可判。）
  $root = $snapObj
  if ($null -ne $snapObj.bodyJson) { $root = $snapObj.bodyJson }
  try { $snapD = $root.result.daemon } catch { }
  if ($null -eq $snapD) { $items.Add((& $mk 'f33.snapshot-scope' 'snapshot 无 result.daemon' $null 'unknown' 'JSON 形状不符 ⇒ 不可判')); return $items }
  $others = @()
  if ($snapD.PSObject.Properties.Name -contains 'others') { $others = @($snapD.others) }
  $otherSlots = @($others | ForEach-Object { if ($_.PSObject.Properties.Name -contains 'slot') { $_.slot } elseif ($_.PSObject.Properties.Name -contains 'port') { $_.port } else { $null } } | Where-Object { $null -ne $_ })
  $statusSlot = if ($null -ne $st.daemon) { $st.daemon.slot } else { $null }
  $snapRunning = [bool]$snapD.running
  $snapSlot = if ($snapD.PSObject.Properties.Name -contains 'slot') { $snapD.slot } else { $null }
  $items.Add((& $mk 'f33.snapshot.daemon.running' 'snapshot.daemon.running' $snapRunning 'match' 'snapshot 只报配置槽位'))
  $items.Add((& $mk 'f33.snapshot.others' 'others[] slots' $otherSlots 'match' '加法字段：别槽守护清单'))
  if ($expectedSlot -le 0) { $items.Add((& $mk 'f33.snapshot-scope' '需 -ExpectedSlot' $null 'unknown' '未给配置槽位 ⇒ 不可判')); return $items }
  if ($statusSlot -eq $expectedSlot) {
    $ok = ($snapRunning -and "$snapSlot" -eq "$expectedSlot")
    $items.Add((& $mk 'f33.snapshot-scope' "snapshot running=$snapRunning slot=$snapSlot" "status slot=$statusSlot" $(if ($ok) { 'match' } else { 'mismatch' }) 'status 与 snapshot 都指向配置槽位 ⇒ 必须一致且 running'))
  } else {
    $ok = ((-not $snapRunning) -and ($otherSlots -contains $statusSlot))
    $items.Add((& $mk 'f33.snapshot-scope' "snapshot running=$snapRunning others=[$($otherSlots -join ',')]" "status slot=$statusSlot（≠配置槽 $expectedSlot）" $(if ($ok) { 'match' } else { 'mismatch' }) 'F33 更严语义：配置槽位无守护 ⇒ snapshot 报 running=false，且 status 报的那个别槽必须出现在 others[]'))
  }
  return $items
}

function Compare-Core($panel, $st, $snapObj = $null) {
  $items = New-Object System.Collections.Generic.List[object]
  function Add-Item([string]$id, $pv, $sv, [string]$note) {
    $verdict = 'unknown'
    $weak = $false
    # 归一：数组侧先过 As-Arr，把「不可用（null/全 null）」与「真空集（@()）」分开
    if ($null -eq $pv -or $pv -is [array]) { $pv = As-Arr $pv }
    if ($null -eq $sv -or $sv -is [array]) { $sv = As-Arr $sv }
    if ($null -ne $pv -and $null -ne $sv) {
      if ($pv -is [array] -or $sv -is [array]) {
        $d = Set-Diff $pv $sv
        if ($null -eq $d) { $verdict = 'unknown' } else {
          $verdict = if ($d.equal) { 'match' } else { 'mismatch' }
          if ($d.equal -and @($pv).Count -eq 0) { $weak = $true }
          $note = ($note + " symdiff panel-only=[$($d.onlyPanel -join ',')] status-only=[$($d.onlyStatus -join ',')]").Trim()
        }
      } else {
        $verdict = if ("$pv" -eq "$sv") { 'match' } else { 'mismatch' }
        if ("$pv" -eq '') { $weak = $true }
      }
    }
    $items.Add([pscustomobject]@{ id = $id; panel = $pv; status = $sv; verdict = $verdict; weak = $weak; note = $note })
  }

  $pRows = @($panel.rows)
  # rows=null 表示"抽取器没认出树结构" => unknown，绝不能用空数组冒充"面板显示为空"（否则会造出假红/假绿）
  $pDistros = if ($null -eq $panel.rows) { $null } else { @($pRows | Where-Object { $_.kind -eq 'distro' } | ForEach-Object { $_.name }) }
  Add-Item 'distros' $pDistros $st.distros '集合对称差必须为空'

  $f33Items = @()
  if ($F33StrictSlot) { $f33Items = @(Test-F33Scope $st $snapObj $ExpectedSlot) }
  $f33Scope = $f33Items | Where-Object { $_.id -eq 'f33.snapshot-scope' }

  $sb = $panel.statusBar
  if ($null -ne $sb) {
    $sd = $st.daemon
    if ($null -ne $sd) {
      $emit = $true
      $sdPid = $sd.pid; $sdPort = $sd.port; $sdVer = $sd.version
      if ($ExpectedSlot -gt 0) {
        $slotOk = ($null -ne $sd.slot -and $sd.slot -eq $ExpectedSlot)
        # ⚠️ 必须带 `-not $slotOk`：只有"status 报的确实**不是**我方槽位"时才走 F33 更严分支。
        # （T10 自查：漏了这个条件 ⇒ 正常场景里 daemon.pid/port/version 被静默跳过，③ 的核心比对丢项。）
        if ($F33StrictSlot -and $f33Scope -and $f33Scope.verdict -eq 'match' -and -not $slotOk) {
          # T10：配置槽位无守护而 status 报别槽 —— F33 更严语义下的**正确**行为，不判红、也判不出"一致"（不适用）
          Add-Item 'status.daemon.slot.expected' $sd.slot $ExpectedSlot 'F33 更严语义：配置槽位无守护 ⇒ snapshot 报 running=false、status 报的别槽在 others[] 内（已由 f33.snapshot-scope 判定为正确）；本项不适用'
          $items[$items.Count - 1].verdict = 'unknown'
          $emit = $false
        } else {
          Add-Item 'status.daemon.slot.expected' $sd.slot $ExpectedSlot "真相源报的守护槽位必须是**我方**槽位 $ExpectedSlot；实测停掉我方守护后 probe 立刻改报**同队其它槽位**（8912 ∈ T2 端口段 8911–8920 / 8731 插件默认口；属主未确认）—— 不设此闸，pid/port 会被非本方槽位的守护带跑"
          if (-not $slotOk) {
            $emit = $false
            Add-Item 'daemon.pid' $sb.pid $null '真相源报的是**非本方**槽位 => daemon.* 判 unknown（不得当通过）；需先让本方槽位守护起来'
            Add-Item 'daemon.port' $sb.port $null '同上'
            Add-Item 'daemon.version' $sb.version $null '同上'
          }
        }
      }
      if ($emit) {
        Add-Item 'daemon.pid' $sb.pid $sdPid '守护进程 pid（面板状态条 vs wsl_status daemon 行）'
        Add-Item 'daemon.port' $sb.port $sdPort '守护端口'
        Add-Item 'daemon.version' $sb.version $sdVer '守护版本'
      }
    } else {
      Add-Item 'daemon.*' 'present' $null 'wsl_status 的 daemon 行无法解析 => unknown'
    }
    if ($null -ne $st.keys) {
      $pk = @($sb.keysDetail | ForEach-Object { if ($_.key) { $_.key } else { $_ } })
      Add-Item 'daemon.keys' $pk @($st.keys.pairs | ForEach-Object { $_.key }) 'key 名集合（session 见 note）'
      Add-Item 'daemon.keys.count' $sb.keys $st.keys.count '计数'
      if ($st.keys.confidence -eq 'low') { $items[$items.Count - 1].verdict = 'unknown'; $items[$items.Count - 1].note += ' ｜ status 侧 keys 解析置信度低 => unknown' }
    } else {
      Add-Item 'daemon.keys' $null $null 'wsl_status 无 keys 行（守护未运行 / 无 key）=> unknown'
    }
    if ($null -ne $sb.drift) {
      Add-Item 'drift.drifted' $sb.drift.drifted $st.drifted 'drift 布尔'
      Add-Item 'drift.desktop' $sb.drift.desktop $st.desktopVersion '桌面版本'
      Add-Item 'drift.pin' $sb.drift.pin $st.pin 'WSL pin'
    } else {
      Add-Item 'drift' $null $null '面板未给出 drift 明细 => unknown'
    }
  } else {
    Add-Item 'panel.statusBar' $null $null '面板抽取结果缺 statusBar（DOM 契约未知/面板未渲染）=> unknown'
  }

  Add-Item 'webHosts.ports' @($panel.webHosts | ForEach-Object { $_.port }) $st.webHosts 'web host 端口集合（status 行格式未知时 => unknown）'

  # 真相源内部一致性：`daemon:` 行的 actualPort 与 `daemon ports:` 行的 actual 必须相同（两侧都来自 wsl_status）
  if ($null -ne $st.daemon -and $null -ne $st.portsLine) {
    Add-Item 'status.internal.port' $st.daemon.port $st.portsLine.actual '两条 status 行互相印证（daemon: actualPort vs daemon ports: actual）；不一致 = 工具自己两套数'
    Add-Item 'status.internal.slot' $st.daemon.slot $st.portsLine.slot '槽位一致性'
  }

  $paths = if ($null -eq $panel.rows) { $null } else { @($pRows | Where-Object { $_.kind -eq 'workspace' } | ForEach-Object { $_.path }) }
  Add-Item 'workspaces.paths' $paths $null 'wsl_status 无收藏路径来源（来自插件 explorer.json）=> 恒为 unknown，禁止写成通过'

  foreach ($fi in $f33Items) { $items.Add($fi) }
  return $items
}

function Summarize($items) {
  $m = @($items | Where-Object { $_.verdict -eq 'match' })
  $x = @($items | Where-Object { $_.verdict -eq 'mismatch' })
  $u = @($items | Where-Object { $_.verdict -eq 'unknown' })
  $strong = @($m | Where-Object { -not $_.weak })
  return [pscustomobject]@{ match = $m.Count; mismatch = $x.Count; unknown = $u.Count; strongMatch = $strong.Count }
}

function Exit-Of($sum) {
  if ($sum.mismatch -gt 0) { return 1 }
  if ($sum.strongMatch -eq 0) { return 3 }
  return 0
}

function Render($items, $sum) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine('id'.PadRight(24) + 'verdict'.PadRight(11) + 'panel  |  status')
  foreach ($it in $items) {
    $pv = if ($it.panel -is [array]) { '[' + ($it.panel -join ',') + ']' } else { "$($it.panel)" }
    $sv = if ($it.status -is [array]) { '[' + ($it.status -join ',') + ']' } else { "$($it.status)" }
    $mark = switch ($it.verdict) { 'match' { if ($it.weak) { 'MATCH(weak)' } else { 'MATCH' } } 'mismatch' { 'MISMATCH' } default { 'unknown' } }
    [void]$sb.AppendLine($it.id.PadRight(24) + $mark.PadRight(11) + "$pv  |  $sv")
    if ($it.verdict -ne 'match' -or $it.weak) { [void]$sb.AppendLine('    ' + ' '.PadRight(22) + 'note: ' + $it.note) }
  }
  [void]$sb.AppendLine("summary: match=$($sum.match) (strong=$($sum.strongMatch)) mismatch=$($sum.mismatch) unknown=$($sum.unknown)")
  return $sb.ToString()
}

# ---------------- SelfTest ----------------
if ($SelfTest) {
  $statusGood = @'
distros: debian-u8-1 Ubuntu-22.04
target: debian-u8-1  wslHome=/home/g  cwd=/home/g
desktop dsh version: 0.2.0-rc.2
wsl pin: 0.2.0-rc.2
drift: no
daemon: running pid=158529 actualPort=8932 slot=8932 version=0.2.0-rc.2 uptime=152s idleMs=1800000 lingerMs=600000 keys=2 [k1(turn 2,pid161640), k2(turn 1,pid161641)]
daemon idle/linger/queue: idleMs=1800000（到期回收运行时 ⇒ 上下文丢失）/ lingerMs=600000（无 key 且无客户端持续这么久 ⇒ 守护自退）/ queueLimit=4（同 key 并发 FIFO，超出明确拒绝）
daemon ports: configured=8932(+3 回退) actual=8932 slot=8932
web hosts: 127.0.0.1:3082 -> http://127.0.0.1:3082/
'@
  $panelGood = @'
{ "capturedAt":"synthetic","activeSidebarId":"remote-wsl",
  "rows":[{"kind":"distro","name":"debian-u8-1"},{"kind":"distro","name":"Ubuntu-22.04"},{"kind":"workspace","path":"/home/g/x"}],
  "statusBar":{"pid":158529,"port":8932,"version":"0.2.0-rc.2","keys":2,"keysDetail":[{"key":"k1"},{"key":"k2"}],"drift":{"drifted":false,"desktop":"0.2.0-rc.2","pin":"0.2.0-rc.2"}},
  "webHosts":[{"port":3082}] }
'@
  $panelBadDistro = $panelGood.Replace('"name":"Ubuntu-22.04"', '"name":"Ubuntu-99.99"')
  $panelBadPid = $panelGood.Replace('"pid":158529', '"pid":111111')
  # D：面板侧**根本抽不到**（rows/statusBar/webHosts 全 null）而 status 是空守护 —— 必须 exit 3，绝不能 0
  $panelMissing = '{ "capturedAt":"synthetic","rows":null,"statusBar":null,"webHosts":null }'
  $statusEmpty = @'
distros: debian-u8-1
daemon: not running（absent: 没有守护元数据（守护未运行））
web hosts: (none)
'@

  # F/G：T10 的 F33 语义（snapshot.daemon 只报配置槽位；别槽进 others[]）
  $statusOtherSlot = @'
distros: debian-u8-1
desktop dsh version: 0.2.0-rc.2
wsl pin: 0.2.0-rc.2
drift: no
daemon: running pid=111111 actualPort=8962 slot=8962 version=0.2.0-rc.2 uptime=5s idleMs=1800000 lingerMs=600000 keys=0 [(none)]
daemon ports: configured=8932(+3 回退) actual=8962 slot=8962
web hosts: (none)
'@
  $panelNotRunning = @'
{ "capturedAt":"synthetic",
  "rows":[{"kind":"distro","name":"debian-u8-1"}],
  "statusBar":{"line":"daemon 未运行（配置槽位 8932）","pid":null,"port":null,"version":null,"keys":null,"keysDetail":[],"drift":null},
  "webHosts":[] }
'@
  $snapF33Ok = '{ "ok":true,"result":{ "daemon":{ "running":false, "others":[{"slot":8962,"pid":111111,"version":"0.2.0-rc.2"}] } } }'
  $snapF33Bad = '{ "ok":true,"result":{ "daemon":{ "running":true, "slot":8962, "pid":111111, "version":"0.2.0-rc.2", "others":[] } } }'
  # F33 **正常**场景（配置槽位就是有守护的那个）——用于 E2 完整性检查
  $snapF33Normal = '{ "ok":true,"result":{ "daemon":{ "running":true, "slot":8932, "pid":158529, "port":8932, "version":"0.2.0-rc.2", "keys":[], "orphans":0, "others":[] } } }'

  $log = New-Object System.Text.StringBuilder
  [void]$log.AppendLine('===== diff-panel-vs-status 自测（比较器区分力）=====')
  $ok = $true
  $cases = @(
    @{ name = 'A 一致（期望 exit 0）'; panel = $panelGood; status = $statusGood; expect = 0 },
    @{ name = 'B 换掉一个 distro（期望 exit 1）'; panel = $panelBadDistro; status = $statusGood; expect = 1 },
    @{ name = 'C 改 pid（期望 exit 1）'; panel = $panelBadPid; status = $statusGood; expect = 1 },
    @{ name = 'D 面板侧抽不到（全 null）vs 空守护（期望 exit 3，绝不能 0）'; panel = $panelMissing; status = $statusEmpty; expect = 3 },
    @{ name = 'F F33 更严语义成立（配置槽无守护+别槽在 others[]，期望 exit 0）'; panel = $panelNotRunning; status = $statusOtherSlot; snap = $snapF33Ok; f33 = $true; slot = 8932; expect = 0 },
    @{ name = 'G F33 被违反（snapshot 把别槽当自己报 running=true，期望 exit 1）'; panel = $panelNotRunning; status = $statusOtherSlot; snap = $snapF33Bad; f33 = $true; slot = 8932; expect = 1 }
  )
  foreach ($c in $cases) {
    $p = $c.panel | ConvertFrom-Json
    $s = Parse-Status $c.status
    $snapObj = if ($c.ContainsKey('snap')) { $c.snap | ConvertFrom-Json } else { $null }
    $prevF33 = $F33StrictSlot; $prevSlot = $ExpectedSlot
    $F33StrictSlot = [bool]($c.ContainsKey('f33') -and $c.f33)
    $ExpectedSlot = if ($c.ContainsKey('slot')) { [int]$c.slot } else { 0 }
    $items = Compare-Core $p $s $snapObj
    $F33StrictSlot = $prevF33; $ExpectedSlot = $prevSlot
    $sum = Summarize $items
    $code = Exit-Of $sum
    $pass = ($code -eq $c.expect)
    if (-not $pass) { $ok = $false }
    [void]$log.AppendLine("")
    [void]$log.AppendLine("--- $($c.name) => exit=$code (期望 $($c.expect)) $([string]::Concat($(if ($pass) {'PASS'} else {'FAIL'})))")
    [void]$log.AppendLine((Render $items $sum))
  }
  $out = Join-Path $OutDir 'out-00-selftest-diff.txt'

  # E) 映射完整性：逐项映射**不许静默丢失**（防止某个正则不匹配 -> 该项根本没进比对 -> 假绿）
  $required = @('distros', 'daemon.pid', 'daemon.port', 'daemon.version', 'daemon.keys', 'daemon.keys.count', 'drift.drifted', 'drift.desktop', 'drift.pin', 'webHosts.ports', 'workspaces.paths', 'status.internal.port', 'status.internal.slot')
  $ids = @((Compare-Core ($panelGood | ConvertFrom-Json) (Parse-Status $statusGood)) | ForEach-Object { $_.id })
  $missing = @($required | Where-Object { $ids -notcontains $_ })
  [void]$log.AppendLine("")
  [void]$log.AppendLine("--- E 映射完整性（期望全部在场）---")
  [void]$log.AppendLine("  实际 id: $($ids -join ', ')")
  if ($missing.Count -gt 0) { $ok = $false; [void]$log.AppendLine("  MISSING: $($missing -join ', ')  <== FAIL（映射静默丢失）") }
  else { [void]$log.AppendLine("  全部在场 PASS") }

  # E2) F33 **正常**场景也必须有 daemon.pid/port/version（T10 自查：F33 分支曾把这三项静默跳过）
  $prevF33b = $F33StrictSlot; $prevSlotb = $ExpectedSlot
  $F33StrictSlot = $true; $ExpectedSlot = 8932
  $idsF33Normal = @((Compare-Core ($panelGood | ConvertFrom-Json) (Parse-Status $statusGood) ($snapF33Normal | ConvertFrom-Json)) | ForEach-Object { $_.id })
  $F33StrictSlot = $prevF33b; $ExpectedSlot = $prevSlotb
  $needF33 = @('daemon.pid', 'daemon.port', 'daemon.version', 'f33.snapshot-scope')
  $missF33 = @($needF33 | Where-Object { $idsF33Normal -notcontains $_ })
  [void]$log.AppendLine("")
  [void]$log.AppendLine("--- E2 F33 正常场景不得丢项（期望 daemon.pid/port/version + f33.snapshot-scope 全在场）---")
  [void]$log.AppendLine("  实际: $($idsF33Normal -join ', ')")
  if ($missF33.Count -gt 0) { $ok = $false; [void]$log.AppendLine("  MISSING: $($missF33 -join ', ')  <== FAIL") }
  else { [void]$log.AppendLine("  全部在场 PASS") }

  Set-Content -LiteralPath $out -Value $log.ToString() -Encoding utf8
  Write-Host $log.ToString()
  Write-Host "自测总判：$(if ($ok) { 'PASS（比较器有区分力 + 映射无丢失）' } else { 'FAIL' })  -> $out"
  if (-not $ok) { exit 1 } else { exit 0 }
}

# ---------------- 实盘 ----------------
if (-not $Panel -or -not $Status) { throw "需要 -Panel <extract.json> -Status <wsl_status.txt>（或用 -SelfTest）" }
$panelObj = Get-Content -LiteralPath $Panel -Raw | ConvertFrom-Json
$statusText = Get-Content -LiteralPath $Status -Raw
$st = Parse-Status $statusText
$snapObj = $null
if ($Snapshot) {
  if (Test-Path -LiteralPath $Snapshot) { try { $snapObj = (Get-Content -LiteralPath $Snapshot -Raw | ConvertFrom-Json) } catch { Write-Host "WARN: snapshot JSON 解析失败：$($_.Exception.Message)" } }
  else { Write-Host "WARN: -Snapshot 指定的文件不存在：$Snapshot" }
}
if ($F33StrictSlot -and $null -eq $snapObj) { Write-Host 'WARN: 开了 -F33StrictSlot 但没有可用 snapshot ⇒ f33.* 项将记 unknown（不得当通过）' }
$items = Compare-Core $panelObj $st $snapObj
$sum = Summarize $items
$body = Render $items $sum
$code = Exit-Of $sum

if (-not $OutFile) { $OutFile = Join-Path $OutDir 'out-10-diff-panel-vs-status.json' }
$payload = [ordered]@{
  generatedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
  panelFile = $Panel; statusFile = $Status; expectedSlot = $ExpectedSlot
  summary = $sum; exitCode = $code
  items = $items
  unknowns = @($items | Where-Object { $_.verdict -eq 'unknown' } | ForEach-Object { $_.id })
  statusUnmappedLines = $st.unmappedLines
}
($payload | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $OutFile -Encoding utf8
Set-Content -LiteralPath ($OutFile -replace '\.json$', '.txt') -Value $body -Encoding utf8
Write-Host $body
Write-Host "--- wsl_status 里未被本比较器映射的行（防漏项；面板若显示同名字段而没进比对 => 必须补映射或记 unknown）---"
foreach ($l in $st.unmappedLines) { Write-Host "  | $l" }
Write-Host "exit=$code  -> $OutFile"
exit $code

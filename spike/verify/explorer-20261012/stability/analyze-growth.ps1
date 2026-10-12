#!/usr/bin/env pwsh
# analyze-growth.ps1 —— 测项①（长跑净增长）与②（请求堆积）的**独立复算器**。
#
# 为什么单独一个脚本：判定必须是"净增长/无泄漏"这种**可复算**结论。报告里的结论必须能由
# 原始读数（probe 的 status() JSON）+ 本脚本原样重放得到，不依赖人眼。
#
# 用法：
#   ./analyze-growth.ps1 -SelfTest                          # 量具校准（强制红 A1）
#   ./analyze-growth.ps1 -Cycles out-10-cycle-samples.json  # 真实数据
#   ./analyze-growth.ps1 -Cycles <in> -Out out-11-growth-analysis.json
#
# 输入形态：window.__dsrw_cycle__.status() 的 JSON（含 warmupSamples / cycles / target / mode）。
# 判据（**预登记**，写在代码里，看数前不许改）：
#   计数类指标（domAll / listenersOutstanding / timersOutstanding / apiInFlight）：
#     net   = 末值 - 首值
#     slope = 最小二乘斜率（对轮次 1..N）
#     CI    = slope ± t(0.975, N-2) * SE
#     leak    ⇔ (slope > 0.5 且 CI 下界 > 0) 或 net > max(3, 1% * 首值)
#     no-leak ⇔ |slope| ≤ 0.5 且 CI 含 0 且 |net| ≤ max(3, 1% * 首值)
#     watch   ⇔ 其它（既没到 leak 也没到 no-leak）
#     shrink  ⇔ slope < -0.5（负增长；不是泄漏，但要记录，可能是懒初始化）
#     unknown ⇔ 有效样本 < 5，或结构有效性不足（mounted/unmounted 未成对）
#   timers 全零 ⇒ 该指标为 'structural-zero'（client 无定时器时它**不是证据**，不许当"无泄漏"）
#   heapUsed ⇒ 永远 'advisory'（无强制 GC，不得单独据此判 leak/无 leak）
# 退出码：0 = 全部 no-leak/pass；1 = 出现 leak；2 = 出现 unknown/watch；3 = 自测失败/输入不可用。
[CmdletBinding()]
param(
  [string]$Cycles,
  [string]$Out,
  [switch]$SelfTest,
  [double]$SlopeLeakThreshold = 0.5,
  [int]$MinSamples = 5
)
$ErrorActionPreference = 'Stop'

# ---------- 最小二乘 + t 分布（df 1..30 的 95% 双尾 t） ----------
$script:T95 = @{ 1=12.706; 2=4.303; 3=3.182; 4=2.776; 5=2.571; 6=2.447; 7=2.365; 8=2.306; 9=2.262; 10=2.228;
  11=2.201; 12=2.179; 13=2.160; 14=2.145; 15=2.131; 16=2.120; 17=2.110; 18=2.101; 19=2.093; 20=2.086;
  21=2.080; 22=2.074; 23=2.069; 24=2.064; 25=2.060; 26=2.056; 27=2.052; 28=2.048; 29=2.045; 30=2.042 }
function Get-T95([int]$df) {
  if ($df -le 0) { return 12.706 }
  if ($df -gt 30) { return 1.96 }
  return $script:T95[$df]
}
function Get-Trend {
  param([double[]]$Y)
  $n = $Y.Count
  if ($n -lt 2) { return [pscustomobject]@{ n=$n; slope=$null; intercept=$null; seSlope=$null; ciLow=$null; ciHigh=$null; net=$null; mean=$null } }
  $xs = 1..$n | ForEach-Object { [double]$_ }
  $mx = ($xs | Measure-Object -Average).Average
  $my = ($Y | Measure-Object -Average).Average
  $sxx = 0.0; $sxy = 0.0
  for ($i = 0; $i -lt $n; $i++) { $dx = $xs[$i] - $mx; $sxx += $dx * $dx; $sxy += $dx * ($Y[$i] - $my) }
  $slope = if ($sxx -eq 0) { 0.0 } else { $sxy / $sxx }
  $intercept = $my - $slope * $mx
  $ss = 0.0
  for ($i = 0; $i -lt $n; $i++) { $r = $Y[$i] - ($intercept + $slope * $xs[$i]); $ss += $r * $r }
  $df = $n - 2
  $se = if ($df -le 0 -or $sxx -eq 0) { $null } else { [math]::Sqrt(($ss / $df) / $sxx) }
  $t = Get-T95 $df
  return [pscustomobject]@{
    n = $n; slope = [math]::Round($slope, 4); intercept = [math]::Round($intercept, 3)
    seSlope = if ($null -eq $se) { $null } else { [math]::Round($se, 4) }
    ciLow = if ($null -eq $se) { $null } else { [math]::Round($slope - $t * $se, 4) }
    ciHigh = if ($null -eq $se) { $null } else { [math]::Round($slope + $t * $se, 4) }
    net = [math]::Round($Y[$n - 1] - $Y[0], 3)
    mean = [math]::Round($my, 3)
  }
}
function Get-Verdict {
  param([string]$Metric, [double[]]$Y, [int]$MinSamples, [double]$SlopeLeakThreshold)
  $trend = Get-Trend $Y
  $isZeroSeries = (($Y | Where-Object { $_ -ne 0 }).Count -eq 0)
  $tol = [math]::Max(3.0, [math]::Abs($trend.mean) * 0.01)
  $verdict = 'unknown'; $why = ''
  if ($Metric -eq 'heapUsed') { return [pscustomobject]@{ metric=$Metric; verdict='advisory'; why='无强制 GC ⇒ 只作旁证，不参与 leak/no-leak 判定'; trend=$trend; tol=$tol; series=$Y } }
  if ($Metric -eq 'timersOutstanding' -and $isZeroSeries) { return [pscustomobject]@{ metric=$Metric; verdict='structural-zero'; why='全零序列：client 半无定时器 ⇒ 该指标不构成证据（正面证据要另找）'; trend=$trend; tol=$tol; series=$Y } }
  if ($trend.n -lt $MinSamples) { return [pscustomobject]@{ metric=$Metric; verdict='unknown'; why="有效样本 $($trend.n) < $MinSamples"; trend=$trend; tol=$tol; series=$Y } }
  $slopeLeak = ($trend.slope -gt $SlopeLeakThreshold) -and ($null -ne $trend.ciLow) -and ($trend.ciLow -gt 0)
  $netLeak = ([math]::Abs($trend.net) -gt $tol)
  if ($slopeLeak -or $netLeak) { $verdict = 'leak'; $why = if ($slopeLeak) { "slope=$($trend.slope) > $SlopeLeakThreshold 且 CI 下界 $($trend.ciLow) > 0" } else { "net=$($trend.net) > tol=$tol" } }
  elseif ($trend.slope -lt (-1 * $SlopeLeakThreshold)) { $verdict = 'shrink'; $why = "slope=$($trend.slope) < -$SlopeLeakThreshold（负增长，非泄漏；需解释）" }
  elseif ([math]::Abs($trend.slope) -le $SlopeLeakThreshold -and ($null -eq $trend.ciLow -or ($trend.ciLow -le 0 -and $trend.ciHigh -ge 0)) -and ([math]::Abs($trend.net) -le $tol)) {
    $verdict = 'no-leak'; $why = "|slope|=$([math]::Abs($trend.slope)) ≤ $SlopeLeakThreshold 且 CI 含 0 且 |net|=$([math]::Abs($trend.net)) ≤ tol=$tol"
  }
  else { $verdict = 'watch'; $why = "灰色带：slope=$($trend.slope) net=$($trend.net) tol=$tol" }
  return [pscustomobject]@{ metric=$Metric; verdict=$verdict; why=$why; trend=$trend; tol=$tol; series=$Y }
}
function Get-Sequences {
  param($Status)
  $rows = @()
  foreach ($c in @($Status.cycles)) {
    if ($null -eq $c) { continue }
    $am = $c.afterMount; $au = $c.afterUnmount
    $rows += [pscustomobject]@{
      i = $c.i
      mounted = [bool]$c.steps.mounted
      unmounted = [bool]$c.steps.unmounted
      mountTransitionsDelta = $c.steps.mountTransitionsDelta
      mountWaitMs = $c.steps.mountWaitMs
      unmountWaitMs = $c.steps.unmountWaitMs
      domAll = if ($au) { [double]$au.domAll } else { $null }
      panelNodesAfterUnmount = if ($au) { [double]$au.panelNodes } else { $null }
      listenersOutstanding = if ($au) { [double]$au.listenersOutstanding } else { $null }
      timersOutstanding = if ($au) { [double]$au.timersOutstanding } else { $null }
      apiInFlight = if ($au) { [double]$au.apiInFlight } else { $null }
      heapUsed = if ($au -and $null -ne $au.heapUsed) { [double]$au.heapUsed } else { $null }
      preTextLen = if ($au) { [double]$au.preTextLen } else { $null }
      domAllAfterMount = if ($am) { [double]$am.domAll } else { $null }
      panelNodesAfterMount = if ($am) { [double]$am.panelNodes } else { $null }
      rowsAfterMount = if ($am) { [double]$am.rows } else { $null }
    }
  }
  return , $rows
}
function Invoke-Analysis {
  param($Status, [int]$MinSamples, [double]$SlopeLeakThreshold)
  $rows = Get-Sequences $Status
  $valid = @($rows | Where-Object { $_.mounted -and ($_.unmounted -or $Status.mode -eq 'switch-only') -and $null -ne $_.domAll })
  # ★ 仪表健康闸门（S5）：包装失败的类，其零值**不是证据** ⇒ 该指标强制 unknown。
  #   读不到 health（旧 payload / 合成输入）时不施加此闸门，但会打印提示。
  $health = $Status.instrumentHealth
  $healthNotes = @()
  $metricHealth = @{ listenersOutstanding = $null; timersOutstanding = $null; apiInFlight = $null; domAll = $null; heapUsed = $null }
  if ($null -ne $health) {
    $metricHealth.listenersOutstanding = $health.listeners
    $metricHealth.timersOutstanding = $health.timers
    $metricHealth.apiInFlight = $health.fetch
    $metricHealth.domAll = $health.listeners -and $health.fetch
  } else {
    $healthNotes += 'payload 无 instrumentHealth（旧口径或合成输入）⇒ 未施加"仪表健康"闸门，读数可信度需人工确认'
  }
  $metrics = @{}
  $series = @{}
  foreach ($m in @('domAll','listenersOutstanding','timersOutstanding','apiInFlight','heapUsed')) {
    $vals = @($valid | ForEach-Object { $_.$m } | Where-Object { $null -ne $_ })
    if ($vals.Count -ge 2) {
      $series[$m] = $vals
      if ($metricHealth[$m] -eq $false) {
        $metrics[$m] = [pscustomobject]@{ metric=$m; verdict='unknown'; why='仪表层该类包装失败（health=false）⇒ 零值不是证据，必须判 unknown'; trend=(Get-Trend ([double[]]$vals)); tol=$null; series=$vals }
      } else {
        $metrics[$m] = Get-Verdict -Metric $m -Y ([double[]]$vals) -MinSamples $MinSamples -SlopeLeakThreshold $SlopeLeakThreshold
      }
    } else {
      $metrics[$m] = [pscustomobject]@{ metric=$m; verdict='unknown'; why="有效读数 $($vals.Count) < 2"; trend=$null; tol=$null; series=@() }
      $series[$m] = @()
    }
  }
  # 结构有效性：每轮必须有 mount 事件（unmount 事件只在 mount-unmount 模式要求）
  $structOk = $true; $structWhy = @()
  if ($valid.Count -lt 2) { $structOk = $false; $structWhy += "有效轮次 $($valid.Count) < 2" }
  if ($Status.mode -eq 'switch-only') { $structWhy += 'mode=switch-only（面板 keep-alive，未发生卸载）⇒ ① 的口径是"切换 N 次"，不是挂载/卸载' }
  # 探针 oneCycle 只记录"切走"那一次 transition ⇒ 期望 1/轮（mount-unmount 模式）
  $badTransitions = @($valid | Where-Object { $null -ne $_.mountTransitionsDelta -and $_.mountTransitionsDelta -ne 1 -and $Status.mode -eq 'mount-unmount' })
  if ($badTransitions.Count -gt 0) { $structWhy += "有 $($badTransitions.Count) 轮的 mountTransitionsDelta ≠ 1（切走未产生卸载事件 ⇒ 观察器或卸载行为异常）" }
  $verdicts = @($metrics.Values | Where-Object { $_.verdict -in @('leak','watch','unknown') })
  $overall = if ($metrics.Values | Where-Object { $_.verdict -eq 'leak' }) { 'LEAK' }
    elseif ($verdicts.Count -gt 0) { 'UNRESOLVED' }
    else { 'NO-LEAK' }
  return [pscustomobject]@{
    schema = 'dsrw-growth/1'
    analyzedAt = (Get-Date -Format 'o')
    source = $Status.schema
    mode = $Status.mode
    target = $Status.target
    instrumentHealth = $health
    healthNotes = $healthNotes
    cyclesTotal = @($rows).Count
    cyclesValid = $valid.Count
    structural = [pscustomobject]@{ ok = $structOk; notes = $structWhy }
    metrics = $metrics
    series = $series
    overall = $overall
  }
}

# ---------- 自测（强制红 A1：三组合成序列） ----------
if ($SelfTest) {
  $mk = {
    param([double[]]$domAll, [double[]]$listeners, [double[]]$timers, [double[]]$inflight)
    $cycles = @()
    for ($i = 0; $i -lt $domAll.Count; $i++) {
      $cycles += [pscustomobject]@{
        i = $i + 1
        steps = [pscustomobject]@{ mounted = $true; unmounted = $true; mountTransitionsDelta = 2; mountWaitMs = 20; unmountWaitMs = 20 }
        afterMount = [pscustomobject]@{ domAll = $domAll[$i]; panelNodes = 100; listenersOutstanding = $listeners[$i]; timersOutstanding = $timers[$i]; apiInFlight = 0; heapUsed = 1000000; preTextLen = 100 }
        afterUnmount = [pscustomobject]@{ domAll = $domAll[$i]; panelNodes = 0; listenersOutstanding = $listeners[$i]; timersOutstanding = $timers[$i]; apiInFlight = $inflight[$i]; heapUsed = 1000000; preTextLen = 0 }
      }
    }
    return [pscustomobject]@{ schema='dsrw-cycle/1'; mode='mount-unmount'; target=[pscustomobject]@{cycles=$domAll.Count}; cycles=$cycles }
  }
  $n = 20
  $flat = & $mk -domAll (@(1..$n | ForEach-Object { 1000.0 })) -listeners (@(1..$n | ForEach-Object { 30.0 })) -timers (@(1..$n | ForEach-Object { 0.0 })) -inflight (@(1..$n | ForEach-Object { 0.0 }))
  $leak = & $mk -domAll (@(1..$n | ForEach-Object { 1000.0 + $_ * 0.0 })) -listeners (@(1..$n | ForEach-Object { 30.0 + $_ })) -timers (@(1..$n | ForEach-Object { 0.0 + $_ })) -inflight (@(1..$n | ForEach-Object { 0.0 }))
  $saw = & $mk -domAll (@(1..$n | ForEach-Object { 1000.0 + ($_ % 2) * 4 })) -listeners (@(1..$n | ForEach-Object { 30.0 + ($_ % 2) * 2 })) -timers (@(1..$n | ForEach-Object { 0.0 })) -inflight (@(1..$n | ForEach-Object { 0.0 }))
  $cases = @(
    [pscustomobject]@{ name='flat'; status=$flat; expectListeners='no-leak'; expectTimers='structural-zero' }
    [pscustomobject]@{ name='leak-+1/cycle'; status=$leak; expectListeners='leak'; expectTimers='leak' }
    [pscustomobject]@{ name='sawtooth'; status=$saw; expectListeners='no-leak'; expectTimers='structural-zero' }
  )
  $fail = 0
  $lines = @()
  foreach ($c in $cases) {
    $r = Invoke-Analysis -Status $c.status -MinSamples $MinSamples -SlopeLeakThreshold $SlopeLeakThreshold
    $gotL = $r.metrics.listenersOutstanding.verdict
    $gotT = $r.metrics.timersOutstanding.verdict
    $okL = $gotL -eq $c.expectListeners
    $okT = $gotT -eq $c.expectTimers
    if (-not ($okL -and $okT)) { $fail++ }
    $lines += ("[{0}] {1}: listeners={2}(期望 {3}) timers={4}(期望 {5}) overall={6}" -f ($(if ($okL -and $okT) { 'PASS' } else { 'FAIL' })), $c.name, $gotL, $c.expectListeners, $gotT, $c.expectTimers, $r.overall)
  }
  $hdr = "analyze-growth 自测（强制红 A1）：$($cases.Count - $fail)/$($cases.Count) PASS"
  $hdr
  $lines
  if ($Out) { @($hdr) + $lines | Set-Content -LiteralPath $Out -Encoding utf8 }
  exit $(if ($fail -gt 0) { 3 } else { 0 })
}

# ---------- 真实数据 ----------
if (-not $Cycles) { Write-Host "需要 -Cycles <file> 或 -SelfTest"; exit 3 }
if (-not (Test-Path -LiteralPath $Cycles)) { Write-Host "找不到输入：$Cycles"; exit 3 }
try { $status = Get-Content -LiteralPath $Cycles -Raw | ConvertFrom-Json } catch { Write-Host "输入不是合法 JSON：$Cycles"; exit 3 }
# /collect 包装：{receivedAt,name,data:{...status...}} ⇒ 解包（S9）
if ($null -ne $status.data -and $null -eq $status.cycles) { Write-Host "（检测到 /collect 包装，解包 .data）"; $status = $status.data }
$res = Invoke-Analysis -Status $status -MinSamples $MinSamples -SlopeLeakThreshold $SlopeLeakThreshold

$txt = New-Object System.Collections.Generic.List[string]
$txt.Add("analyze-growth  —  输入=$Cycles  overall=$($res.overall)  mode=$($res.mode)  有效轮次=$($res.cyclesValid)/$($res.cyclesTotal)")
foreach ($m in @('domAll','listenersOutstanding','timersOutstanding','apiInFlight','heapUsed')) {
  $v = $res.metrics.$m
  if ($null -eq $v) { continue }
  $t = $v.trend
  $txt.Add(("  {0,-20} verdict={1,-16} slope={2} ci=[{3},{4}] net={5} tol={6}" -f $m, $v.verdict, $t.slope, $t.ciLow, $t.ciHigh, $t.net, $v.tol))
  $txt.Add(("      why: {0}" -f $v.why))
  $txt.Add(("      series: {0}" -f (($v.series | ForEach-Object { $_ }) -join ',')))
}
foreach ($n in $res.structural.notes) { $txt.Add("  结构提示: $n") }
foreach ($n in $res.healthNotes) { $txt.Add("  仪表提示: $n") }
if ($null -ne $res.instrumentHealth) { $txt.Add(("  仪表健康: listeners={0} timers={1} fetch={2}" -f $res.instrumentHealth.listeners, $res.instrumentHealth.timers, $res.instrumentHealth.fetch)) }
$txt | ForEach-Object { Write-Host $_ }

# 先算判定退出码，再落盘 —— 且**落盘失败绝不允许改变判定**。
# （2026-10-12 自查抓到的自身缺陷：原来 $ErrorActionPreference='Stop' 下，<Out>.txt 被调用方
#  `*>` 占住时 Set-Content 会**终止脚本**，于是一个 overall=NO-LEAK 的运行会返回 exit 1 = "LEAK"。
#  量具能反转自己的判定 ⇒ 必须修：写盘包 try/catch，判定只由 $res.overall 决定。）
$code = switch ($res.overall) { 'NO-LEAK' { 0 } 'LEAK' { 1 } default { 2 } }
try {
  if ($Out) {
    $res | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Out -Encoding utf8
    $txtPath = [System.IO.Path]::ChangeExtension($Out, '.txt')
    $txt | Set-Content -LiteralPath $txtPath -Encoding utf8
  }
} catch {
  Write-Host "警告：结果落盘失败（**不影响**判定）：$($_.Exception.Message)"
}
Write-Host ("VERDICT={0} exit={1}" -f $res.overall, $code)
exit $code

#!/usr/bin/env pwsh
# boot-iso-host.ps1 —— 用**孤立 DSH_HOME** 起测试宿主（T26 硬要求）。
#
# 为什么：host 的 `workspaceRegistry.create()` 会写**全局** `$DSH_HOME/storages/workspace.json`。
# 绝不能污染用户的 `~/.dsh/storages/workspace.json`（T24 曾误加 2 条）。
# 本脚本把 DSH_HOME 指到 `%TEMP%\a1-home`（+ Junction 建 profile），因此注册表落在孤立目录里。
#
# 用法：./boot-iso-host.ps1 -Port 8931 -DaemonPort 8932 [-Tag a1] [-HomeName a1-home]
param(
  [int]$Port = 8931,
  [int]$DaemonPort = 8932,
  [string]$Tag = 'a1',
  [string]$HomeName = 'a1-home',
  [string]$ProfileName = 'a1iso',
  [string]$Vendor = 'D:\project\dsh1\vendor\dsh-remote-wsl'
)

# ── T73：默认**孤立** DSH_HOME（-UseUserHome 才用真实 home）＋ 用户全局 workspace.json 前后 sha 对照 ──
$script:T73Ws = Join-Path $env:USERPROFILE '.dsh\storages\workspace.json'
$script:T73ShaBefore = if (Test-Path $script:T73Ws) { (Get-FileHash $script:T73Ws -Algorithm SHA256).Hash } else { '<none>' }
Write-Host "[T73] 本脚本自带隔离，DSH_HOME=$env:DSH_HOME；sha(前)=$($script:T73ShaBefore.Substring(0,[Math]::Min(16,$script:T73ShaBefore.Length)))"
$ErrorActionPreference = 'Stop'
$d = $PSScriptRoot
$vendor = $Vendor
$home2 = Join-Path $env:TEMP $HomeName
$profDir = Join-Path $home2 "profiles\$ProfileName"
New-Item -ItemType Directory -Path (Join-Path $profDir 'node_modules') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $home2 'storages') -Force | Out-Null
$link = Join-Path $profDir 'node_modules\dsh-remote-wsl'
if (Test-Path $link) { Remove-Item $link -Force -Recurse }
New-Item -ItemType Junction -Path $link -Target $vendor | Out-Null
$pkg = [ordered]@{
  name = "dsh-profile-$ProfileName"; private = $true
  dependencies = [ordered]@{ 'dsh-remote-wsl' = ('link:' + ($vendor -replace '\\', '/')) }
  dsh = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remote-wsl') } }
}
($pkg | ConvertTo-Json -Depth 6) | Set-Content (Join-Path $profDir 'package.json') -Encoding utf8
"[]" | Set-Content (Join-Path $profDir 'cordis.yml') -Encoding utf8
"- id: remote-wsl`n  config:`n    distro: debian-u8-1`n    dshVersion: ''`n    daemonPort: $DaemonPort`n" | Set-Content (Join-Path $profDir 'cordis.patch.yml') -Encoding utf8
$dsh = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$saved = @{}
foreach ($n in @('DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL')) {
  if (Test-Path "env:$n") { $saved[$n] = (Get-Item "env:$n").Value; Remove-Item "env:$n" -ErrorAction SilentlyContinue }
}
$oldHome = $env:DSH_HOME
$env:DSH_HOME = $home2
try {
  $log = Join-Path $d "out-121-$Tag.log"
  $p = Start-Process -FilePath $dsh -ArgumentList @('--profile', $ProfileName, '--port', "$Port", '--no-open') -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  Write-Host ("  [iso] DSH_HOME=$home2  host cmd pid=$($p.Id)  log=$log")
} finally {
  foreach ($k in $saved.Keys) { Set-Item "env:$k" $saved[$k] }
  if ($oldHome) { $env:DSH_HOME = $oldHome } else { Remove-Item env:DSH_HOME -ErrorAction SilentlyContinue }
}
$p.Id | Set-Content (Join-Path $d "out-121-$Tag.pid") -Encoding utf8
# 等就绪（GET 需要 Origin，否则 403/401；这里只探 TCP + token 页）
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 800
  try {
    $tok = [regex]::Match((Get-Content (Join-Path $d "out-121-$Tag.log") -Raw -ErrorAction SilentlyContinue), '\?token=([A-Za-z0-9_\-]+)').Groups[1].Value
    if ($tok) {
      $r = Invoke-WebRequest "http://127.0.0.1:$Port/?token=$tok" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { Write-Host "  [iso] ready=True token=$tok"; Set-Content (Join-Path $d "out-121-$Tag.token") $tok; break }
    }
  } catch { }
}
# ── T73 断言：用户全局 workspace.json 前后 sha 相同 ──
$script:T73ShaAfter = if (Test-Path $script:T73Ws) { (Get-FileHash $script:T73Ws -Algorithm SHA256).Hash } else { '<none>' }
if ($script:T73ShaAfter -ne $script:T73ShaBefore) { Write-Host "[T73] 失败：用户全局 workspace.json 被改写（$($script:T73ShaBefore) -> $($script:T73ShaAfter)）"; exit 9 }
Write-Host "[T73] 用户全局 workspace.json sha 前后相同 = True"
return $p.Id

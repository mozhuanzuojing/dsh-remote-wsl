#!/usr/bin/env pwsh
# run-e2e.ps1 —— 用 **headless agent + 真 write/read/edit 工具** 验证 WSL fs provider（2026-10-23）。
#
# 为什么不是单元探针：probe-fs-wsl 直接调 provider 方法，证明的是"provider 会写 WSL"；
# 本脚本要证明的是"**DSH 的工具**真的走了这个 provider"—— 所以起一个隔离 profile，把宿主
# `fs-sandbox` 关掉、把本插件的 `src/fs-provider.ts` 作为唯一的 `fs` 服务挂上，再让 headless
# agent 用 write/read/edit 操作 /tmp 下的文件，最后用 `wsl.exe` 从发行版内独立复核。
#
# 前置：MAGPIE_GATEWAY_KEY 可用（从 ~/.dsh/.env 复制到隔离 home）；会真实消耗模型额度。
# 用法：pwsh -File run-e2e.ps1
# 产物：out-e2e-write-read.jsonl / out-e2e-edit.jsonl（本次运行的 --json 事件）
[CmdletBinding()]
param(
  [string]$Home0 = (Join-Path $env:TEMP 'rwlife-e2e-home'),
  [string]$Profile = 'e2e',
  [string]$Distro = 'debian-u8-1',
  [string]$Repo = 'D:\project\dsh1\dsh-remote-wsl',
  [string]$DshCmd = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
  [string]$OutDir = $PSScriptRoot,
  [string]$Model = 'auto/deepseek-v4.1-flash'
)
$ErrorActionPreference = 'Stop'
$profDir = Join-Path (Join-Path $Home0 'profiles') $Profile

# 1) 从 shipped headless 模板造隔离 profile（幂等）
$env:DSH_HOME = $Home0
& $DshCmd --profile $Profile --from-default-profile headless --dump-config *> $null
if ($LASTEXITCODE -ne 0) { throw "创建 profile 失败（exit $LASTEXITCODE）" }

# 2) 凭据（只读复制，不打印）
Copy-Item (Join-Path $env:USERPROFILE '.dsh\.env') (Join-Path $Home0 '.env') -Force
Copy-Item (Join-Path $env:USERPROFILE '.dsh\.credentials.yaml') (Join-Path $Home0 '.credentials.yaml') -Force

# 3) patch：关宿主 fs-sandbox，挂本插件 provider（唯一 fs 服务）
$patch = @"
- id: agent-default-model
  config:
    provider: magpie
    model: $Model
    reasoningEffort: max
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      magpie:
        displayName: Magpie
        apiKeyEnv: MAGPIE_GATEWAY_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:3425/v1
        models:
          - id: $Model
            name: DeepSeek V4.1 Flash · routing group
            contextWindow: 1048576
            maxTokens: 384000
            input: [text, image]
            reasoningEfforts:
              low: low
              high: high
              max: max
- id: fs-sandbox
  disabled: true
- id: tool-fs-search
  disabled: true
- insert:
    - id: fs-wsl
      name: '$($Repo -replace '\\','/')/src/fs-provider.ts'
      config:
        distro: $Distro
        wslHome: /home/g
        cwd: /home/g
        daemonPort: 8731
    - id: search-wsl
      name: '$($Repo -replace '\\','/')/src/search-tool.ts'
      config:
        distro: $Distro
        wslHome: /home/g
        cwd: /home/g
        daemonPort: 8731
"@
Set-Content -LiteralPath (Join-Path $profDir 'cordis.patch.yml') -Value $patch -Encoding utf8
$env:DSH_HOME = $Home0
& $DshCmd --profile $Profile --dump-config 2>&1 | Select-String -Pattern 'fs-wsl|disabled: true' | Select-Object -First 3 | ForEach-Object { $_.Line.Trim() }

$root = "/tmp/dsh-fs-e2e-$([DateTimeOffset]::Now.ToUnixTimeSeconds())"
# 4) write + read
$task1 = "用 write 工具把 $root/e2e.txt 写成 hello-e2e；再用 read 工具读回。只许 write/read 工具，不许 shell。"
$log1 = Join-Path $OutDir 'out-e2e-write-read.jsonl'
& $DshCmd --profile $Profile --json $task1 *>&1 | Tee-Object -FilePath $log1 | Out-Null
$okWrite = (Select-String -Path $log1 -Pattern '"tool":"write"' -Quiet) -and (Select-String -Path $log1 -Pattern '"tool":"read"' -Quiet)
"write/read 工具事件：$okWrite"

# 5) edit + read
$task2 = "用 edit 工具把 $root/e2e.txt 里的 hello-e2e 改成 hello-edited；再用 read 读回。只许 edit/read 工具，不许 shell。"
$log2 = Join-Path $OutDir 'out-e2e-edit.jsonl'
& $DshCmd --profile $Profile --json $task2 *>&1 | Tee-Object -FilePath $log2 | Out-Null
$okEdit = (Select-String -Path $log2 -Pattern '"tool":"edit"' -Quiet)

# 5b) WSL 内搜索：grep + glob（模型面工具，执行在发行版里）
$task3 = "用 grep 工具在 $root 里搜 hello-edited（path=$root, pattern=hello-edited）；再用 glob 工具列出 $root 下的 *.txt。只许 grep/glob 工具，不许 shell。"
$log3 = Join-Path $OutDir 'out-e2e-search.jsonl'
& $DshCmd --profile $Profile --json $task3 *>&1 | Tee-Object -FilePath $log3 | Out-Null
$okGrep = Select-String -Path $log3 -Pattern '"tool":"grep"' -Quiet
$okGlob = Select-String -Path $log3 -Pattern '"tool":"glob"' -Quiet
"search 工具事件：grep=$okGrep glob=$okGlob"

# 6) WSL 内独立复核
$content = (wsl.exe -d $Distro --exec bash -c "cat $root/e2e.txt" 2>$null) -join "`n"
$stat = (wsl.exe -d $Distro --exec bash -c "stat -c '%a:%U:%d' $root/e2e.txt" 2>$null) -join ''
$mntDev = (wsl.exe -d $Distro --exec bash -c "stat -c '%d' /mnt/d" 2>$null) -join ''
$dev = ($stat -split ':')[2]
"内容=$($content.Trim()) mode/owner/dev=$stat  /mnt/d=$mntDev"
$okContent = $content.Trim() -eq 'hello-edited'
$okExt4 = $dev -ne $mntDev

Remove-Item -LiteralPath $root -Force -ErrorAction SilentlyContinue
# 隔离 home 里复制过真凭据：跑完必须删掉（只删复制品，不动 ~/.dsh 原件）
foreach ($secret in @('.env', '.credentials.yaml')) {
  $copy = Join-Path $Home0 $secret
  if (Test-Path -LiteralPath $copy) { Remove-Item -LiteralPath $copy -Force }
}
$result = [ordered]@{
  generatedAt = (Get-Date).ToString('o')
  profile = $Profile; home = $Home0; distro = $Distro; model = $Model
  toolEvents = [ordered]@{ write = (Select-String -Path $log1 -Pattern '"tool":"write"' -Quiet); read = (Select-String -Path $log1 -Pattern '"tool":"read"' -Quiet); edit = $okEdit; grep = $okGrep; glob = $okGlob }
  file = [ordered]@{ content = $content.Trim(); stat = $stat; mntDDevice = $mntDev }
  verdict = [ordered]@{ contentOk = $okContent; ext4 = $okExt4; ok = ($okWrite -and $okEdit -and $okContent -and $okExt4 -and $okGrep -and $okGlob) }
}
$result | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $OutDir 'out-e2e-agent.json') -Encoding utf8
if (-not $result.verdict.ok) { exit 1 }
exit 0

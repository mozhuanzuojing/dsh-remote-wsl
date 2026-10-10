#!/usr/bin/env pwsh
# verify/verify-shellenv.ps1 —— 独立验证 README §6.4「bash -lc 会落到 zsh」是否成立，
# 以及它对已交付 lib/shell-env.js（用 bash -lc 'export -p' 取环境）的真实影响。
#
# 只读：不修改 lib/、不改任何 dotfile；唯一的外部写入是 WSL /tmp 里的 glob 探针（本脚本不建文件）。
[CmdletBinding()]
param(
  [string]$Distro = 'debian-u8-1',
  [string]$NodeExe = 'C:\Users\l\AppData\Local\mise\shims\node.exe'
)
$ErrorActionPreference = 'Stop'
$VerifyDir = $PSScriptRoot
$PluginDir = Split-Path (Split-Path $VerifyDir -Parent) -Parent
# 2026-10-10：插件被重构成 `lib/` → `src/` 且该模块变成 `.ts`（spike 侧 probe-shellenv.ts 的 import 已同步）。
# 这里只用于打印"被验模块存在性"；真正取片段走 probe-shellenv.ts 自己的 import。
$ShellEnvModule = Join-Path $PluginDir 'src\shell-env.ts'
$Probe = Join-Path $VerifyDir 'probe-shellenv.ts'

function Say($m) { Write-Host $m }

Say '== A. 真跑已交付的 shell-env 模块（probe-shellenv.ts，不手抄片段）=='
Say "   module = $ShellEnvModule (exists=$(Test-Path -LiteralPath $ShellEnvModule))"
$gen = & $NodeExe $Probe 2>&1
$genText = ($gen | ForEach-Object { "$_" }) -join "`n"
$json = $genText | ConvertFrom-Json
$snippet = $json.snippet
Say "   snippet_len=$($json.len) disabled_len=$($json.disabledLen) enable_default_is_on=$($json.len -gt 0)"
$b64snip = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($snippet))

$bashTpl = @'
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
echo "== B. 登录链身份（谁在解释命令）=="
echo "inherited_SHELL=[$SHELL]"
printf 'env_minus_SHELL__bash_lc_SHELL=[%s]\n' "$(env -u SHELL bash -lc 'printf %s "$SHELL"')"
printf 'bash_lc_dollar0=[%s]\n' "$(bash -lc 'printf %s "$0"')"
printf 'bash_lc_ps_comm=[%s]\n' "$(bash -lc 'ps -o comm= -p $$')"
printf 'bash_lc_BASH_VERSION=[%s]\n' "$(bash -lc 'printf %s "$BASH_VERSION"')"
printf 'bash_lc_zsh_VERSION=[%s]\n' "$(bash -lc 'printf %s "${ZSH_VERSION-<unset>}"')"
echo "== C. export -p 的形态（shell-env.js 的 grep 只认 declare -x / export ）=="
echo "declare_x_lines=$(bash -lc 'export -p' 2>/dev/null | grep -cE '^declare -x ')"
echo "typeset_x_lines=$(bash -lc 'export -p' 2>/dev/null | grep -cE '^typeset -x ')"
echo "plain_export_lines=$(bash -lc 'export -p' 2>/dev/null | grep -cE '^export ')"
echo "snippet_filter_lines=$(timeout 5 bash -lc 'unset BASH_ENV ENV PROMPT_COMMAND PS1 PS2 _ PATH
export -n SHELLOPTS BASHOPTS 2>/dev/null
export -p' 2>/dev/null | grep -E '^(declare -x |export )' | wc -l)"
echo "== D. dotfile 里有没有 zsh 切换 =="
grep -n zsh "$HOME/.profile" "$HOME/.bashrc" 2>/dev/null || echo "(no 'zsh' in ~/.profile ~/.bashrc)"
ls -la "$HOME/.bash_profile" "$HOME/.bash_login" 2>&1 | sed 's/^/  /'
echo "== E/F. 把 lib/shell-env.js 的片段原样 eval（生产同款路径）=="
echo "BEFORE_DISPLAY=[${DISPLAY-<unset>}] BEFORE_LANG=[${LANG-<unset>}] BEFORE_DBUS=[${DBUS_SESSION_BUS_ADDRESS-<unset>}]"
eval "$(echo __SNIPB64__ | base64 -d)"
echo "AFTER_DISPLAY=[${DISPLAY-<unset>}] AFTER_LANG=[${LANG-<unset>}] AFTER_DBUS=[${DBUS_SESSION_BUS_ADDRESS-<unset>}]"
echo "== G. glob 假 0 检验：bash -lc 下存在/不存在的 glob =="
echo "login_glob_etc_hosts=$(bash -lc 'ls -1 /etc/hos* 2>/dev/null | wc -l')"
echo "login_glob_absent_rc=$(bash -lc 'ls -1 /tmp/nope-verify-abc-* >/dev/null 2>&1; echo $?')"
echo "login_glob_absent_wc=$(bash -lc 'ls -1 /tmp/nope-verify-abc-* 2>/dev/null | wc -l')"
echo "nonlogin_glob_absent_rc=$(bash -c 'ls -1 /tmp/nope-verify-abc-* >/dev/null 2>&1; echo $?')"
echo "== H. 收尾（本步骤不常驻任何东西）=="
echo "profile_sdk_procs=$(pgrep -f -- 'profile sd[k]' | wc -l)"
'@
$bash = $bashTpl.Replace('__SNIPB64__', $b64snip)
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bash))
$outFile = Join-Path $VerifyDir 'out-shellenv.txt'
$res = & wsl.exe -d $Distro -u g -- bash -c "echo $b64 | base64 -d | bash" 2>&1
$res | ForEach-Object { "$_" } | Tee-Object -FilePath $outFile
Say ''
Say "== 原始输出已存: $outFile =="

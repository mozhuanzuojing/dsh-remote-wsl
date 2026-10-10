/**
 * dsh-remote-wsl / shell-env —— 两块「向 WSL 侧读环境/读配置」的纯逻辑。
 *
 * 为什么单独成文件：这两个函数一个是**纯字符串生成**、一个是**纯函数**，都不碰 ctx、不 spawn、
 * 不写文件 ⇒ 可以脱离 Cordis 宿主直接单测（JS 侧喂样例，WSL 侧真跑片段）。
 *
 * 硬约定（照 lib/index.js）：只用 `node:` 内置模块 / 相对导入；**不 import 任何 `@deepseek-ai/*`**
 * ——link 装进 profile 的插件解析不到裸包名，import 了就 `failed to import`（2026-10-10 实测）。
 *
 * @module dsh-remote-wsl/shell-env
 */

/**
 * 生成「注入登录 shell 环境」的 bash 片段（对位 VS Code `remote.WSL.useShellEnvironment`）。
 *
 * 背景：插件是用 `wsl.exe -d <distro> -- bash <脚本>` 起的**非登录** shell，用户的 `~/.profile`
 * 不参与 ⇒ 里面自定的 env 进不来、`~/.local/bin` 也不在 PATH 里（实测 2026-10-10 同一发行版：
 * 非登录 shell `command -v mise` ⇒ not found；登录 shell ⇒ `/home/g/.local/bin/mise`）。
 * 本片段就地在**当前进程里**取登录 shell 的 `export -p` 并 eval，等价于 useShellEnvironment。
 *
 * 安全（为什么片段里看不见任何 env 值）：`export -p` 的输出只走**管道 + 内存变量**，
 * 全程不落盘 ⇒ 调用方写在 `/tmp` 的脚本文件里没有任何 env 值/密钥；片段本身也不会把值打印出来。
 *
 * 调用顺序由调用方保证：**本片段必须在调用方自己设 PATH/代理之前**。本片段刻意不碰 PATH
 * （登录 PATH 里混着 Windows 路径与 WSL 的默认 PATH，覆盖掉会打破调用方自己的顺序），
 * 所以注入后 `command -v mise` 不会因此变化——要 mise 请照 lib/index.js 的 shellPreamble 自己补 PATH。
 *
 * 边界（说清而不是假装覆盖）：固定用 `bash -lc` 取环境（插件的脚本本来就是 bash 起的），
 * 因此只覆盖 `~/.bash_profile` / `~/.bash_login` / `~/.profile` 这条 bash 启动链；把环境写在
 * `~/.zshrc` 之类**非 bash** 启动文件里的用户拿不到——要覆盖那类用户，得改成"按用户默认 shell 取"。
 *
 * @param {{ enable?: boolean }} [options] `enable === false` 时返回空串（显式关）；缺省/undefined
 *   视为开——对位 VS Code 的默认 true（`!1!==get(...)`）。
 * @returns {string} 可直接拼进脚本的 bash 片段（末尾带换行）；关掉时是 `''`。
 */
export function shellEnvSnippet({ enable } = {}) {
  if (enable === false) return '';
  return `# ── 登录 shell 环境注入（对位 VS Code remote.WSL.useShellEnvironment，默认 true）──────
# 做法：在**当前进程内** eval 登录 shell 的 export -p，等价于 useShellEnvironment。
# 安全：export -p 的文本只经管道 + 内存变量，**全程不落盘** ⇒ 本脚本文件里没有任何 env 值。
# 顺序：必须在调用方设 PATH/代理**之前**（本片段刻意不碰 PATH）。
if SHELL_ENV_INJECT="$(timeout 5 bash -lc 'unset BASH_ENV ENV PROMPT_COMMAND PS1 PS2 _ PATH
export -n SHELLOPTS BASHOPTS 2>/dev/null
for v in $(compgen -v); do case "$v" in *_PROMPT_COMMAND) unset "$v";; esac; done
export -p' 2>/dev/null | grep -E '^(declare -x |export )' | grep -v -E '^(declare -x |export )(BASH_ENV|ENV|PROMPT_COMMAND|PS1|PS2|SHELLOPTS|BASHOPTS|_|PATH|[A-Za-z_][A-Za-z0-9_]*_PROMPT_COMMAND)=' 2>/dev/null)" && [ -n "$SHELL_ENV_INJECT" ]; then
  # 两道过滤，各自负责一件事：
  #  1) 子 shell 里先 unset / export -n —— 那些值根本不出登录 shell（PS1 之类可能含敏感内容）；
  #     SHELLOPTS/BASHOPTS 是 readonly（unset 必然失败），只能靠 export -n 摘掉"导出位"；
  #  2) 这里再按**名字**文本过滤一遍 —— 硬保证，且"过滤了谁"在文本上可审计。
  #     必须有这一道：变量 _ 是上一条命令的残留，bash 会在每条命令前重写它，单靠子 shell 的 unset 兜不住。
  # 前面那道 grep -E 只留声明行：用户的 profile 常会 echo 横幅/motd，那些行既会让 eval 报语法错
  # （于是明明取到了环境却报"失败"），又等于把 profile 的任意 stdout 送进 eval —— 只留 "declare -x "
  # 或 "export " 开头的行，两个问题一起解决（顺带兼容 POSIX 模式下 export -p 的 "export NAME=" 形态）。
  # 为什么不设 PATH：见函数注释（登录 PATH 会盖掉调用方自己的顺序，且混着 /mnt/c 的 Windows 路径）。
  if eval "$SHELL_ENV_INJECT" 2>/dev/null; then
    echo "remote-wsl: 已注入登录 shell 环境" >&2
  else
    echo "remote-wsl: 登录 shell 环境注入失败，沿用默认环境" >&2
  fi
else
  # 登录 shell 起不来 / 超时（timeout 5 ⇒ 124）/ 输出为空：静默失败，脚本照常继续
  echo "remote-wsl: 登录 shell 环境注入失败，沿用默认环境" >&2
fi
unset -v SHELL_ENV_INJECT
`;
}

/**
 * 读 WSL2 的 `localhostForwarding`（本机 127.0.0.1 端口转发开关）。
 * 对位 VS Code 侧：bundle 读 `WslConfigs.localhostForwarding` 再决定连接方式（GAP-AUDIT §8 第 8 项）。
 *
 * ## 优先级：`.wslconfig [wsl2]` 先，`/etc/wsl.conf [network]` 只作回退 —— 依据（2026-10-10 查证）
 *
 * 1. **官方文档只把这个键写在 .wslconfig 里**：Microsoft Learn《Advanced settings configuration in WSL》
 *    的 `.wslconfig` `[wsl2]` 表列了 `localhostForwarding`（boolean，默认 `true`；示例注释还写明
 *    `networkingMode=mirrored` 时该设置被忽略）；而 `wsl.conf` 的 `[network]` 表只有
 *    `generateHosts` / `generateResolvConf` / `hostname`。
 * 2. **本机 WSL 3.0.3.0 的二进制里也是同一个结论**（比文档更硬）：
 *    `wsl.conf` 的键表由 Linux 侧 init 解析 —— 发行版的 `/init` 与 `wsl --system` 的 `/init` md5 相同
 *    （`09e2be19c008d75a6bba821d9f04dfd3`），把它的可打印串抽出来，得到完整键表
 *    `network.generateHosts` / `network.generateResolvConf` / `network.hostname`（外加 automount/interop/
 *    boot/gpu/user/fileServer/oobe/shortcut/windowsterminal 各键）——**整个 /init 里没有
 *    `localhostForwarding` 这个串**；该串只出现在 Windows 侧的 .wslconfig 键表里
 *    （libwsl.dll ← `src/windows/libwsl/WslCoreConfigInterface.cpp`：`wsl2.localhostForwarding`）。
 *    上游源码同结论：`src/linux/init/WslDistributionConfig.cpp` 的键表里没有该键。
 *    ⇒ 现版本下写在 wsl.conf 里的该键是**惰性**的，WSL 根本不读它。
 * 3. 所以"wsl.conf（发行版）> .wslconfig（全局）"这个方向**在这个键上不成立**：真正被消费的只有
 *    .wslconfig。若让 wsl.conf 反压 .wslconfig，就会出现"用户已在 .wslconfig 关掉转发、我们却报 true"
 *    ⇒ 调用方静默失败（正是 §8 要修的那类 bug）。取向：宁可保守（未知/关），不可乐观（开）。
 *    **翻转条件**：将来 WSL 给 wsl.conf 加上该键（判据：`/init` 里出现 `network.localhostForwarding`，
 *    或文档 `[network]` 表出现它），届时应把优先级反过来 —— 那时 per-distro 才是作用域更窄、更该赢的一侧。
 *
 * 返回的 `source` 是**出处**、不是"生效保证"：`source:'wsl.conf'` 只说明值来自发行版配置，
 * 在当前 WSL 上它可能并不生效（见上第 2 条）。
 *
 * ## 语法（照 WSL 自己的 INI 解析器 `src/shared/configfile/configfile.cpp` 核过，2026-10-10）
 * - 段名/键名**大小写不敏感**（`strcasecmp`/`strncasecmp`，configfile.cpp:177-185），键按 `section.key` 匹配；
 * - 分隔符必须是 `=`（configfile.cpp:596 只认 `=`，写成 `:` 会整行作废）；
 * - `#` 是注释（整行或行尾；引号内的 `#` 不算）——任务书还要求容忍 `;`：WSL 自己**只认 `#`**
 *   （configfile.cpp 全文没有 `;`），这里多容忍一个 `;`，比 WSL 宽松，用户从别的 INI 习惯带过来的
 *   分号不会把整行读坏；
 * - 成对引号会被剥掉（`"true"` ⇒ `true`），引号内的前后空格**保留**（于是 `" true "` 在 WSL 眼里非法）；
 * - **同一个键重复出现时第一条生效**（configfile.cpp:631-634；`ConfigKey::Parse` 对重复键只告警不覆盖），
 *   而且第一条**值非法也算数**（解析失败的记录同样会被登记）⇒ 后面的合法重复键不会被采纳；
 * - 布尔值按 `wsl::shared::string::ParseBool`：`true`/`false` **以及 `1`/`0`**，均大小写不敏感
 *   （src/shared/inc/stringshared.h:539，默认 `AllowExtendedForms=false` ⇒ 不收 `t`/`f`/`yes`/`on`）。
 *   这里照 WSL 实现 —— 把 `0` 判成"未知"会让调用方按默认 `true` 处理，等于漏掉"用户已关转发"。
 *   其余任何值（含空值）⇒ 该键在 WSL 侧保持默认 = 未设置 ⇒ 返回 `null`，由调用方套默认值。
 *
 * @param {{ wslconfigText?: string, wslConfText?: string }} [texts] 两个 INI 文件的**原文**
 *   （Windows 侧 `%USERPROFILE%\.wslconfig`、WSL 内 `/etc/wsl.conf`）；读文件是调用方的事。
 * @returns {{ value: boolean|null, source: 'wslconfig'|'wsl.conf'|null }}
 */
export function parseLocalhostForwarding({ wslconfigText, wslConfText } = {}) {
  const fromGlobal = iniBool(wslconfigText, 'wsl2', 'localhostForwarding');
  if (fromGlobal !== null) return { value: fromGlobal, source: 'wslconfig' };
  const fromDistro = iniBool(wslConfText, 'network', 'localhostForwarding');
  if (fromDistro !== null) return { value: fromDistro, source: 'wsl.conf' };
  return { value: null, source: null };
}

// ── 内部实现（不导出：本模块对外只有上面两个函数）──────────────────────────────

/**
 * 在 INI 原文里找 `[section] key = value`。
 * 只在**第一条**匹配的键上给结论：值合法 ⇒ true/false；值非法/文件里没有 ⇒ null（WSL 侧等于"未设置"）。
 */
function iniBool(text, section, key) {
  if (typeof text !== 'string' || !text) return null;
  const wantSection = section.toLowerCase();
  const wantKey = key.toLowerCase();
  let current = null; // 当前段名（小写）；键总是"段.键"形式，段外出现的键在 WSL 里也不成立
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue; // 空行 / 整行注释
    const sectionMatch = line.match(/^\[([^\]]*)\]/);
    if (sectionMatch) {
      current = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue; // 没有 `=` 的行：WSL 只告警跳过
    if (current !== wantSection) continue;
    if (line.slice(0, eq).trim().toLowerCase() !== wantKey) continue;
    // 值的大小写不敏感（ParseBool 内部按大小写不敏感比较）⇒ 先归一成小写再比
    const value = normalizeValue(line.slice(eq + 1)).toLowerCase();
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return null; // 值非法 ⇒ WSL 保持默认；且照 WSL 语义，后面的重复键不再被采纳
  }
  return null;
}

/**
 * 把 `key =` 右边的原文归一成"WSL 会拿去解析的那个字符串"：
 * 去掉引号外的行尾注释，剥掉成对引号，未加引号的值 trim（WSL 跳过后随空格），加引号的值不 trim。
 */
function normalizeValue(raw) {
  const text = stripUnquotedComment(raw);
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return trimmed.replace(/"/g, '').replace(/\\(["\\])/g, '$1');
}

/** 截到引号外的第一个注释符（`#`，附带容忍 `;`）；`\"` 转义不影响引号开合判定。 */
function stripUnquotedComment(raw) {
  let inQuote = false;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      out += ch + raw[++i]; // 转义序列整体保留，交给 normalizeValue 收尾
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      out += ch;
      continue;
    }
    if (!inQuote && (ch === '#' || ch === ';')) break;
    out += ch;
  }
  return out;
}

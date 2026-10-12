# T13 —— A3 目录浏览器对齐（chips / 常显路径输入 / 从 `/` 起的完整面包屑 / 隐藏文件开关）

- **日期**：2026-10-12 ｜ **角色**：client-panel ｜ **任务**：task-13（A3，`docs/prior-art-dsh-wsl.md` §3）
- **写作用域**：`client/**` + `src/explorer.ts`（后者由 lead 在 2026-10-12 明确授权，见下文"授权链"）
- **测试实例**：`dsh --profile remote-wsl-test --port 3091 --no-open`（**不带 web token**），另用一次性 profile `remote-wsl-test-bogus`（3092，测完已删）验证"发行版不在列表"分支
- **纪律**：未 `npm/pnpm install`；未 `pkill`；未重启用户宿主（19387）；所有测试实例用 `Start-Process -WindowStyle Hidden` 起，**可见窗口枚举证明我的实例零窗口**（见 §7）

---

## 0. 授权链与"为什么必须动 host"

A3 的 prior-art 表述是"不改 host 协议"，但**在当前宿主上不成立**，实测证据：

1. 官方 picker 的 `directoryPicker.list` 被组合成 **native** 能力 ⇒ 直接拒：
   `POST /api/directoryPicker/list`（gateway 的 wire 形状：`{type,rpcId,method,payload:{args:{path}}}`）
   → `{"ok":false,"error":{"code":"directory-picker/unavailable","message":"directoryPicker.list needs the browse capability; the composed picker serves \"native\"","details":{"capability":"native"}}}`（UNC 与 WSL 路径两种入参同样被拒）
   出处：`@deepseek-ai/dsh-host-directory-picker-auto/lib/index.js` 的 resolve 注释 —— native 要求 **loopback-only bind + 无 SSH + 可服务的显示会话（darwin/win32 直接假定有）**；测试实例与用户 web 实例都是 loopback+win32 ⇒ 恒 native。⇒ 先例 `dsh-wsl-workspace-picker` 依赖的 `ctx.workspaces.listDirectory`（内部即 `ctx.remote.directoryPicker.list`）**在本机不可用**。
2. 其它现成 Remote namespace 都不合适：`workspaceFiles.*` 需 `workspaceFileScopeId`（session 级 lookup）；`fileReferences` 只有 scoped `list`；`terminal.*` 是终端不是 fs。
3. 我在开工前把这条报给 lead 并给出最小加法；**lead 裁决 (a)：授权我把 `explorer.listDir` 加进 `src/explorer.ts`（只这一个 src 文件）**，并给定了契约（见 §1）。**本轮四能力全部对着真 host 验收，没有用桩**（原先准备的 fetch 层桩因此作废，未使用）。

---

## 1. host 侧：`explorer.listDir`

**契约（逐条照 lead 裁决）**：`explorer.listDir({ path })` → `{ path, distro, entries: [{ name, kind: 'dir'|'file'|'other', hidden }] }`

| 要求 | 实现 |
|---|---|
| 一次返回全部条目（含隐藏），过滤在 client | `hidden = name.startsWith('.')`，返回全量；client 侧过滤（§4 ②） |
| `path` 必须绝对 POSIX；拒 `..` / NUL / 空 | `assertSafeWslPath()`：空 ⇒ `E_ARG`、含 NUL ⇒ `E_ARG`、非 `/` 开头 ⇒ `E_ARG`、含 `\` ⇒ `E_ARG`、含 `..` 段 ⇒ `E_ARG`；归一化重复 `/`、去尾 `/` |
| 读不到 ⇒ 可读错误且**带 path** | 路径不存在/不是目录 ⇒ `E_NOTFOUND`(404)（message 含 path 与 Windows 侧解析后的路径）；其它 ⇒ `E_UNAVAILABLE`(503)；发行版不在列表/未运行 ⇒ `E_UNAVAILABLE`(503) 且 message 指明发行名 + path + "面板不会为了浏览而启动发行版" |
| 只读、零副作用、复用 `unc()` | 复用 `daemon-client.unc()`；**不新开扫描路径**；不启动发行版（见 §2 ④/⑤） |
| 顺序确定 | `name` 升序（`<` 比较） |
| 不破坏既有 4 方法 / 同源门 / 白名单 / 所有权 | 白名单 + 状态码表**成对**新增（`'explorer.listDir'` ↔ `E_NOTFOUND: 404`）；F33 的槽位所有权语义未动 |

**实现中发现的真实缺陷（已修，附证据）**：`/mnt/c`、`/mnt/d` 经 UNC **列不出来**（9p 不暴露 drvfs 挂载根），于是"盘符 chip"点进去是死路：

```
修复前： listDir /mnt/c -> ok=false （\\wsl.localhost\debian-u8-1\mnt\c 读不到）
修复后： listDir /mnt   -> ok count=7 first3=c,d,e
         listDir /mnt/c -> ok count=22 first3=$QAXHoneypot,$Recycle.Bin,.pnpm-store
         listDir /mnt/d -> ok count=29 first3=$QAXHoneypot,$RECYCLE.BIN,.pnpm-store
         listDir /mnt/c/Users -> ok count=6 first3=All Users,Default,Default User
         listDir /mnt/z -> ok=false code=E_NOTFOUND（可读，且 message 里给出解析后的 'Z:\'）
         listDir /mnt/wslg -> ok count=13（WSL 内部挂载仍走 UNC）
```
修法：`windowsDriveForMount()` 把 `/mnt/<单字母>`（及其后代）映射成 `C:\…`。**语义**：`/mnt/<letter>` 本来就是那个 Windows 卷，用 Windows 路径读它读的是同一份数据、且不发生设计稿 §7 警告的"在 UNC 上写 ext4"问题（那条针对发行版内 ext4 路径；本方法**全文只读**）。发行版前置判定**仍先执行**，所以"发行版没开就看不到 /mnt/c"的语义保持一致。

---

## 2. host 验收（原始输出）

用 `Origin` + token 的同源 POST 直调 `/remote-wsl/api`（**跨源会被 403，实测过**）。

**① 正常列一层（含目录/文件/隐藏）**
```
HTTP 200 path=/home/g distro=debian-u8-1 count=72
  dir  .agents        hidden=True
  dir  .atuin         hidden=True
  file .bash-preexec.sh hidden=True
  ...
hidden 条目数=68
对照：~/.dsh/remote-wsl 用 listDir 得 2 项（daemon.log / launch-stderr.log），
      与 WSL 侧 `ls -la` 完全一致 ⇒ UNC 列举与 shell 列举同源同结果。
```

**② 路径不存在 ⇒ 可读错误**
```
HTTP 404 {"ok":false,"error":"remote-wsl: 列目录失败：路径 /home/g/no-such-dir-xyz 不存在或不是目录（ENOENT: ENOENT: no such file or directory, scandir '\\\\wsl.localhost\\debian-u8-1\\home\\g\\no-such-dir-xyz'）","code":"E_NOTFOUND"}
```

**③ 非法路径 ⇒ 400 / E_ARG**
```
{"path":"../etc"}     -> 400 E_ARG（"必须是 WSL 绝对路径（以 / 开头）…"）
{"path":"relative/path"} -> 400 E_ARG
{"path":""}           -> 400 E_ARG（"需要 path…"）
{"path":"/home/g\\x"} -> 400 E_ARG（"不得含反斜杠…"）
{"path":"/home/../etc"} -> 400 E_ARG（"不得含 \"..\" 段…"）
```

**④ 发行版不在列表（一次性 profile `remote-wsl-test-bogus`，`distro: no-such-distro-xyz`；未碰用户配置、未停 debian-u8-1）**
```
HTTP 503 {"ok":false,"error":"remote-wsl: 配置的发行版 \"no-such-distro-xyz\" 不在 wsl -l -q 的输出里 ⇒ 无法读取 /home/g。面板是只读的，不会为了浏览而启动发行版；请检查 config.distro 或先手动启动它。","code":"E_UNAVAILABLE"}
同实例 snapshot.target = {"distro":"no-such-distro-xyz",...}  ← 证明走的是伪造配置
```

**⑤ 无副作用**
```
BEFORE daemon: {"running":false,"keys":[],"orphans":0,"others":[]}
  listDir / -> ok 46   listDir /mnt -> ok 7   listDir /home/g -> ok 72
  listDir /home/g/.dsh -> ok 33   listDir /home/g/no-such-xyz -> ok=false
AFTER  daemon: {"running":false,"keys":[],"orphans":0,"others":[]}
⑤ daemon 段一致 = True        ⑤ wsl -l -v 一致 = True
（另：④ 伪造发行版那次前后 `wsl -l -v` 逐字一致 ⇒ 未启动任何发行版）
```

**⑥ 故意红（证明断言有效）**：临时移掉 `..` 校验后重启，同一请求不再被拒 ——
```
HTTP 200 {"ok":true,"result":{"path":"/home/../etc","distro":"debian-u8-1","entries":[ … /etc 的 160+ 项 … ]}}
```
⇒ 校验是**承重**的（去掉它能列出家目录之外的 `/etc`，是一条真实的路径穿越），断言会红。还原后复验：
```
/home/../etc -> HTTP 400 E_ARG        ../etc -> HTTP 400 E_ARG        /home/g -> HTTP 200 count=72
还原后 SHA256 == 备份 SHA256 ? True（0B81DC0C…DD18）
```

**⑦ `--dump-config`**：`exit=0`，输出中 `Error:` 出现次数 = 0。

---

## 3. client 侧：四个能力（**真 host，非桩**）

| # | 能力 | 原始输出（DOM 抽取） |
|---|---|---|
| ① | **快捷 chips** | chips 文本 = `["Home","/","/mnt","/mnt/c","/mnt/d","/mnt/e","/mnt/f","/mnt/g"]`（`/mnt/*` 是**探测**出来的：来自一次 `/mnt` 列举，按页面缓存一次）。点 `/mnt/c` ⇒ `crumb="/mnt/c" count=21 first3=$QAXHoneypot,$Recycle.Bin,Documents and Settings`；点 `/` ⇒ `count=46`；点 `/mnt` ⇒ `entries=["c","d","e","f","g","wsl","wslg"]`；点 `Home` ⇒ `crumb="/home/g" input="/home/g"` |
| ② | **常显路径输入（回车跳转 + 非法可读错误）** | 输入 `/home/g/.dsh/remote-wsl` + Enter ⇒ 面包屑 `"/home/g/.dsh/remote-wsl"`、`count=2`；输入 `relative/path`（或 `not/absolute`）⇒ `必须是 WSL 绝对路径（以 / 开头）；收到 "not/absolute"。Windows 盘符路径请写成 /mnt/c/... 形式。`（面包屑不变）；输入 `/home/g/no-such-dir-xyz` ⇒ host 侧可读错误 + `重试`：`列目录失败（/home/g/no-such-dir-xyz） | remote-wsl: 列目录失败：路径 /home/g/no-such-dir-xyz 不存在或不是目录（ENOENT…）` |
| ③ | **从 `/` 起的完整面包屑（不折叠）** | 深路径下 `innerText="/home/g/.dsh/remote-wsl"`、crumbs=`["/","home","g",".dsh","remote-wsl"]`、分隔符 3 个；点 `g` ⇒ 跳到 `/home/g`（input 同步、count=4）。`aria-label="当前路径（从 / 起，可点跳转）"`，末段 `aria-current=true` |
| ④ | **隐藏文件开关（默认关）** | 默认：`pressed=false`、`visible=4`、`dots=0`；打开：`pressed=true`、`visible=72`、`dots=68`（`.agents .atuin .bash-preexec.sh .bash_history …`）；关回：`visible=4`。**打开/关闭的 `listCallsDelta = 0`** ⇒ 切换只做本地过滤、不重发请求（与 lead 契约一致；T7 关心的请求放大被避免） |

**渲染修正（自测发现）**：面包屑原先在第一段后也插了 `/`，渲染成 `/ / home / g`；改为根 crumb 后的**第一个分隔符从第 2 段才开始**，现在是 `/home/g/.dsh/remote-wsl`。

---

## 4. 回归（"别破坏已验收的行为"）

| 项 | 结果（原始输出摘要） |
|---|---|
| F34 首挂载只显示"正在读取…" | 首挂载帧：`bodyText="正在读取 explorer.snapshot（/remote-wsl/api，超时 9000ms）…"`、`statusBar="尚未取得快照：正在读取守护与漂移状态（超时 9000ms）…"`、`hasLoading=true`、`hasFalseClaim=false`、`browserAreaRendered=false`（没有快照就不渲染浏览区，不编造"空目录"） |
| F35 LTR 覆盖新增路径文本 | `getComputedStyle` 逐项：`.dsh-rw-crumb` / `.dsh-rw-path-input` / `.dsh-rw-chip` / `.dsh-rw-entry-name` 全部 `direction=ltr` + `unicode-bidi=plaintext`（light 与 dark 两次） |
| `others[]` 只读零按钮 | 本轮真实环境 daemon 运行中且无别槽位守护 ⇒ `others` 分组不渲染（真实快照 `others:[]`）。该分组的代码路径本轮未改；T9 曾用**真实** others（slot 8932/8912）验过 `buttonsInside:0`。**本轮未重新构造出非空 others，如实标注**：T14 若要复核需注入或等环境出现别槽位守护 |
| 停止/重启二次确认 | 点「停止 slot 8731…」⇒ `role=alertdialog`：`确认停止守护？slot 8731（本插件配置的槽位，不存在 all 选项） | 后果：该槽位上的守护会被关掉，正在跑的会话全部中断、上下文丢失；之后需要重新「启动守护」。　当前该槽位 keys/session = 0。 | 确认停止 | 取消`；点「取消」⇒ 弹层消失、真实守护未被停 |
| aria/title 不退化 | 面板内 `24` 个按钮，`missingBoth(aria+title) = 0`；rail 可访问名仍是「远程资源管理器」 |
| light / dark | light：`label-primary #0f1115 / bg-layer-2 #fff / sidebar-fill #f9fafb`；dark：`#f9fafb / #2c2c2e / #1b1b1c`；浏览区/标题/chips/crumb/input/entry/状态条逐项随 token 变化，`dir` 恒 ltr |
| 只用主题 token | 扫描页面内全部含 `dsh-rw-` 的规则：`88` 条中**硬编码颜色 0 条** |
| 挂载卸载不杀守护 | 所有脚本只读快照与列目录；唯一动守护的是用户点按钮（本轮点过一次真实的「启动守护」⇒ `daemon slot 8731 · :8731 · pid 1026481 · 0.2.0-rc.2 · keys 0`，status 由 `daemon 未运行` 变为运行中，是幂等 ensure） |

---

## 5. 桩 vs 真机（照 lead 要求写清）

- **四个能力：真 host，无桩。** 用到的注入只有：`window.fetch` 里把 `explorer.snapshot` 挂住（**只为稳定观察 F34 的首挂载帧**，属故障注入，已标注），以及 host 侧"故意红"那一处**已还原**的代码改动。
- 原先准备的"伪造 `explorer.listDir` fixture 树"的桩**未使用**（因为真方法当场落地了）。

## 6. 未复核 / 已知取舍

1. **"发行版未运行"分支未复核**：要构造它必须有一个**关着的发行版**，那会打扰用户环境（且禁止停 `debian-u8-1`）。已用**兄弟分支**（发行版不在列表）覆盖同一段前置判定的代码路径，并证明"未启动任何发行版"。
2. **`/mnt/*` 上的 Windows"隐藏属性"不参与判定**：`hidden` 只按 `.` 前缀（与任务/先例措辞一致）。因此 `C:\Windows`、`C:\Users` 这类"Windows 隐藏属性"条目会被当作普通条目显示。这是刻意取舍，未按 Windows 属性重新定义 `hidden`。
3. **热更**：client 半改动是否需要 `dev:web` 仍未实测（本轮一律"入口 mtime 变更 → rev 变 → 重启测试实例"）。
4. **`/mnt/<letter>` 之外的 drvfs 特例**（如自定义挂载点）仍走 UNC；未探测其它挂载类型。
5. `daemon.others[]` 非空时的渲染未在本轮真实环境复现（见 §4 表）。

## 7. 纪律证据与锚点

- 可见窗口枚举（`MainWindowTitle -ne ''`）里只有一个 DeepSeek Harness 窗口，属**用户宿主**（19387）；我的 3091 实例 `HasWindow=False`、3092 实例同样 Hidden 启动；测完 3092 已停、一次性 profile `remote-wsl-test-bogus` 已删。
- 收工锚点（SHA256）：

```
6C414CB375E3B77FFD1C742F676EBEED831A2657232EB8FFED7594974B1B12A0  src/explorer.ts
4CA5C7BA1A9523632DCDD40A0A4A00EB3DFD2817FA2EAE014375203E01C53901  client/client.api.js
E9A824F50E45E5D4840A8604D511DBC2B87CC4BB30A6512AEFE505DC11B7D431  client/client.icon.js
86F24076D6CD6A0DCDE1017734E8E7B2A811B5246C28DE2093EC3F4E6775907E  client/client.panel.js
0588B3D32DED5FD4B80E3A96970C9740AE18A1607EB9FF3A6F6D29B92353B416  client/index.js
CE486ECED7BC36DF696B51D2DD6646576AB3065EFE46995C34A1EF4F4D20A087  package.json
```

# T20 —— `explorer.daemon` 透传 `mode` / `warning`（F-38c 收尾环）

- **日期**：2026-10-12 ｜ **角色**：client-panel ｜ **任务**：task-20（依赖 task-19）
- **写作用域**：**仅 `src/explorer.ts`**（我的独占作用域；`host-explorer` 只发示例、没碰它）
- **交付 diff**：`src/explorer.ts` **+7 行**（2 行代码 + 5 行注释），**0 删除**；未改动作白名单 / F33 槽位守卫 / 错误码 / 状态码表 / `notes[]` 文案
- **锚点**：`src/explorer.ts = 27887933A1BB126884432E971FC695EDA9385382B812D4A15BB4CB4498688F47`；上游 `src/daemon-client.ts = 4D5C2EBF955CBAABB4EC8A2A64E6EF528B98790C1EF0DE8D8C87E9D126D88E7F`（T19 版，未动）

```diff
+        mode: r.mode ?? null,
+        warning: r.warning ?? null,
```
（另加 5 行注释说明语义：`'systemd'` = 主路径无窗；`'compat-detached'` = 回退**可能弹窗**；`'reused'`；`warning` 为完整可展示告警；`notes[]` 照旧并存不替代。）

测试实例：一次性 profile `remote-wsl-test-p20`（`daemonPort: 8921`，本任务段）与 `remote-wsl-test-p20bogus`（伪造发行版，测失败分支），均 `Start-Process -WindowStyle Hidden` + 重定向、`--no-open`、端口 3091/3093；**未碰 19387/47604、未碰 3092（那是 T17 的实例，实测确认）**。

---

## 验收逐条（原始输出）

**① systemd 主路径**
```
POST /remote-wsl/api {"method":"explorer.daemon","args":{"action":"ensure"}}
HTTP 200  mode=systemd  warning=null  slot=8921 port=8921 pid=1153076
notes 启动方式行: 启动方式: systemd-run --user（unit dsh-rwsl-8921.service；包装层短命 ⇒ 无窗口，且与 Windows 侧生死解耦）
```

**② `DSH_REMOTE_WSL_SYSTEMD=off`（宿主进程带该 env 起）**
```
HTTP 200  mode=compat-detached
warning=⚠️ 未能由 systemd 托管守护（DSH_REMOTE_WSL_SYSTEMD=off（显式关闭 systemd 托管））⇒ 已回退到**兼容启动**：守护仍可脱离客户端存活（约束 b 保住），但在 Win11 + Windows Terminal 下**可能弹出一个可见控制台窗口**（约束 a 不保证）。建议在发行版 /etc/wsl.conf 里打开 `[boot] systemd=true`，执行 `wsl --shutdown` 重启发行版后再用（那样既无窗、又独立）。
slot=8921 port=8921 pid=1155484   notes 条数=3，仍含"启动方式"行
```

**③ 复用**
```
HTTP 200  mode=reused  warning=null  slot=8921  reused=True
```

**④ 失败分支**：`=on` + 托管失败 **本机无法复现** —— 因为本发行版 **systemd 可用**，`=on` 会直接走主路径并**成功**（实测）：`HTTP 200 mode=systemd warning=null`。故按纪律拆成三条等价证据（**不把没跑成的说成跑成了**）：
- (a) **daemon 层失败对象**（直调 `daemon-client.ensureDaemon`，distro 不存在 ⇒ 无 spawn）：
  `{"ok":false,"mode":null,"warning":null,"tried":[8927],"error":"…无法创建 WSL 侧状态目录…"}`
- (b) **route 层失败行为**（伪造发行版 profile）：
  `HTTP 503  ok=False code=E_UNAVAILABLE  有 result 字段 = False`，error = `remote-wsl: 远端守护在 Windows 侧不可达：试过端口 8924, 8925, 8926 —— 无法创建 WSL 侧状态目录 …`
  ⇒ 失败走**错误信封**（无 `result`），所以 `mode`/`warning` 在失败响应里**不可观测**（语义 = null）。
- (c) `=on` + 托管的"**按显式配置不回退**"文案：本轮**未复现**，引用 T19 的既有证据 `spike/verify/explorer-20261012/host-f38/out-01-scenario-on.txt`（同一份源码、同一字段）。
- ⚠️ 给 T21 的断言口径：失败时**不要**断言 `body.result.mode === null`（没有 `result`）；应断言 `ok===false && code==='E_UNAVAILABLE' && !('result' in body)`。若要失败响应里也带字面 `mode:null`，那是**传输层（adapter 信封）**改动，不在本任务范围 —— 请 lead 裁决是否另开。

**⑤ 非配置槽位仍被 F33 守卫拒绝**
```
HTTP 400 {"ok":false,"error":"remote-wsl: slot 8925 不是本插件配置的槽位（8925≠8921）；本插件只操作自己的槽位","code":"E_ARG"}
```

**⑥ 无副作用**（三次前后对照）
```
围绕⑤被拒调用： before==after ? True   （running:true slot 8921 pid 1153076 …）
围绕只读批（snapshot+listDir×2）： before==after ? True
围绕③复用 ensure： before==after ? True
```
另：`wsl -l -v` 前后逐字一致（未启动/停止任何发行版）。

**故意红（≥1，已做）**
```
备份 hash = 27887933A1BB126884432E971FC695EDA9385382B812D4A15BB4CB4498688F47
去掉两行透传 → 重启宿主 → POST ensure：
HTTP 200  result 字段 = action,ok,idempotent,slot,port,pid,version,reused,started,notes
mode 存在 = False  warning 存在 = False   断言 mode -eq 'systemd' = False  ← 红 ✓
还原（Copy-Item 备份）→ 还原后 hash==备份 ? True
重启 → 全新起一次：
HTTP 200  mode=systemd  warning=null  slot=8921 pid=1158904
notes 启动方式行: 启动方式: systemd-run --user（unit dsh-rwsl-8921.service…）  ← 绿 ✓
```

---

## 窗口纪律（两个数都要给，不用标题猜）

- 起实例全程 `Start-Process … -WindowStyle Hidden -RedirectStandardOutput/-Error`；宿主进程 `MainWindowTitle=''`。
- **②（`=off` 兼容回退）是验收要求必须跑的一条，它**真的产生了一个可见窗口**：**
```
WT 窗口进程: pid=49220 name=WindowsTerminal.exe start=10/12/2026 20:26:10 ppid=1700 title=C:\Program Files\WSL\\wsl.exe
wsl.exe     : pid=34900 start=10/12/2026 20:26:10 ppid=40588  cmd=wsl.exe -d debian-u8-1 -- bash /home/g/.dsh/remote-wsl/launch.8921.sh
我的宿主     : pid=40588 start=10/12/2026 20:25:34（--profile remote-wsl-test-p20 --port 3091，WindowStyle Hidden）
交叉证据     : daemon.log `[daemon pid=1155484 2026-10-12T12:26:11.606Z] … peer=win-pid-40588`
```
  ⇒ 归属判定 = **启动时间同秒 + 进程树（wsl.exe 的 ppid 就是我的宿主 40588）+ `peer=win-pid-40588` 交叉**；关闭 8921 守护后该窗口与 wsl.exe**自行消失**（49220/34900 均 gone）。这同时**印证了 T19 那条 warning 的措辞**（"在 Win11 + Windows Terminal 下可能弹出一个可见控制台窗口"）。
- 因此本轮的**两个数**：**产生过的可见窗口 = 1**（测试 compat 路径所必需，已消失）；**收尾时存在的我方可见窗口 = 0**（枚举只剩用户自己的 8 个窗口：Code/Cursor/DSH 宿主/Geph/Edge/QQ/输入法/微信）。

## 收尾清理（原始输出）
```
-- systemd unit --     0            （无 dsh-rwsl* 残留）
-- state dir --        daemon.log / launch-stderr.log 两个文件（均 -rw------- 0600，无 launch.*.sh、无 daemon.*.json）
-- 8921-8930 守护 --   none
停宿主： stopped 3091 PID 25944 / stopped 3093 PID 43940
删 profile： remote-wsl-test-p20 removed = True / remote-wsl-test-p20bogus removed = True
残留进程： 匹配 remote-wsl-test-p20 的进程均已退出（32480/44196 gone）
```

## 未复核 / 留给后续（均未改动）
1. **`=on` + 托管失败**的分支文案（见 ④c）：本机 systemd 可用，需"环境故障"才能复现；未用改发行版/造故障的方式硬造。
2. 失败路径的 error 文案当前是 **`remote-wsl: remote-wsl: …`（双前缀）**：`daemon-client` 的 `error` 已带前缀，而 `explorer.daemon` 又加了一次（`failUnavailable(\`remote-wsl: ${r.error}\`)`）。**本轮按纪律没碰**（task-20 要求"不改任何其它行为"），建议另开一条小修（一行：前缀安全拼接）。
3. `launch-stderr.log` 在 compat 路径下被写到 53429 B（增长正常，模式仍 0600）。

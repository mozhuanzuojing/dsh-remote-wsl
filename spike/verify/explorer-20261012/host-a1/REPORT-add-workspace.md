# REPORT —— A1 host 半：`explorer.addWorkspace`（task-23）

- **结论**：新增 host 方法 **`explorer.addWorkspace({path, title?})`**：**WSL 绝对路径 → UNC `\\wsl.localhost\<distro>\<path>` → `workspaceRegistry.create(uncPath, title)`**（T11 实测的 arity 2 契约，未另发明）。已登记 ⇒ **复用**（`resolveByPath` 命中）返回既有 `id` + `alreadyExisted:true`；返回机器可读 `{ok,id,title,uncPath,alreadyExisted}`；错误分级 `E_ARG`(400)/`E_NOTFOUND`(404)/`E_UNAVAILABLE`(503)，服务缺失另有**一行降级日志**。
- **验证方式**：起了一个 **孤立 `DSH_HOME`** 的真 host 实例（`%TEMP%\a1-home`，profile 用 **Junction** 指向仓库），经真实 HTTP 路由 `/remote-wsl/api` 调用 ⇒ **①–⑥ 全 PASS**、**⑦ 故意红成立**。用户自己的 `~/.dsh` 的 workspace 存储**未被写入**（见 §5）。
- **改动面**：`src/explorer.ts`（`F6C77D5B0B9AF81D05753DDB63BF7C2DC897DF0173C55AB72CF7B1E962942C31`）+ `src/index.ts`（`E5BE29F58453BE0546C8AB60E2494041CC7B8D182ECD1F4504C2B64476633ED1`，只多传一个取服务的闭包）；其余 6 个 src 逐字不变。`README.md` 加了 A1 小节（advisory）。

## 1. 实现要点（`src/explorer.ts`）

| 点 | 做法 | 为什么 |
|---|---|---|
| 方法名/白名单 | `EXPLORER_METHODS` + `handlers` 各加 `explorer.addWorkspace` | 未知方法仍 400；同源门/仅 POST+JSON/无凭据回传/F33 守卫**一律未动** |
| 入参校验 | 复用 `assertSafeWslPath`，**给它加了 `method` 参数**（缺省 `explorer.listDir`）⇒ listDir 文案**逐字不变**，新方法文案前缀是 `explorer.addWorkspace` | 不复制第二份校验逻辑、也不改老文案（§4 已逐字对照） |
| `/mnt/<盘符>` | **先拒绝**（400）并给出"它就是 Windows 卷 `<X>:\…`"的去向 | 与 `listDir` 的 `windowsDriveForMount` 取舍一致：不能让同一份数据"两条路径"并存 |
| 服务获取 | `deps.workspaceRegistry()` 闭包（index.ts 传 `() => ctx.get('workspaceRegistry')`）；拿不到或形状不对 ⇒ 503 + **一行日志** | 照 `webServer` 那次的降级写法，不静默 |
| 存在性 | `statSync(uncPath)`（Windows 侧经 9p）⇒ `ENOENT/ENOTDIR` 映射成**可读 404** | 上游 `realpath` 的 ENOENT 不许裸抛 |
| 已登记判定 | `resolveByPath(uncPath)` 命中 ⇒ **不调 create**，返回既有 `id` | "点两次不产生第二个"的关键 |
| title | `args.title` 缺省 = `baseName(path)` | 与 T11 实测一致（`/home/g` ⇒ `"g"`） |
| 失败映射 | create 抛错时：`ENOENT/ENOTDIR`→404；`not fully qualified`→400；其余→503（都带 UNC 与原始 detail） | 分级可读 |

## 2. 验收 ①–⑥（孤立 home 实例，端口 3093；原始输出 `out-01-acceptance.txt`）

```
① register /home/g: HTTP 200 {"ok":true,"result":{"ok":true,"id":"4d38e2a9-…","title":"g",
   "uncPath":"\\\\wsl.localhost\\debian-u8-1\\home\\g","alreadyExisted":false}}
② register again : HTTP 200 {… "id":"4d38e2a9-…"(同一 id),"alreadyExisted":true}
③ 不存在路径      : HTTP 404 {"code":"E_NOTFOUND","error":"…路径 /home/g/definitely-not-here-t23 不存在（UNC …；ENOENT: …stat…）"}
④ 空/相对/`..`/反斜杠/`/mnt/c` ⇒ HTTP 400 {"code":"E_ARG"}（五条各一条可读文案；`/mnt/c` 那条给出 C:\Users 的去向）
⑥ daemon facts: before={"running":false,"keys":[],"orphans":0,"others":[]} == after
SUMMARY: ALL PASS
```
**登记确实落库**：孤立 home 的 `storages\workspace.json`（542 字节）**含**我创建的 id `4d38e2a9-…` **与** `\\wsl.localhost\debian-u8-1\home\g` ⇒ 即 `workspaceRegistry.list()` 的持久化侧能看到（这也是"已登记"的独立证据，不只是返回值自述）。
**零副作用**：`④` 五连发之后 `/home/g` 仍是同一 id 且仍 `alreadyExisted:true`；`⑥` 调用前后 `snapshot.daemon` 逐字不变。

## 3. 验收 ⑤ 服务缺失降级（`out-02-degrade.txt`）

桩掉 `workspaceRegistry`（getter 返回 `undefined`；以及"有 `resolveByPath` 但没 `create`"的形状不对）：
```
[missing]     throw code=E_UNAVAILABLE :: remote-wsl: host 侧 workspaceRegistry 服务不可用 ⇒ 无法把该路径登记为 DSH 工作区（其余面板功能不受影响）
[wrong-shape] throw code=E_UNAVAILABLE :: （同一句）
捕获到的降级日志行（恰好 2 条）:
   remote-wsl(explorer): workspaceRegistry 服务不可用 ⇒ explorer.addWorkspace 降级（无法登记 DSH 工作区；方法表其余方法不受影响）
```
⇒ 可读 503 + 有日志、不静默；且**在触碰 registry/文件系统之前**就返回（无副作用）。
（第一次跑夹具只捕获到 1 条 —— 是**我夹具的 bug**：过早恢复 `process.stderr.write`；修好后 2/2。）

## 4. 验收 ⑦ 故意红（`out-03-red.txt` / `out-04-green-after-reset.txt`）

把"已登记则复用"改成**无条件 create**（`if (false && existingId)`）+ **全新孤立 home** + 独立实例（3094）：
```
② register /home/g again: HTTP 200 {… "alreadyExisted":false}      ← 应为 true
[FAIL] ② alreadyExisted=true
SUMMARY: 2 FAILED        （RED probe exit=1）
```
字节还原后（`restore byte-exact: True`）在**又一个全新 home**（3095）复跑：`SUMMARY: ALL PASS`（exit 0）。
> 一个必须写清的细节：红态下 **`id` 仍然相同**（上游 `create` 自己会按 canonical 路径复用）⇒ 这条缺陷的**可观测差异是 `alreadyExisted` 标志**，不是"多出一个工作区"。所以判据必须落在**标志**上（面板就是用它决定"已登记"），只比 id 会漏。

## 5. 隔离与收尾

- **用户状态零改动（定向判据）**：用户 `~\.dsh\storages\workspace.json`（11088 字节）**不含**我的 id、**不含** `wsl.localhost` ⇒ 我登记的工作区只在孤立 home 里。
  用户 `~\.dsh` 全量哈希前后差 19 行，**逐条归类后与本次无关**：3 行 = `profiles\remote-wsl-ux-base\*`（**他人 T 轮**新建的 profile），16 行 = `sessions\--D-project-net1--\*`（活跃会话自身写入）。**不声称"零 diff"**，只声称"workspace 存储未被写入"。
- **收尾**：3 个测试实例（3093/3094/3095）全部停止（监听为空）、3 个孤立 home 全部删除、`WT` 空、`launch.*` 残留 0、守护 0、`dsh-rwsl*`/`t15*` 单元 0、**`is-system-running` = `running`、failed = 0**（按 lead 新规矩：systemd 单元收尾必须 `stop` + `reset-failed`）。用户宿主 47604 存活、未被碰。
  窗口枚举：`Code/Cursor/DSH 47604/explorer/gephgui-wry/msedge/QQ/TextInputHost/Weixin` —— 全是用户应用；本轮**无 WindowsTerminal**（T23 不起守护，全程未走 compat 路径，也就没有弹窗风险）。中途短暂出现的 `chrome` 窗口在我核对时已消失、且我的每次实例启动都带 `--no-open`、观测全程 `-WindowStyle Hidden` + 重定向 ⇒ **无归属证据，不认领**。

## 6. 回归 / 未复核

- **回归**：`--dump-config` **exit 0 / `Error:` 0 / 与基线逐行 diff = 0 行**；`explorer.listDir` 的四类拒绝文案**逐字未变**（`assertSafeWslPath` 加参数后仍打印 `explorer.listDir`）；白名单/同源门/动词门/槽位守卫**未改**。
- **未复核**：
  1. **未在用户自己的 host（19387/47604）里跑**（避免污染用户 workspace 列表）⇒ `ctx.get('workspaceRegistry')` 在用户母体里的实取只在孤立 home 实例验证过（同一套加载路径）。
  2. **`title` 重名/已存在但 title 不同的语义**：已登记时我返回**既有** title（不覆盖）；上游是否有 rename 语义未测。
  3. `/mnt/<盘符>` 只做了**拒绝**验证；"按 Windows 路径语义登记 Windows 卷"这条（走 `C:\…`）**在 addWorkspace 里没实现**（方法只收 WSL 绝对路径），文案里只给了去向 —— 若面板确实需要，应作为**另开**方法/参数处理，别偷偷放宽本方法的入参。
  4. 孤立实例的 profile 用 Junction 指向仓库（与 `remote-wsl-test` 同构）；`DSH_HOME` 隔离下 `storages/workspace.json` 的 schema 是否与用户母体完全同形，只按"能被上游 `create/resolveByPath` 正常读写"验证。

## 7. 证据文件（`spike/verify/explorer-20261012/host-a1/`）

`REPORT-add-workspace.md`、`out-01-acceptance.txt`（①–④⑥ ALL PASS）、`out-02-degrade.txt`（⑤）、`out-03-red.txt`（⑦ 红）、`out-04-green-after-reset.txt`（⑦ 复绿）、`out-05-dumpconfig.txt`、`user-dsh-baseline.txt`/`user-dsh-after.txt`（隔离对照）、`instance*.log/err`、`final-sha256.txt`；脚本 `probe-a1.mjs`、`probe-a1-degrade.mjs`、`mut-t23.mjs`。

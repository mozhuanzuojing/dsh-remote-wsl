# usability/ —— task-5 可用性评估目录（准备完成，等 lead 的 go）

> **状态：准备完成，未对界面下任何结论。**
> **2026-10-12 11:42 复核：** `exports["./client"] = ./client/index.js` ✅、`dsh.client = {platform:"web", inject:[]}` ✅、`docs/client-contract.md` ✅ 三条**都已落地**；
> 但 `task-3` 仍是 `in_progress`（`client.panel.js` 11:40:55 / `index.js` 11:41:16 仍在变）⇒ **等 lead 的 go + T3 收尾**再冻结 revision，否则证据对着移动靶。
> 期间只做骨架，**不评估**。

## 文件索引

| 文件 | 作用 | 什么时候用 |
|---|---|---|
| `MATRIX-usability.md` | **评估矩阵**：基准场景 S-BASE + 对照 S-CTRL、M1–M11 指标与判缺陷阈值、lead Q1–Q5 裁定、缺陷候选 D\*、缺口 G-\* / 偏差 X-\* 表、VS Code 对比基线 | 开工前读；开工后按它取证 |
| `usab-run.ps1` | 实例与证据骨架：记活宿主 pid / 生成 `--patch` overlay / 起 8961 / 停自己 / 复算 revision / 抽 token URL（`out-04-url.txt`）/ 打步骤清单 | 每一步都用（见 `-Mode Checklist`） |
| `out-11-patch.yml` | 我自己的 overlay（不改共享 profile）：`distro/cwd/daemonPort` | 由 `-Mode DumpConfig` 生成 |
| `usab-dom.js` | **控件级全量抽取**（M2/M3/M4/M6/M7/M8/M10）：rail、控件清单、title-only、术语三档、状态面、反馈几何、键盘候选 | 每个状态各抽一次 → `out-12/13` |
| `usab-p0scope.js` | **M11 范围探针**（lead Q3 落地）：缺口 G-\* present/missing + 偏差 X-\*（实现超出设计）+ "P0 承诺项是否缺" | 每状态一次 → `out-15-p0scope.json` |
| `usab-instrument.js` | 页面内探针：真实 `click`/`keydown` 计数 + `fetch` 请求钩子（**动作数的机器可复算证据**） | 步骤 5 安装，之后反复读 |
| `usab-theme.js` | M9：light/dark 的 token 解析值 + **WCAG 对比度**（不只是"两张图不同"） | 主题步骤 → `out-14` |
| `REPORT-usability.template.md` | 交付报告骨架（结论 ≤450 字 + 动作序列 + 认知负荷清单 + ≥3 可发现性缺陷 + P0 缺口表 + 偏差表 + ≥2 截图 + 未测项） | 收尾 |

## 怎么跑（详细步骤在 `pwsh ./usab-run.ps1 -Mode Checklist`）

```
1. pwsh ./usab-run.ps1 -Mode Baseline      # 活宿主 19387 pid（开工/收工必须一致）→ out-10
2. pwsh ./usab-run.ps1 -Mode DumpConfig    # 生成 overlay + compose 校验 → out-11（须见 daemonPort: 8962）
3. pwsh ./usab-run.ps1 -Mode Start         # 起测试实例 8961（自有守护槽位 8962）→ 并抽 out-04-url.txt
4. pwsh ./usab-run.ps1 -Mode Revision      # 被验对象 SHA256 → out-98
5. 浏览器取证（chrome-devtools-mcp；**用 out-04-url.txt 的带 token URL**）→ 见 MATRIX §5 命名
6. pwsh ./usab-run.ps1 -Mode Revision + -Mode Stop   # 复算 + 只停自己
```

## 截图/取证手段（**已自证**，非计划）

- **主手段 `chrome-devtools-mcp`**（本回合已出图证明可用）：
  `list_pages` → `new_page(background:true)` → `navigate_page(http://127.0.0.1:8961/)` → `take_screenshot(filePath=…)`；
  DOM 抽取/探针：`evaluate_script(function = <本目录 js 文件内容>, filePath = …)`。
- **兜底 `cua_driver_native`**：`browser_prepare({allow_launch:true, profile:{mode:'isolated_new'}})` → `browser_navigate` → `get_browser_state({include_screenshot:true})`（不动用户 profile、不抢前台）。
- **不需要**用户授权任何截图权限；也不用 `bring_to_front`。

## 纪律（硬约束）

1. **只写本目录**；`src/`、`client/`、`package.json`、`docs/`、他人 `spike/verify/*` 一律只读。
2. **绝不**重启/停用户宿主（19387，当前 pid 47564，基线已记 `out-10-livehost-baseline.txt`）；无全局 `pkill`/`taskkill`；只按自己的 pid 文件停自己的进程。
3. **不写共享 profile**（`remote-wsl-test`）——配置只经 `--patch` 传入（已验证生效，见 `out-11-dumpconfig-*.txt` 第 1282–1289 行）。
4. 守护只碰**自有槽位 8962**；界面上的「停止」只按自己 ensure 起来的那一个。
5. 结论必须**截图 / 命令 / 输出**三者对得上；不确定写「未核实」，`unknown` 绝不写成通过。
6. 端口只用 **8961–8970**。

## 准备期已实测（可复算，详见 MATRIX §8）

- 活宿主 `127.0.0.1:19387` → pid **47564**（未变）
- 8961–8970 全空闲
- `dsh --patch <path>` 受支持（`dsh.cmd --help`）
- overlay 生效：`--dump-config` exit 0，`remote-wsl` 条目 `distro: debian-u8-1 / cwd: /home/g/project/dsh1 / daemonPort: 8962`
- 被验对象 revision 已落 `out-98-revision.txt`（8 个 `src/*.ts` + 4 个 `client/*.js`；**client 文件大小在 10 分钟内变化过** ⇒ T3 仍在写，冻结要等 lead 放行后）
- 截图可用（真实 PNG）；三个 JS 探针语法自检 `typeof=function` 全通过
- 场景夹具：`/home/g/project/dsh1` 存在；`~/.dsh/remote-wsl/explorer.json` **不存在** ⇒ 树里默认只会有 `config.cwd` 一条（D2 的对照条件）

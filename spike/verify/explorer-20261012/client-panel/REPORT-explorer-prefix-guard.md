# T20 收尾修补 —— `remote-wsl:` 组合型重复标记（外层收口，不改内层）

- **日期**：2026-10-12 ｜ **角色**：client-panel ｜ **任务**：task-20 的同文件收尾修补（lead 2026-10-12 裁决）
- **写作用域**：**仅 `src/explorer.ts`**（未碰 `src/index.ts`）
- **本次 delta**：1 个 helper + 2 个调用点（`explorer.openSession` 的 ensure 失败、`explorer.daemon` 的 ensure/restart 失败）
- **锚点**：`src/explorer.ts = 906B9554DF9ABC68E7A061FD5923D2F6C2D4F9F45CD24E34F167A72230F12E1E`（含 T20 的 `mode`/`warning` 透传）；`src/index.ts = 84ACA8D0…`、`src/daemon-client.ts = 4D5C2EBF…`（**均未动**）

```ts
/** 只保留**一份** `remote-wsl: ` 模块标记（上游可能已经带过）。判据用 includes 而非 startsWith：
 *  上游前缀在聚合错误里落句中（`—— remote-wsl: …`）。本函数只决定"要不要加"，**不改**上游文案。 */
export function withModulePrefix(message) {
  const text = str(message).trim();
  return text.includes('remote-wsl:') ? text : `remote-wsl: ${text}`;
}
```
`if (!ensured.ok) failUnavailable(withModulePrefix(ensured.error));`（openSession）
`if (!r.ok) failUnavailable(withModulePrefix(r.error));`（daemon ensure/restart）

## 1. 缺陷性质（与 p0-verify/lead 的定位一致，并补一条我实测到的边界）

- 全仓只有 **一处** 上游 error 自带前缀：`src/daemon-client.ts:588`（`=on` 拒绝回退那句）。
- 它被 `daemon-client.ts:838` 并进聚合错误：`远端守护在 Windows 侧不可达：… —— ${last}` ⇒ 上游前缀落**句中**。
- `explorer.ts` 外层再无脑加一层 ⇒ 同一条消息出现 **两次** `remote-wsl:`（第一次在句首、第二次在 `—— ` 之后）。
- **边界（实测）**：`startsWith` 判据在这里**永远不命中**（聚合错误不以标记开头）⇒ 必须用 `includes`；否则改动 0 效果。

## 2. 改前 / 改后：lead 引用那句的**同位置**原文对照

用导出的 helper 对 lead/T18/T19 引用的那句做逐字对照（`=on` 分支本机不可触发 —— 见 §5）：

```
上游文案（组合串，含内层前缀）：
  远端守护在 Windows 侧不可达：试过端口 8911, 8912, 8913 —— remote-wsl: DSH_REMOTE_WSL_SYSTEMD=on 但 systemd 托管失败（…）；按显式配置**不**回退

改前  外层 'remote-wsl: ' + 上游 ：
  occurrences=2  leading=true
  >>>remote-wsl: 远端守护在 Windows 侧不可达：试过端口 8911, 8912, 8913 —— remote-wsl: DSH_REMOTE_WSL_SYSTEMD=on 但 systemd 托管失败（…）<<<

改后  withModulePrefix(上游) ：
  occurrences=1  leading=false
  >>>远端守护在 Windows 侧不可达：试过端口 8911, 8912, 8913 —— remote-wsl: DSH_REMOTE_WSL_SYSTEMD=on 但 systemd 托管失败（…）<<<

对照（上游**没有**标记时，改前/改后同为 1、leading=true）：
  occurrences=1  leading=true
  >>>remote-wsl: 远端守护在 Windows 侧不可达：试过端口 8924, 8925, 8926 —— 无法创建 WSL 侧状态目录<<<
```

## 3. 中性验证：所有**可达**真实路径改前 == 改后（逐字）

| 调用 | 改前 | 改后 |
|---|---|---|
| `explorer.daemon ensure`（`=on` 环境，真机） | `HTTP 200 mode=systemd warning=null slot=8921` | `HTTP 200 ok mode=reused/reused-start slot=8921`（字段齐全） |
| 非配置槽位 `stop slot=8925` | `400 {"ok":false,"error":"remote-wsl: slot 8925 不是本插件配置的槽位（8925≠8921）；…","code":"E_ARG"}` | **逐字相同** |
| 失败路径（伪造发行版 `no-such-distro-xyz`） | `503 code=E_UNAVAILABLE`，error 逐字见下 | **逐字相同**（`改前 == 改后 ? True`） |
| `GET` 方法表（白名单） | `["explorer.snapshot","explorer.openSession","explorer.daemon","explorer.fixPin","explorer.listDir"]` | **逐字相同** |

失败文案（两次同一请求，同一 profile，重启前后）：
```
remote-wsl: 远端守护在 Windows 侧不可达：试过端口 8924, 8925, 8926 —— 无法创建 WSL 侧状态目录 /home/g/.dsh/remote-wsl（发行版 "no-such-distro-xyz" 是否在跑？）。这些端口在 Windows 命名空间里可能被别的程序占用（WSL 侧 bind 成功不代表 Windows 侧能连上）。请释放其中一个端口，或把 config.daemonPort 指到别的端口。
```
⇒ `remote-wsl:` 出现 **1** 次、开头就是它：**该守卫不会让"上游无标记"的路径丢标记**。

未改：错误码/状态码表、动作白名单、F33 槽位守卫（400 `E_ARG` 逐字相同）、`notes` 结构与文案（`notes` 条数/内容不变）。

## 4. 故意红（照 lead 要求：去掉外层前缀后断言应仍绿，若变红说明删多了）

把 helper 临时改成 `return text;`（**连外层前缀也不加**），重启实例后实测：

```
真实无标记失败路径（伪造发行版）：
  HTTP 503 code=E_UNAVAILABLE
  error 开头 = >>>远端守护在 Windows 侧不可达：试过端口 8924, 8925, 8926 —— 无法创建<<<
  含 remote-wsl: = False        ← 断言「错误必须含 remote-wsl:」**变红** ✓（说明"无脑删前缀"= 删多了）
同一红版对 lead 引用的组合串：
  occurrences=1  contains=true  leading=false   ← lead 预期的断言**仍绿** ✓（内层前缀在）
结论：正确修法是"**已带就不再加**"（守卫），不是"无条件不加"（删多了）。
还原：Copy-Item 备份 → `hash==备份 ? True`（906B9554…2E1E），重启复绿 → 失败文案与改前**逐字相同**。
```

## 5. 未复核 / 已知边界

1. **`=on` + 托管失败**这条触发路径本机**不可复现**（本发行版 systemd 可用；我今天还试过"预占 `dsh-rwsl-8921.service` unit 名"——插件仍成功 `mode=systemd`）。⇒ 那句组合文案的"真机字节"来自 T19 的 `host-f38/out-01-scenario-on.txt` + 本次 helper 级同串对照，**不是**我本轮跑出来的 route 响应。如实标注。
2. 判据用 `includes` 的边界：若未来某条**自撰**文案在句中提到 `remote-wsl:`（而无前缀语义），外层就不会再加句首标记。当前可自查的站点里没有这种文案（扫过 `src/explorer.ts` 全部 `remote-wsl:` 字面量）。

## 6. 第二个面（`wsl_daemon`）—— **报给 lead，未改**

`src/index.ts:1022` 是同型站点：
```ts
const r = await ensureDaemon(config, { version: version.version, restart, log: logDaemon });
if (!r.ok) throw new Error(`remote-wsl: ${r.error}`);   // ← 与 explorer 改前完全同型
```
同一个 `ensureDaemon` 结果 ⇒ **同一组合条件**（内层 `=on` 前缀落句中时）会产生同样两次 `remote-wsl:`。
`index.ts` 不在我的作用域 ⇒ **只报不改**。建议一行修：加同样的守卫（可直接 `import { withModulePrefix } from './explorer.ts'`，或等价内联）。
`src/index.ts` 其它 `remote-wsl:` 站点（L609/L999/L1291/L1358 等）是**自撰单前缀**或 `[remote-wsl: …]` 括号注记，**不是**本类问题。

## 7. 纪律与收尾

- 起实例全程 `Start-Process -WindowStyle Hidden` + 重定向；**本轮产生过的可见窗口 = 0**（本轮没走 compat 回退路径；T20 阶段那 1 个 compat 窗口已消失），**收尾时存在的我方可见窗口 = 0**（枚举只剩用户自己的 8 个窗口：Code/Cursor/DSH 宿主/Geph/Edge/QQ/输入法/微信）。
- 收尾：3091/3093 宿主已停；**8921 守护用插件自带路径停**（`node src/selftest.ts stop --port 8921` → `transport:"shutdown"`，不是全局 pkill）；`systemctl --user` 里 dsh-rwsl 单元 = **0**；8921–8930 上守护 = **0**；state 目录只剩 `daemon.log`/`launch-stderr.log`（均 `-rw-------`），`launch.*.sh` 残留 = **0**、`daemon.*.json` = **无**；两个临时 profile（`remote-wsl-test-p20` / `-p20bogus`）已删；未碰 19387/47604；未 `npm/pnpm install`。

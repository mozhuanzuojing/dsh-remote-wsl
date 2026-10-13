# T29 交付索引（交付维护脚本）

本目录是本轮（task-29）的**交付维护**工具，全部**只读**除自己目录外的一切（唯一例外：`sync-freeze-table.ps1 -Apply`，
且必须有 `FREEZE-TABLE` 标记对，而 README 现在还没有 ⇒ 实测会被拒绝）。

| 文件 | 一句话 | 常用命令 |
|---|---|---|
| `sync-freeze-table.ps1` | 从 `REVISION.txt` 的 `#@ANCHOR-BEGIN/END` 投影 README 冻结表；`-Mode Check` 逐字校验 13 锚点 | `pwsh -File sync-freeze-table.ps1` ／ `... -Mode Check` |
| `precommit-check.ps1` | 提交前清单 6 类 12 项，每项 PASS/FAIL/WARN + 原始输出 | `pwsh -File precommit-check.ps1`（`-SkipNetwork` 跳过 06） |
| `handoff-append.ps1` | 只追加地给交接文档加小节；`-Mode Check` 保证既有标题"只多不少" | `... -Mode Snapshot` ／ `-Mode Check` ／ `-Mode Apply -Title ... -Body ...` |
| `hygiene-rules.md` | 可整段粘进 README 的卫生清单（8 条，含本轮新沉淀的"量具自查"） | — |
| `NOTES-readme-markers.md` | README 需要加的标记、加在哪、加完怎么用（≤200 字 + 指引） | — |
| `snapshots/` | 交接文档标题序列基线（`handoff-append.ps1 -Mode Snapshot` 生成） | — |
| `out/` | 本轮全部原始输出（正向 + 故意红 + 幂等） | — |

## 退出码约定

| 脚本 | 0 | 1 | 2 |
|---|---|---|---|
| `sync-freeze-table.ps1` | 一致 / 已生成 | 校验不一致（并定位到行 + 第一个不同字符） | 用法错 / 拒绝改 README（无标记） |
| `handoff-append.ps1` | 成功 | 标题会丢（已回滚） | 用法错 / 同名标题拒绝 |
| `precommit-check.ps1` | 无 FAIL | 有 FAIL | 用法错 |

## 幂等与安全性（本轮实测）

- `sync-freeze-table.ps1 -Mode Generate` 连跑两次输出逐字相同；`-Mode Generate -Apply` 连跑两次文件哈希不变。
- `handoff-append.ps1 -Mode Apply` 自带两条断言：**原文本是新文本前缀** + **标题序列 before ⊆ after**；
  任一条不成立就回滚原字节并退出 1。
- 三个脚本都**不** `Start-Process`、**不** `detached`、**不**杀任何进程；端口只读探测；
  `precommit-check.ps1` 对 `19387`（用户宿主）**只报告 pid，绝不触碰**。

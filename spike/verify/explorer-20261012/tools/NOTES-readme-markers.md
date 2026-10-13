# README 需要加的标记与建议并入位置（T29 交付说明）

**要加的标记（一对，必须各自独占一行）**：

```
<!-- FREEZE-TABLE-BEGIN -->
| 文件 | 大小 | SHA256 |
|---|---:|---|
| `src/daemon-client.ts` | 50,702 | `4d5c2ebf…` |
… 13 行 …
<!-- FREEZE-TABLE-END -->
```

**加在哪**：只包 **当前（最新）那张** 冻结表——即 README 里**最后一张** `| 文件 | 大小 | SHA256 |` 表
（本次实测在 **第 676 行起**，内容 = P0.3 那张 13 行表）。
**历史冻结表**（P0 / P0.1 / P0.2，以及 0.1.0 原冻结集那段引用）**不要**加标记：
`-Mode Check` 取"最后一张含锚点路径的表"，加了也不会误判，但会让人误以为每张都要同步。

**加完之后的用法**：

- `sync-freeze-table.ps1 -Mode Check` —— 期望退出码 0（当前实测已 **13/13 PASS**，加标记不改变这一点）。
- `sync-freeze-table.ps1 -Mode Generate -Apply` —— 唯一会改 README 的路径；只替换标记之间，
  已实测**幂等**（连跑两次文件哈希不变）且标记外字节零改动。
- 没有标记时 `-Apply` **拒绝执行（退出码 2）并打印上面这段指引**，实测 README 哈希前后一致。

**建议并入位置（正文）**：README「版本 / 兼容性 / 冻结 revision」一节里，
把"复验必须以此做首尾双断言"那句后面补一行：
*"该表由 `spike/verify/explorer-20261012/tools/sync-freeze-table.ps1` 从 `REVISION.txt` 投影生成，
提交前用 `-Mode Check` 校验（13 锚点逐字一致）。"*

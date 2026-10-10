#!/usr/bin/env node
/**
 * verify/probe-shellenv.ts —— 不手抄、真跑已交付的 shell-env 实现，把它生成的片段原样取出来，
 * 交给 verify-shellenv.ps1 送进 WSL 执行（验证"登录 shell 环境注入在本机是否真的成功"）。
 *
 * 迁移说明（.mjs → .ts，零构建）：shell-env 实现是已交付模块，本文件不碰它、也不为它编造 .d.ts，
 * 只在本探针里声明"用到的那个签名"，让类型停留在调用点。
 *
 * ⚠ 导入路径的一次被动变更（非本任务引入，2026-10-10）：
 *   迁移前是 `../../lib/shell-env.js`；本 session 期间插件被重构成 `lib/` → `src/` 且该模块变成
 *   `src/shell-env.ts`（同一函数 `shellEnvSnippet({ enable })`），`lib/` 目录已不存在 ⇒
 *   原路径必然 `exists=False` 并让 verify-shellenv.ps1 在 A 段抛 ConvertFrom-Json 错。
 *   这里只把 import 指到新位置（不写 src/、不复制代码）；`.ts` 目标正是零构建相对导入要求的写法。
 */
import { shellEnvSnippet as rawSnippet } from '../../src/shell-env.ts';

/** `shellEnvSnippet` 在本探针里的签名（只声明用到的部分）。 */
type ShellEnvSnippet = (opts: { enable?: boolean }) => string;

const shellEnvSnippet = rawSnippet as unknown as ShellEnvSnippet;

const on: string = shellEnvSnippet({});
const off: string = shellEnvSnippet({ enable: false });
process.stdout.write(JSON.stringify({ snippet: on, len: on.length, disabledLen: off.length }) + '\n');

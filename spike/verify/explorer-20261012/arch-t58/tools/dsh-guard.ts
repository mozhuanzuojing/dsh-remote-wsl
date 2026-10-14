/**
 * dsh-guard.ts —— T70 的**共享隔离护栏**：凡在进程内 `import src/**`（尤其 `src/index.ts` + `apply()`）
 * 的工具，都必须在 import **之前**调用 `isolateDshHome()`，收尾调用 `assertGlobalWorkspaceUnchanged()`。
 *
 * 为什么必须"import 之前"：DSH 的存储根由 `DSH_HOME` 决定，而 `apply()` 之后被触发的
 * `workspaceRegistry.create()/resolveByPath()` 会把注册表写到 `$DSH_HOME/storages/workspace.json`。
 * 用默认 `DSH_HOME`（= 用户 `~/.dsh`）就是在改**用户的**文件（T46 A5 与 T67 各踩一次）。
 *
 * 用法（工具里 3 行）：
 *   import { isolateDshHome, assertGlobalWorkspaceUnchanged } from '../../arch-t58/tools/dsh-guard.ts';
 *   const guard = isolateDshHome('t70-smoke-e2e');   // ← 必须在任何 import src/** 之前
 *   …跑工具…
 *   guard.assertUnchanged();                          // ← 断言用户全局 workspace.json 前后同 sha
 *
 * 红测支持（**零风险**）：被观察路径可用环境变量 `T70_WATCH_WS` 覆盖 ⇒ 红测指向 `%TEMP%` 的**替身文件**，
 * 在替身上制造变化来证明"断言真的有牙"，**永不去碰真文件**。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface DshHomeGuard {
  isoHome: string;
  /** 被观察的注册表路径（默认用户全局；红测用 `T70_WATCH_WS` 指到替身） */
  watched: string;
  shaBefore: string | null;
  shaNow: () => string | null;
  /** 前后 sha 不同 ⇒ 抛错（判红） */
  assertUnchanged: () => void;
  cleanup: () => void;
}

const shaOf = (p: string): string | null => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null);

/** 被观察文件的路径（默认用户全局 `~/.dsh/storages/workspace.json`；`T70_WATCH_WS` 可指替身）。 */
export function watchedWorkspacePath(): string {
  return process.env.T70_WATCH_WS || join(homedir(), '.dsh', 'storages', 'workspace.json');
}

/**
 * **只断言**版（不改 `DSH_HOME`）：给那些**本来就自己设了孤立 home** 的工具补"前后 sha"闭环。
 * 用法：`const dshGuard = watchGlobalWorkspace();` … 收尾 `dshGuard.assertUnchanged();`
 */
export function watchGlobalWorkspace(): Omit<DshHomeGuard, 'isoHome' | 'cleanup'> {
  const watched = watchedWorkspacePath();
  const shaBefore = shaOf(watched);
  console.log(`[guard] 观察的注册表 = ${watched}  sha(前) = ${shaBefore?.slice(0, 16) ?? '(不存在)'}`);
  return {
    watched,
    shaBefore,
    shaNow: () => shaOf(watched),
    assertUnchanged() {
      const after = shaOf(watched);
      const same = shaBefore === after;
      console.log(`[guard] sha(后) = ${after?.slice(0, 16) ?? '(不存在)'} ⇒ 前后相同 = ${same}`);
      if (!same) throw new Error(`T70 隔离断言失败：${watched} 在本次运行中被改写（before=${shaBefore} after=${after}）`);
    },
  };
}

/**
 * 把 `DSH_HOME` 指到 `%TEMP%\<label>-home-<pid>` 并**记录被观察文件的 sha**。
 * ⚠️ 必须在 `import ... src/index.ts` 之前调用（模块在 import 期就可能捕获存储根）。
 */
export function isolateDshHome(label: string): DshHomeGuard {
  const isoHome = join(tmpdir(), `${label}-home-${process.pid}`);
  rmSync(isoHome, { recursive: true, force: true });
  mkdirSync(join(isoHome, 'storages'), { recursive: true });
  process.env.DSH_HOME = isoHome;
  const watched = process.env.T70_WATCH_WS || join(homedir(), '.dsh', 'storages', 'workspace.json');
  const shaBefore = shaOf(watched);
  console.log(`[guard] 孤立 DSH_HOME = ${isoHome}`);
  console.log(`[guard] 观察的注册表 = ${watched}  sha(前) = ${shaBefore?.slice(0, 16) ?? '(不存在)'}`);
  return {
    isoHome,
    watched,
    shaBefore,
    shaNow: () => shaOf(watched),
    assertUnchanged() {
      const after = shaOf(watched);
      const same = shaBefore === after;
      console.log(`[guard] sha(后) = ${after?.slice(0, 16) ?? '(不存在)'} ⇒ 前后相同 = ${same}`);
      if (!same) throw new Error(`T70 隔离断言失败：${watched} 在本次运行中被改写（before=${shaBefore} after=${after}）`);
    },
    cleanup() { rmSync(isoHome, { recursive: true, force: true }); },
  };
}

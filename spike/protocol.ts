/**
 * protocol.ts —— 守护（daemon）↔ 瘦客户端（client）之间的 NDJSON 线协议。
 *
 * **本文件是纯类型模块：只有 type / interface，没有一行运行时代码。**
 * 为什么这样定：守护跑在 WSL、客户端跑在 Windows，是两个互相独立的进程，
 * 不可能共用一个运行时对象；但两端必须共用同一套帧形状。把它们放进一个零运行时模块后，
 * 两端用 `import type { … } from './protocol.ts'` 引入 —— type stripping 会把整条 import 擦掉，
 * 于是既拿到了类型，又不会因为 import 把 daemon 拉起来（这一点比"从 daemon.ts 里 import type"
 * 更稳：即使擦除行为有出入，这里也只是引入一个空模块）。
 *
 * 协议原文（NDJSON，一行一条）：
 *   请求  {"id":1,"op":"prompt","key":"k1","text":"..."}
 *         {"id":2,"op":"status"}
 *         {"id":3,"op":"shutdown"}
 *   成功  {"id":1,"ok":true,"answer":"...","sessionId":"...","turns":2,"runtimePid":1234,"completedBy":"turn/end"}
 *   失败  {"id":1,"ok":false,"error":"..."}
 *
 * @module spike/protocol
 */

/** 客户端能发的三种操作。写成字面量联合而不是 string：拼错 op 是这套协议最常见的手滑。 */
export type DaemonOp = 'prompt' | 'status' | 'shutdown';

/** 客户端 → 守护 的请求帧。 */
export interface DaemonRequest {
  /** 客户端自选的关联 id，守护原样回显；缺失时守护回 id:null（不拒绝）。 */
  id?: number | null;
  op: DaemonOp;
  /** op=prompt 必填：守护按 key 持有运行时，同一个 key ⇒ 同一个 sessionId（上下文保留）。 */
  key?: string;
  /** op=prompt 必填：本轮用户输入。 */
  text?: string;
}

/**
 * 守护 → 客户端 的响应帧。
 * 字段按 op 分组成可选：prompt = answer/sessionId/turns/runtimePid/completedBy/eventCount；
 * status = daemonPid/…/keys；shutdown = reaped。这样一条接口同时描述三种回复，
 * 与守护 handle() 里"一个函数返回三种形状"的实现一一对应（不为了类型好看去拆成三个类）。
 */
export interface DaemonResponse {
  id: number | null;
  ok: boolean;
  /** ok:false 时必有人话错误（客户端原样打印，靠它就够定位）。 */
  error?: string;
  // ── op=prompt ──
  answer?: string;
  sessionId?: string;
  turns?: number;
  /** 运行时进程链的根 PID；运行时未起时为 null。 */
  runtimePid?: number | null;
  /** prompt() 的完成判据来源：turn/end | idle | quiet | quiet-after-grace | timeout。 */
  completedBy?: string;
  eventCount?: number;
  // ── op=status ──
  daemonPid?: number;
  daemonStartedAt?: number;
  uptimeMs?: number;
  port?: number;
  version?: string;
  cwd?: string;
  idleMs?: number;
  /** 每个 key 的公开视图（运行时对象本身不可序列化，必须剥掉）。 */
  keys?: DaemonKeyStatus[];
  // ── op=shutdown ──
  /** 回收前的 key 列表 —— 这份数据就是"shutdown 到底收掉了谁"的证据。 */
  reaped?: DaemonKeyStatus[];
}

/** `status` / `shutdown.reaped` 里单个 key 的公开视图（守护 publicKey() 的产物）。 */
export interface DaemonKeyStatus {
  key: string;
  sessionId: string | null;
  turns: number;
  runtimePid: number | null;
  /** 运行时 ready 的墙钟时间（ms）；未起为 null。 */
  startedAt: number | null;
  /** 距上次被使用的毫秒数 —— 用来看空闲回收是否快到了。 */
  idleForMs: number;
}

/**
 * 守护启动成功后 stdout 的**唯一**一条机器可读就绪行（其余诊断一律走 stderr）。
 * 单独建模的理由：run-spike.ps1 / verify-*.ps1 是拿它判"守护真的起来了"的，字段不能随意改。
 */
export interface DaemonReadyLine {
  ok: true;
  event: 'listening';
  host: string;
  port: number;
  pid: number;
  version: string;
  cwd: string;
  profile: string;
  idleMs: number;
  home: string;
}

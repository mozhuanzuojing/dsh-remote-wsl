/**
 * dsh-remote-wsl / command-policy —— Agent 发起命令的危险操作门禁。
 *
 * 参考：zai-org/... 的 `dsh-ssh-ops`（MIT，v0.4.3，commit bdf94ba）的
 * `src/safety.js` 与 `src/tools/ssh-session.js` 的 `tools/pre-execute` 审批模式。
 * 这里只吸收**命令分类 + 宿主审批**，不复制 SSH/SFTP/数据库能力，也不做输出脱敏。
 *
 * 设计边界：
 *  · 这是启发式 deny-list，不是完整沙箱；命中后由 DSH 宿主 `approval` 通道询问操作者；
 *  · 无审批通道 / 无 agent / 无 callId ⇒ **fail-closed**，不执行；
 *  · Agent 不能修改策略、不能自行放宽、被拒绝后不能靠重试或换写法绕过；
 *  · `wsl_agent` 是 WSL 内的完整 dsh agent，它的命令不经过本模块（README 必须明说）。
 */

export const name = 'dsh-remote-wsl-command-policy';
export const inject = [];

/** 运行策略：默认 standard；`off` 只允许操作者通过插件配置显式关闭。 */
const DEFAULT_POLICY = 'standard';

const CATEGORY_LABELS = Object.freeze({
  'delete-files': '删除文件或目录',
  'bulk-delete': '批量删除文件',
  'disk-format': '格式化或改写磁盘',
  'docker-destroy': '删除容器、镜像或卷',
  'deploy-destroy': '销毁已部署资源',
  'git-destructive': '不可恢复地清理代码工作区',
  'reboot-shutdown': '重启或关闭 WSL',
});

/** 顺序只影响展示的分类；命中即停。 */
const BLOCK_LIST = [
  // 先匹配更具体的批量/组合形式；最后才用裸 `rm`，避免把 `find -exec rm` 误归成 delete-files。
  [/\bfind\b[\s\S]*\s-delete\b/i, 'bulk-delete'],
  [/\bfind\b[\s\S]*\s-exec(?:dir)?\b[\s\S]*\b(?:rm|unlink)\b/i, 'bulk-delete'],
  [/\bxargs\b[^|;&]*\b(?:rm|unlink)\b/i, 'bulk-delete'],
  [/\brimraf\b/i, 'delete-files'],
  [/\b(?:python3?|perl|ruby|php|node)\b[\s\S]*\b(?:unlink(?:Sync)?|rmtree|rmSync|rimraf|os\.remove|shutil\.rmtree|fs\.rm(?:Sync)?|fs\.unlink(?:Sync)?)\b/i, 'bulk-delete'],
  [/\b(?:mkfs(?:\.|\b)|dd\b|wipefs\b|fdisk\b|parted\b|sgdisk\b)\b/i, 'disk-format'],
  [/\b(?:docker\s+(?:system\s+prune|container\s+prune|image\s+prune|volume\s+prune)|docker\s+(?:rm|rmi|volume\s+rm))\b/i, 'docker-destroy'],
  [/\b(?:kubectl\s+delete|helm\s+uninstall|terraform\s+destroy)\b/i, 'deploy-destroy'],
  [/\bgit\s+(?:reset\s+--hard|clean\b[\s\S]*?(?:-[a-z]*f|--force))/i, 'git-destructive'],
  [/\b(?:reboot|shutdown|poweroff|halt)\b/i, 'reboot-shutdown'],
  [/(?:^|[\s;&|])(?:rm|unlink|shred|rmdir)\b/i, 'delete-files'],
];

/** 返回一个稳定的拒绝原因（中文；宿主/UI 可原样展示）。 */
export function blockedReason(category) {
  return `该命令属于危险操作（${category}），需要操作者确认。请勿重试、换写法或绕行；如确需执行，请让操作者手动执行。`;
}

/**
 * 判断一条 WSL 命令是否需要操作者审批。
 * @param {unknown} command - `wsl_exec` / WSL preset `bash` 的命令参数
 * @returns {{ok: boolean, category?: string, categoryKey?: string, reason?: string}}
 */
export function assessWslCommand(command) {
  if (typeof command !== 'string') return { ok: false, category: '命令不是文本', categoryKey: 'invalid', reason: '命令参数不是文本，拒绝执行。' };
  const value = command.trim();
  if (value.length === 0) return { ok: true };
  for (const [pattern, categoryKey] of BLOCK_LIST) {
    if (!pattern.test(value)) continue;
    const category = CATEGORY_LABELS[categoryKey] ?? categoryKey;
    return { ok: false, category, categoryKey, reason: blockedReason(category) };
  }
  return { ok: true };
}

/** 兼容旧配置：未知值回落 standard，绝不放宽。 */
export function normalizePolicy(value) {
  return value === 'off' ? 'off' : DEFAULT_POLICY;
}

function callNext(next) {
  return typeof next === 'function' ? next() : undefined;
}

/**
 * 通过 DSH 宿主审批服务询问操作者。
 * @returns {Promise<'allowed-once'|'rejected'|'cancelled'|'unavailable'>}
 */
async function askOperatorApproval(ctx, execution, reason) {
  let approval;
  try {
    approval = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined;
  } catch {
    approval = undefined;
  }
  if (!approval || typeof approval.request !== 'function' || !execution?.agent || !execution?.callId) {
    return 'unavailable';
  }
  try {
    const outcome = await approval.request({
      agent: execution.agent,
      toolName: execution.name,
      callId: execution.callId,
      reason,
      signal: execution.signal,
    });
    return typeof outcome === 'string' ? outcome : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * 安装 `tools/pre-execute` 命令门禁。
 *
 * @param {object} ctx - Cordis 插件上下文
 * @param {{toolNames?: string[], commandPolicy?: string}} [config]
 * @returns {void}
 */
export function installCommandGate(ctx, config = {}) {
  if (typeof ctx?.on !== 'function') return;
  const toolNames = new Set(Array.isArray(config.toolNames) && config.toolNames.length ? config.toolNames : ['wsl_exec']);
  const policy = normalizePolicy(config.commandPolicy);
  if (policy === 'off') return;

  ctx.on('tools/pre-execute', (execution, next) => {
    if (!execution || !toolNames.has(execution.name)) return callNext(next);
    const command = execution.arguments?.command ?? execution.arguments?.cmd;
    const decision = assessWslCommand(command);
    if (decision.ok) return callNext(next);

    return (async () => {
      const reason =
        `AI 请求在 WSL 中执行危险命令（${decision.category ?? decision.reason}）：\n` +
        `${String(command)}\n` +
        '批准=本次执行；拒绝=命令不会运行；当前没有审批通道时按拒绝处理。';
      const outcome = await askOperatorApproval(ctx, execution, reason);
      if (outcome === 'allowed-once' || outcome === 'allow') return callNext(next);
      if (outcome === 'rejected') {
        return {
          kind: 'deny',
          reason: '操作者拒绝了该危险命令。请勿重试或换写法绕行；如确需执行，请让操作者手动执行。',
        };
      }
      if (outcome === 'cancelled') {
        return { kind: 'deny', reason: '危险命令的确认被取消，命令未执行。请勿重试。' };
      }
      return {
        kind: 'deny',
        reason: '该命令属于危险操作，必须由操作者确认；当前宿主没有可用的审批通道，命令未执行。请让操作者手动执行。',
      };
    })();
  });
}

/** 作为 WSL preset 子插件使用时的入口。 */
export function apply(ctx, config = {}) {
  installCommandGate(ctx, config);
}

/**
 * dsh-remote-wsl / plugin-version —— **插件版本 + 协议版本**的唯一来源。
 *
 * 为什么必须有协议版本（2026-10-27 换角度评审第 1 条）：
 * 守护是 `detached` 起的、宿主退出/升级都不会杀它 —— 所以「**新宿主 + 旧守护**」是**必然出现**的
 * 组合，不是异常。旧守护不认识新 op（v0.1.1 新增的 `fs.readChunk`）时只会报 `unknown method`；
 * `meta.retired` 这类新字段缺失又会让"上下文已重置"的提示静默失效。有了这两个字段，宿主才能
 * 明确告诉用户"守护是旧版，restart 后生效"，而不是让人对着报错猜。
 *
 * 规则：**协议加减字段就 +1**。宿主与守护不一致时按兼容性处理（见 daemon-launch.ts 的 configCompat）：
 *  · 守护协议 < 宿主 ⇒ soft：可复用，但新功能在 restart 前不可用；
 *  · 守护协议 > 宿主 ⇒ hard：宿主比守护旧，拒绝复用（否则会用错协议）。
 *
 * @module dsh-remote-wsl/plugin-version
 */
import { readFileSync } from 'node:fs';

/**
 * 协议版本：守护与宿主之间的 op/字段集合版本。改协议记得 +1。
 *
 * v2（0.3.0，2026-10-27 第三轮）：`fs.listDir` 的每个 entry 增加 `targetKey`（**链接已 realpath 的
 * 稳定身份**），`type` 改为跟随链接（`ln -s /etc d` 现在报 `directory`，旧守护报 `other`）。
 * 这是**加法**：宿主对缺失 `targetKey` 有回退（退回 `path.posix.join`），所以新宿主 + 旧守护仍可用，
 * 只是符号链接语义还是旧的 —— 正好由「守护协议 < 宿主 ⇒ soft，restart 后生效」表达。
 *
 * v3（0.3.4，2026-10-28 独立复核 A-P1-A）：守护身份（meta / status / hello）统一上报
 * `provider` / `model` / `useShellEnvironment` / `proxyPort`，`prompt` 请求可携带 `provider` / `model`
 * 且不一致时**明确拒绝**。动机：401 那轮把 provider/model 接到了启动参数，但只对「新起守护」生效 ——
 * 改配置后重启 DSH 会静默复用旧守护、继续用旧 provider（同症状、零告警）。旧守护缺这些字段时
 * 宿主按「未上报」处理（soft 提示 restart），不会硬阻塞。
 */
export const PROTOCOL_VERSION = 3;

/**
 * 插件自身版本（取自本仓 package.json；`link:` 安装时就是工作树那一份）。
 * 读不到就返回 `unknown` —— 版本号是诊断信息，不该让插件因此加载失败。
 */
export const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg?.version ?? 'unknown');
  } catch {
    return 'unknown';
  }
})();

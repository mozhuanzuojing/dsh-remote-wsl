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

/** 协议版本：守护与宿主之间的 op/字段集合版本。改协议记得 +1。 */
export const PROTOCOL_VERSION = 1;

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

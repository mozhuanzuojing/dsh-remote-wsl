/* usab-p0scope.js —— M11：**P0 范围偏差/缺口探针**（lead Q3 裁定的直接落地）。
 *
 * 为什么单独一个文件：这一条问的不是"好不好用"，而是"**该有的有没有、不该有的有没有**"。
 *   - 缺口（G-*）：设计线框 §2/§3/§6 里出现、但真界面没有 ⇒ 按 lead 裁定**不扣缺陷分**，只记"P1 待补"+成本；
 *   - 偏差（X-*）：实现与设计稿**不一致（任一方向）** ⇒ **必记**；其中"实现超出设计 P0 范围"（起停/重启/drift 修复）
 *     会在 M6 里把"不可逆动作确认"从 not-applicable 变成**有对象**。
 *
 * 用法：chrome-devtools-mcp evaluate_script 的 function 参数（原样粘贴）→ out-15-p0scope.json
 * 判据是**逐项 present/missing + 命中文本**，不靠人眼扫截图；人眼只用来看"长得像不像"（shot-09）。
 */
() => {
  const scope = document.querySelector('[data-dsh-remote-wsl="panel"]') || document.body;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const txt = (el) => ((el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim();

  // 页面内所有可见控件（含 hover 才出现的：这里用 DOM 存在性而非可见性做二次判定，避免漏报）
  const controls = Array.from(scope.querySelectorAll('button,select,input,a[href],[role="button"],[role="menuitem"],[role="tab"],summary'));
  const visible = controls.filter(vis);
  const all = controls.map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: txt(el).slice(0, 120),
    title: el.getAttribute('title'),
    ariaLabel: el.getAttribute('aria-label'),
    visible: vis(el),
    disabled: el.disabled === true
  }));

  // 设计稿 §2 线框 / §3 挂点 / §6 P0 的逐项名单
  const EXPECT = [
    { id: 'G-1', what: '＋ 添加收藏路径', re: /添加|＋|\+ ?路径|新增/, design: '§2 线框有 ＋；§6 P1 才列 ＋/－ ⇒ 缺口', kind: 'gap' },
    { id: 'G-2', what: '在终端中打开', re: /终端中打开|在终端/, design: '§2 线框的每行 hover 动作；§6 P0 未列 ⇒ 缺口', kind: 'gap' },
    { id: 'G-3', what: '从列表移除', re: /移除|删除|remove/, design: '§2 线框；§6 P0 未列 ⇒ 缺口', kind: 'gap' },
    { id: 'G-4', what: '⋯ 更多菜单', re: /⋯|更多|more/i, design: '§2 线框；§6 P0 未列 ⇒ 缺口', kind: 'gap' },
    { id: 'G-5', what: 'settings.section 配置页', re: /设置|settings|偏好/i, design: '§3 标 **P1** ⇒ 缺口', kind: 'gap' },
    { id: 'G-6', what: '打开 Web UI 窗口', re: /打开\s*UI|web\s*窗口|Web UI|浏览器/i, design: '§5 交互表有 explorer.openUi；§6 P0 未列 ⇒ 缺口', kind: 'gap' },
    { id: 'X-1', what: '起停守护（P1 项，实现不得超出 P0 范围）', re: /启动守护|重启|停止|stop|restart/i, design: '§6  P1 ⇒ 若存在 = **偏差**（必记）', kind: 'deviation' },
    { id: 'X-1b', what: 'drift 修复按钮', re: /修 ?pin|修复/i, design: '§6 P1 ⇒ 若存在 = **偏差**', kind: 'deviation' },
    { id: 'X-2', what: '⟳ 刷新', re: /刷新|refresh|重新读取/i, design: '§2 线框有 ⟳', kind: 'deviation' },
    { id: 'P-1', what: '在新会话中打开（P0 承诺的动作）', re: /在新会话中打开|打开/i, design: '§2/§5 P0 主动作', kind: 'promised' },
    { id: 'P-2', what: '刷新（P0 承诺的控件）', re: /刷新/i, design: '§6 P0「顶部 刷新」', kind: 'promised' },
    { id: 'P-3', what: '重试（错误态出口）', re: /重试|retry/i, design: '§6 P0「错误态」', kind: 'promised' }
  ];

  const probe = EXPECT.map((e) => {
    const hits = all.filter((c) => e.re.test([c.text, c.title, c.ariaLabel].filter(Boolean).join(' ')));
    return {
      id: e.id,
      what: e.what,
      kind: e.kind,
      design: e.design,
      present: hits.length > 0,
      visibleHits: hits.filter((c) => c.visible).length,
      hits: hits.slice(0, 6)
    };
  });

  // 树行内动作的可见性（对照项：VS Code 的 inline 动作是 hover 才显现，"hover 才可见"本身不算缺陷）
  const rowActions = Array.from(scope.querySelectorAll('.dsh-rw-workspace-actions button, .dsh-rw-workspace button'))
    .map((el) => ({ text: txt(el).slice(0, 60), visible: vis(el), title: el.getAttribute('title'), disabled: el.disabled === true }));

  return {
    schema: 'usab-p0scope/1',
    capturedAt: new Date().toISOString(),
    url: location.href,
    panelPresent: document.querySelector('[data-dsh-remote-wsl="panel"]') !== null,
    probe,
    summary: {
      gapsMissing: probe.filter((p) => p.kind === 'gap' && !p.present).map((p) => p.id),
      gapsPresent: probe.filter((p) => p.kind === 'gap' && p.present).map((p) => p.id),
      deviationsPresent: probe.filter((p) => p.kind === 'deviation' && p.present).map((p) => p.id),
      promisedMissing: probe.filter((p) => p.kind === 'promised' && !p.present).map((p) => p.id),
      // 只有 promisedMissing 才是"P0 承诺了却没做到"⇒ 可扣分的依据（lead 口径）
      verdictHint: probe.filter((p) => p.kind === 'promised' && !p.present).length
        ? 'P0 自身承诺缺失：' + probe.filter((p) => p.kind === 'promised' && !p.present).map((p) => p.id).join(',')
        : 'P0 承诺项齐全'
    },
    controlsInPanel: all.length,
    visibleControlsInPanel: visible.length,
    rowActions,
    rowActionsVisibleWithoutHover: rowActions.filter((a) => a.visible).length,
    allControlTexts: all.map((c) => c.text).filter(Boolean).slice(0, 200)
  };
}

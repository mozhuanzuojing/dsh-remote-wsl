/**
 * client.api.js —— dsh-remote-wsl client 半的**传输层唯一出口**。
 *
 * 为什么文件名是 `client.api.js` 而不是 `api.ts`：
 * 静态 `dsh.client` bundle 的模块表（@deepseek-ai/dsh-client-modules）只允许两种东西存在——
 * ① 由 `exports["./client"]` 指到的入口脚本；② **包内懒加载 chunk**，而 chunk 的文件名被
 * `CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` 钉死，且运行时由
 * `join(dirname(clientPath), fileName)` 定位（client-modules/lib/index.js:168,938；
 * client-modules/lib/client.js:470,717）。所以「一个关注点一个文件」只能以
 * `client.<name>.js` 的形式落地，`api.ts` / `icon.ts` / `panel.ts` 这种文件名**平台不支持**。
 *
 * 通道（由 host 半 src/explorer.ts 提供，见 task-2 交接）：
 *   POST /remote-wsl/api  { method, args }  → 200 { ok: true, result } | { ok: false, error }
 *   GET  /remote-wsl/api                    → 200 { ok: true, methods: string[] }
 * 同源页面直接 fetch（浏览器自带 cookie；webServer 的 Host/Origin 信任闸门照常生效）。
 *
 * 注意：这里**没有** `host.call`。`host.call(method,args)` 是**动态包**浏览器半的内建
 * （见 @deepseek-ai/dsh-cordis-client-runner/lib/client.js:54,157 的 closure 参数表），
 * 静态 `dsh.client` bundle 里不存在；动态包又只能渲染进自己的工具卡、进不了侧栏。
 *
 * ★ 可靠性：每次调用都带**超时**（AbortController + setTimeout；路由被挂住不会让 UI 永久 loading），
 *   并接受调用方传入的 `signal`（面板在卸载/被新读取取代时 abort 在飞请求）。
 *   抛出的 ExplorerApiError 用 `kind` 区分：transport / timeout / aborted / protocol / host / unknown-method / argument。
 */

window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	chunk: "client.api.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** host 半 explorer 路由。改这里就是改全客户端唯一的网络出口。 */
		const EXPLORER_ROUTE = "/remote-wsl/api";

		/** 单次调用超时：路由被挂住/网关卡住时，UI 必须在可预期时间内进"读失败"态。 */
		const REQUEST_TIMEOUT_MS = 9000;

		/**
		 * 契约里的方法名（逐字）。
		 * ⚠ **这里不是权威**：权威是 host 的 `src/explorer.ts` → `EXPLORER_METHODS`（T4，2026-10-13）。
		 * 手写 bundle 有**零构建**约束（不能 import host、不能跑生成器），所以这里只能保留一份
		 * **字面量投影**；一致性由两道机械门禁保证，不靠人记：
		 *   · `spike/verify/explorer-20261012/arch-t2/tools/check-docs-methods.mjs`（跨任务门禁，断言 client ≡ host）
		 *   · `spike/verify/explorer-20261012/arch-t4/tools/check-explorer-methods.ts`（`--check` 比对 / `--print` 再生成）
		 * 顺序与 host 相同；**改 host 必须同步这里**，否则两道门禁一起红。
		 */
		const METHODS = Object.freeze({
			snapshot: "explorer.snapshot",
			openSession: "explorer.openSession",
			daemon: "explorer.daemon",
			fixPin: "explorer.fixPin",
			listDir: "explorer.listDir",
			addWorkspace: "explorer.addWorkspace",
			newSession: "explorer.newSession",
		});

		/** 上表的**投影视图**（唯一用途：让自检/探针脚本按同一来源比对 host 的 `EXPLORER_METHODS`）。 */
		const METHOD_NAMES = Object.freeze(Object.values(METHODS));

		/** daemon 动作白名单。UI 侧不存在 `stop all=true` 这类会连带他人的动作。 */
		const DAEMON_ACTIONS = Object.freeze(["ensure", "stop", "restart"]);

		/**
		 * 故意不存在的方法名：host 对未知方法回 400 + `{ methods }`（src/explorer.ts:530），
		 * 于是它能当"路由是否活着 + 方法清单"的探针用（GET 在浏览器里走不通，见 request()）。
		 */
		const EXPLORER_METHODS_PROBE = "explorer.__probe__";

		/**
		 * 一次 explorer 调用的失败。`kind` 区分「传输没到」「超时」「调用方取消」「host 说不行」
		 * 「协议不成形」，面板据此决定文案与是否重试。
		 */
		class ExplorerApiError extends Error {
			constructor(message, kind, detail) {
				super(message);
				this.name = "ExplorerApiError";
				this.kind = kind;
				this.detail = detail;
			}
		}

		function describe(error) {
			if (error instanceof Error) return error.message;
			return String(error);
		}

		/** 解析响应体：优先 JSON；不是 JSON 就保留原文，便于错误态直接读给人看。 */
		async function readBody(response) {
			const text = await response.text();
			if (!text.length) return { json: null, text: "" };
			try {
				return { json: JSON.parse(text), text };
			} catch {
				return { json: null, text };
			}
		}

		/**
		 * A4：文案走注入的 `t`（由 client.i18n.js 造）。缺省时回落中文原句 ——
		 * 这样 api.js 被脚本/探针直接 require 时行为不变（不把键名当文案）。
		 */
		const FALLBACK_TEXT = {
			"api.timeout": (p) => `explorer 请求超时：${p.ms}ms 内 ${p.route} 没有响应（路由被挂住，或网关卡住）。`,
			"api.aborted": (p) => `${p.route} 的调用已被取消（面板卸载或已有更新的读取）。`,
			"api.abortedBeforeStart": (p) => `${p.route} 的调用在发起前已被取消。`,
			"api.transport": (p) => `无法连接 host 侧 explorer 路由 ${p.route}：${p.detail}`,
			"api.protocol": (p) => `${p.route} 返回了非 JSON 响应（HTTP ${p.status}）：${p.text}`,
			"api.hostFailed": (p) => `explorer 调用失败（HTTP ${p.status}）`,
			"api.argument": (p) => `explorer 调用缺少必填字段 ${p.field}`,
			"api.daemonAction": (p) => `explorer.daemon 不接受动作 ${p.action}（只允许 ${p.allowed}）`,
		};
		const fallbackTranslate = (key, params) => (FALLBACK_TEXT[key] ? FALLBACK_TEXT[key](params || {}) : key);

		/**
		 * 文本里的 **URL 凭据脱敏**（F-37，安全级）：`?token=` / `&access_token=` 的值换成 `***`，
		 * 保留 host:port 与其余参数。
		 *
		 * 为什么 client 侧还要做一遍：host 的 `snapshot.webHosts[].url` 已经脱敏（第一道），
		 * 但面板"复制诊断"复制的是**整份 JSON**，任何未来新增的 URL 字段/历史缓存/其它来源都可能
		 * 再带出凭据 ⇒ 在**渲染与复制这两个出口**统一过一遍，避免"又有人加了字段就漏"。
		 * 纯函数（不碰 DOM/网络），可在脚本里直接断言。
		 *
		 * @param text 任意文本（JSON 串/URL）
		 * @returns 脱敏后的文本（非字符串输入先 String()，null/undefined ⇒ 空串）
		 */
		function redactSecrets(text) {
			if (text === null || text === undefined) return "";
			return String(text).replace(/([?&][A-Za-z0-9_-]*token=)[^&#\s"']*/gi, "$1***");
		}

		/**
		 * 发一次请求并归一化结果。
		 *
		 * 只用 POST：面板与 host 的契约是"POST 调用 + GET 只做方法发现"，换通道要同时改方法表、
		 * 参数体与两侧门禁，收益为零。2026-10-21 更正旧理由（原文断言"webServer 闸门要求请求带
		 * Origin，同源 GET 不带 Origin ⇒ 403"）：host 闸门现在与官方 `dsh-client-connection` 的
		 * `admit()` 同策略 —— `Origin` 缺失时放行（DSH Desktop 的 `dsh-app://app` 转发会剥掉
		 * Origin），只拒绝 `cross-site` 与非同源 Origin；GET 因此也可用了，但面板仍走 POST。
		 * 实测（2026-10-12，3091 实例；闸门修正见 docs/remote-explorer-design.md §4(a)）：
		 *   GET  无 Origin → 旧实现 403；2026-10-21 起放行（只回方法清单，零副作用）
		 *   POST 带 Origin → 200 {"ok":true,"result":{…}}
		 * @param method - 契约方法名。
		 * @param args - 命名参数对象（host 侧按名字取）。
		 * @param options - 可选 `{ signal }`：调用方生命周期（面板卸载/被新读取取代时 abort）。
		 */
		async function request(method, args, options, translate) {
			const tr = typeof translate === "function" ? translate : fallbackTranslate;
			const external = options && options.signal ? options.signal : undefined;
			if (external !== undefined && external.aborted) {
				throw new ExplorerApiError(tr("api.abortedBeforeStart", { route: EXPLORER_ROUTE }), "aborted");
			}
			const hasAbort = typeof AbortController === "function";
			const controller = hasAbort ? new AbortController() : null;
			let timedOut = false;
			let timer = null;
			const onExternalAbort = () => {
				if (controller !== null && !controller.signal.aborted) controller.abort();
			};
			if (controller !== null) {
				// 超时：到点即 abort，UI 进"读失败（超时）"，不会永久 loading。
				timer = setTimeout(() => {
					timedOut = true;
					if (!controller.signal.aborted) controller.abort();
				}, REQUEST_TIMEOUT_MS);
				if (external !== undefined && typeof external.addEventListener === "function") {
					external.addEventListener("abort", onExternalAbort, { once: true });
				}
			}
			const init = {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify({ method, args: args === undefined ? {} : args }),
			};
			if (controller !== null) init.signal = controller.signal;
			let response;
			try {
				response = await fetch(EXPLORER_ROUTE, init);
			} catch (error) {
				if (timedOut) {
					throw new ExplorerApiError(
						tr("api.timeout", { ms: REQUEST_TIMEOUT_MS, route: EXPLORER_ROUTE }),
						"timeout",
						error,
					);
				}
				if (controller !== null && controller.signal.aborted) {
					throw new ExplorerApiError(tr("api.aborted", { route: EXPLORER_ROUTE }), "aborted", error);
				}
				throw new ExplorerApiError(tr("api.transport", { route: EXPLORER_ROUTE, detail: describe(error) }), "transport", error);
			} finally {
				if (timer !== null) clearTimeout(timer);
				if (external !== undefined && typeof external.removeEventListener === "function") {
					external.removeEventListener("abort", onExternalAbort);
				}
			}
			const { json, text } = await readBody(response);
			if (json === null) {
				throw new ExplorerApiError(tr("api.protocol", { route: EXPLORER_ROUTE, status: response.status, text: text.slice(0, 400) }), "protocol", {
					status: response.status,
					text,
				});
			}
			if (json.ok !== true) {
				const message = typeof json.error === "string" && json.error.length ? json.error : tr("api.hostFailed", { status: response.status });
				// host 半对未知方法是 **400**（src/explorer.ts:530，不是 404），404 留给"路由没注册"。
				const kind = Array.isArray(json.methods) ? "unknown-method" : response.status === 404 ? "route-missing" : "host";
				throw new ExplorerApiError(message, kind, json);
			}
			if (!("result" in json)) {
				// 防御：契约里每次成功调用都带 result；缺了就原样交回调用方判。
				return json;
			}
			return json.result;
		}

		/** 断言必填字段，避免把 undefined 当成合法输入发给 host。 */
		function requireString(value, field, translate) {
			if (typeof value !== "string" || value.length === 0) {
				throw new ExplorerApiError((typeof translate === "function" ? translate : fallbackTranslate)("api.argument", { field }), "argument");
			}
			return value;
		}

		/**
		 * 建一个 api 句柄。面板永远只说 api.snapshot()/api.openSession(...)，不自己拼 URL/JSON。
		 * 每个方法都接受可选的 `{ signal }`（面板的生命周期/取代信号）。
		 * @returns 冻结的 api 对象（含 route 与 methods，便于错误态把它显示出来）。
		 */
		function createExplorerApi(i18n) {
			const t = i18n && typeof i18n.t === "function" ? i18n.t : fallbackTranslate;
			/**
			 * 面板当前选中的目标发行版（null = 用 host 配置里的缺省）。
			 * 面板切换时调 setDistro() 写入；每次调用自动带上，五个方法都不必各自拼参数。
			 * 语义：只影响本面板的请求，不写 host 配置（host 侧对每个请求各自校验名字）。
			 */
			let distro = null;
			/** 统一入口：把本包的 t 与当前目标发行版透给 request。 */
			const call = (method, args, options) => {
				const base = args && typeof args === "object" ? args : {};
				const merged = distro === null ? base : Object.assign({}, base, { distro });
				return request(method, merged, options, t);
			};
			const api = {
				route: EXPLORER_ROUTE,
				methods: METHODS,
				daemonActions: DAEMON_ACTIONS,
				timeoutMs: REQUEST_TIMEOUT_MS,
				/** 诊断/剪贴板出口的凭据脱敏（F-37）：面板渲染 `<pre>` 与"复制诊断"都用同一个实现。 */
				redactSecrets,

				/** 设置/清除目标发行版（null/空串 = 回到 host 配置缺省）。 */
				setDistro(name) {
					distro = typeof name === "string" && name.length > 0 ? name : null;
				},
				getDistro() {
					return distro;
				},

				/** POST 探测：host 注册了路由就会以 `{ok:false, methods:[…]}` 回 400，读回方法清单。 */
				methodCatalogue(options) {
					return call(EXPLORER_METHODS_PROBE, {}, options).then(
						() => METHODS,
						(error) => {
							const detail = error && error.detail;
							const list = detail && Array.isArray(detail.methods) ? detail.methods : null;
							if (list !== null) return list;
							throw error;
						},
					);
				},

				/** → { distros, target, daemon, drift, workspaces, webHosts } */
				snapshot(options, extras) {
					const args = extras && extras.refresh === true ? { refresh: true } : {};
					return call(METHODS.snapshot, args, options);
				},

				/**
				 * A1：把一个 WSL 目录**登记为工作区**（host 半由 host-explorer 实现，契约见 task-23）。
				 * `{path, title?}` → `{ok,id,title,uncPath,alreadyExisted}`；失败走 host 的机器可读
				 * code（`E_ARG`/`E_NOTFOUND`/`E_UNAVAILABLE`）。
				 * 语义提醒：工作区路径是 **UNC ⇒ 文件工具经 9P**，与 `openSession` 的"远端会话"是两条路。
				 */
				/**
				 * 建一个**真正的 DSH 会话**（cwd = 该 WSL 路径的 UNC）；返回 { ok, sessionId, cwd }。
				 * 与 openSession 的区别：openSession 只碰 WSL 侧守护，不产生 DSH 会话。
				 */
				newSession(input, options) {
					const path = requireString(input && input.path, "path", t);
					return call(METHODS.newSession, { path }, options);
				},
				addWorkspace(input, options) {
					const path = requireString(input && input.path, "path", t);
					const args = { path };
					if (input && typeof input.title === "string" && input.title.length) args.title = input.title;
					return call(METHODS.addWorkspace, args, options);
				},

				/**
				 * 附到 (distro,path) 的会话。P0 语义：**不预热**——已物化就复用，
				 * 否则 `sessionId: null` + note，界面必须如实显示（不许假装开好了）。
				 */
				openSession(input, options) {
					// ★ F-39：`distro` 这条必填校验**漏传 t** ⇒ 英文界面会弹出中文 fallback 文案
					// （FALLBACK_TEXT 是"没有 i18n 时"的兜底，不该在这条路径生效）。
					const distro = requireString(input && input.distro, "distro", t);
					const path = requireString(input && input.path, "path", t);
					return call(METHODS.openSession, { distro, path }, options);
				},

				/** 守护动作。slot 只在明确给出时透传；**没有** all/bulk 语义。 */
				daemon(input, options) {
					const action = input && input.action;
					if (DAEMON_ACTIONS.indexOf(action) < 0) {
						// ★ F-39：这句原本是硬编码中文（英文界面照样出中文）。走 i18n，detail 里带原值。
						throw new ExplorerApiError(t("api.daemonAction", { action: JSON.stringify(action), allowed: DAEMON_ACTIONS.join("/") }), "argument");
					}
					const args = { action };
					if (input && typeof input.slot === "number") args.slot = input.slot;
					return call(METHODS.daemon, args, options);
				},

				/**
				 * 修 version pin（对齐 `wsl_sync_version` 的 warm+pin；不自动杀守护）。
				 *
				 * T4 决议（2026-10-13）：**host 侧是活表面** —— 它在 `EXPLORER_METHODS` 六方法白名单里、
				 * 有实现（`src/explorer.ts` `fixPin()`）、被 README/设计稿 §4 列出，删它会让
				 * `check-docs-methods.mjs`（host=6）与设计稿方法表一起红 ⇒ **保留，并把用途写清**。
				 * 本包装当前**没有调用者**（面板的 drift 修复入口在 T23/T25 轮被撤下；`rg fixPin client/`
				 * 只剩本文件三处 + `client.i18n.js` 四个 `status.fixPin*` 死键）⇒ 属于"host 活 / client 无门"
				 * 的状态：保留包装是为了面板随时可重新露出，死键清理见 T6（本任务写域不含 panel/i18n）。
				 */
				fixPin(options) {
					return call(METHODS.fixPin, {}, options);
				},

				/**
				 * 列**一层** WSL 目录（A3 目录浏览器）。
				 * 契约（lead 2026-10-12 裁决）：`{ path }` → `{ path, distro, entries:[{name,kind,hidden}] }`；
				 * **一次返回全部条目（含隐藏）**，隐藏文件过滤在 client 侧做（切换即时、不重发请求）。
				 * 只读、零副作用；host 侧不启动发行版。
				 */
				listDir(input, options) {
					const path = requireString(input && input.path, "path", t);
					return call(METHODS.listDir, { path }, options);
				},
			};
			return Object.freeze(api);
		}

		exports.ExplorerApiError = ExplorerApiError;
		exports.EXPLORER_ROUTE = EXPLORER_ROUTE;
		exports.REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
		exports.EXPLORER_METHODS = METHODS;
		exports.METHOD_NAMES = METHOD_NAMES;
		exports.createExplorerApi = createExplorerApi;
		exports.redactSecrets = redactSecrets;
		return module.exports;
	},
});

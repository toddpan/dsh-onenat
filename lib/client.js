window.__ModuleLoader__.load({
	id: "@dsh-external/onenat-workbuddy-mention",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region src/client/index.ts
		/**
		* @dsh-external/onenat-workbuddy-mention — DSH Web GUI 集成
		*
		* 只有两件事，都在 DSH 原生界面里：
		*   1. `@` 输入触发源（ctx.inputTriggers）：候选 = ONENAT 子智能体 + ONENAT 资源 + 本地 SSH 资源；
		*      选中插入原子胶囊，提交时由本插件的 codec 序列化为 `@[名称](onenat-agent:…)`，
		*      宿主在 agent/pre-step 解析回结构化身份。
		*   2. 设置页 management UI（settings.section）：子智能体 / 资源目录 / 本地 SSH 资源池 的可视化管理。
		*
		* 不注册侧栏入口、不劫持中央列、不内嵌 iframe —— 对话与工具卡全部复用 DSH 原生能力。
		*/
		const inject = ["slots"];
		/**
		* 静态 bundle 工厂只拿到 require —— 动态插件专属的 `styles` 闭包全局在这里
		* 不存在。自己插 <style>，按平台 data-plugin / data-plugin-css 约定打标
		* （重复加载时按 tagId 去重），返回卸载清理函数。
		*/
		function insertStyles(css) {
			const tagId = `${NS}/client.css`;
			let tag = document.querySelector(`style[data-plugin-css="${tagId}"]`);
			if (tag === null) {
				tag = document.createElement("style");
				tag.dataset.plugin = NS;
				tag.dataset.pluginCss = tagId;
				tag.textContent = css;
				document.head.appendChild(tag);
			}
			return () => {
				tag.remove();
			};
		}
		const NS = "onenat-workbuddy-mention";
		const STATUS = {
			listeners: /* @__PURE__ */ new Set(),
			snapshot: {
				state: "waiting",
				sourceRegistered: false,
				agentCount: 0,
				resourceCount: 0,
				detail: "正在等待 inputTriggers 服务…"
			},
			subscribe(listener) {
				STATUS.listeners.add(listener);
				return () => {
					STATUS.listeners.delete(listener);
				};
			},
			get() {
				return STATUS.snapshot;
			},
			set(patch) {
				STATUS.snapshot = {
					...STATUS.snapshot,
					...patch
				};
				for (const listener of STATUS.listeners) try {
					listener();
				} catch {}
			}
		};
		/**
		* 管理 API 前缀：由 Host 注入到 index.html（插件为普通 bundle，浏览器半边走同源 HTTP）。
		*/
		function apiPrefix() {
			const injected = globalThis.__DSH_ONENAT_WORKBUDDY__;
			const prefix = injected && typeof injected.pathPrefix === "string" ? injected.pathPrefix : "/onenat-workbuddy-mention";
			return String(prefix).replace(/\/+$/, "");
		}
		/** 同源管理 API 调用：统一信封 { ok, data?, error? } */
		async function api(path, init) {
			const response = await globalThis.fetch(`${apiPrefix()}${path}`, {
				method: init?.method || "GET",
				...init?.body === void 0 ? {} : {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(init.body)
				}
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok || payload?.ok === false) throw new Error(String(payload?.error || `HTTP ${response.status}`));
			return payload?.data;
		}
		function createMentionSource(log, onCounts) {
			/** 最近一次候选快照：warm/candidates 写入，lexicon/onPick 同步读取 */
			let snapshot = [];
			let lexicon;
			const listeners = /* @__PURE__ */ new Set();
			const publish = (rows) => {
				snapshot = rows;
				lexicon = rows.length > 0 ? rows.map((r) => r.name) : void 0;
				onCounts?.({
					agentCount: rows.filter((r) => r.kind === "agent").length,
					resourceCount: rows.filter((r) => r.kind === "resource").length
				});
				for (const listener of listeners) try {
					listener();
				} catch {}
			};
			const hostCandidates = async (query) => {
				const rows = await api(`/api/candidates?q=${encodeURIComponent(query)}`);
				return Array.isArray(rows) ? rows : [];
			};
			const source = {
				trigger: "@",
				name: "onenat",
				order: 2,
				showGroupTitle: false,
				async candidates(_session, req) {
					const query = String(req?.query ?? "");
					try {
						if (query === "" && snapshot.length > 0) return rows(snapshot);
						const rowsNow = await hostCandidates(query);
						if (query === "") publish(rowsNow);
						return rows(rowsNow);
					} catch (err) {
						log(`候选拉取失败：${err?.message || err}`);
						STATUS.set({
							state: "error",
							detail: `候选拉取失败：${err?.message || err}`
						});
						return [];
					}
				},
				warm() {
					hostCandidates("").then((rowsNow) => publish(rowsNow)).catch((err) => log(`预热失败：${err?.message || err}`));
				},
				lexicon() {
					return lexicon;
				},
				subscribeLexicon(_session, listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				onPick(pick) {
					const uri = String(pick?.candidate?.value || "");
					const name = String(pick?.candidate?.name || "");
					if (!uri) return void 0;
					return { insert: {
						source: "onenat",
						ref: uri,
						label: name,
						clipboardText: `@[${name}](${uri})`
					} };
				},
				codec: {
					clipboardText: (ref) => `@[${labelOf(ref)}](${ref})`,
					serialize: (ref) => Promise.resolve(`@[${labelOf(ref)}](${ref})`)
				}
			};
			const labelOf = (ref) => {
				return snapshot.find((row) => row.uri === ref)?.name || ref.replace(/^onenat-(agent|resource):/, "");
			};
			const rows = (list) => list.map((row) => ({
				name: row.name,
				description: row.description,
				section: row.section,
				value: row.uri,
				icon: "session"
			}));
			return {
				source,
				refresh: () => hostCandidates("").then(publish).catch(() => {})
			};
		}
		const CSS = `
.onm-root { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 32px; font-size: 13px; }
.onm-card { border: 1px solid var(--dsw-alias-border-secondary, #e2e8f0); border-radius: 10px; padding: 14px 16px; }
.onm-card > h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.onm-muted { color: var(--dsw-alias-label-secondary, #64748b); font-size: 12px; line-height: 1.6; }
.onm-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.onm-row + .onm-row { margin-top: 8px; }
.onm-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px 12px; }
.onm-field { display: flex; flex-direction: column; gap: 4px; }
.onm-field > span { font-size: 11px; color: var(--dsw-alias-label-secondary, #64748b); }
.onm-field input, .onm-field select, .onm-field textarea {
  font: inherit; padding: 5px 8px; border-radius: 6px; width: 100%; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-secondary, #cbd5e1);
  background: var(--dsw-alias-bg-primary, #fff); color: inherit;
}
.onm-field textarea { min-height: 64px; resize: vertical; font-family: inherit; }
.onm-btn {
  font: inherit; padding: 4px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--dsw-alias-border-secondary, #cbd5e1);
  background: var(--dsw-alias-bg-primary, #fff); color: inherit;
}
.onm-btn:hover { border-color: var(--dsw-alias-brand-primary, #2563eb); }
.onm-btn.primary { background: var(--dsw-alias-brand-primary, #2563eb); border-color: transparent; color: #fff; }
.onm-btn.danger { color: #dc2626; }
.onm-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.onm-table th, .onm-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-secondary, #e2e8f0); vertical-align: top; }
.onm-table th { font-weight: 600; color: var(--dsw-alias-label-secondary, #64748b); font-size: 11px; }
.onm-tag {
  display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 11px;
  border: 1px solid var(--dsw-alias-border-secondary, #cbd5e1);
}
.onm-tag.ok { color: #15803d; border-color: #86efac; }
.onm-tag.off { color: #b91c1c; border-color: #fca5a5; }
.onm-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; white-space: pre-wrap; word-break: break-all; }
.onm-pre { max-height: 300px; overflow: auto; background: var(--dsw-alias-bg-secondary, #f8fafc); border-radius: 8px; padding: 10px; margin: 8px 0 0; }
.onm-banner { padding: 8px 10px; border-radius: 8px; font-size: 12px; }
.onm-banner.ok { background: rgba(22,163,74,.12); color: #15803d; }
.onm-banner.err { background: rgba(220,38,38,.12); color: #b91c1c; }
.onm-section-title { font-size: 12px; font-weight: 600; margin: 12px 0 6px; }
.onm-list { display: flex; flex-direction: column; gap: 6px; }
.onm-list-item { display: flex; align-items: center; gap: 8px; justify-content: space-between; padding: 6px 8px; border-radius: 8px; background: var(--dsw-alias-bg-secondary, #f8fafc); }
.onm-statusline {
  display: flex; align-items: center; gap: 8px;
  padding: 2px 4px; font-size: 11px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #64748b);
}
.onm-statusdot { width: 7px; height: 7px; border-radius: 50%; flex: none; display: inline-block; }
`;
		function useAsync(fn, deps, initial) {
			const [value, setValue] = react.default.useState(initial);
			const [loading, setLoading] = react.default.useState(false);
			const [error, setError] = react.default.useState(void 0);
			const reload = react.default.useCallback(() => {
				setLoading(true);
				setError(void 0);
				fn().then((result) => setValue(result)).catch((err) => setError(String(err?.message || err))).finally(() => setLoading(false));
			}, deps);
			react.default.useEffect(() => {
				reload();
			}, [reload]);
			return {
				value,
				loading,
				error,
				reload,
				setValue
			};
		}
		/**
		* 管理 API 客户端：每个函数对应 router.ts 的一条路由，避免在 UI 里拼路径。
		*/
		const consoleApi = {
			settingsGet: () => api("/api/settings"),
			settingsSave: (patch) => api("/api/settings", {
				method: "POST",
				body: patch
			}),
			agentsList: () => api("/api/agents"),
			agentsSave: (agent) => api("/api/agents", {
				method: "POST",
				body: agent
			}),
			agentsDelete: (id) => api(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
			agentsPing: (key) => api(`/api/agents/${encodeURIComponent(key)}/ping`, { method: "POST" }),
			agentsPreview: (key) => api(`/api/agents/${encodeURIComponent(key)}/preview`),
			resources: (refresh) => api(`/api/resources${refresh ? "?refresh=1" : ""}`),
			candidates: (query) => api(`/api/candidates?q=${encodeURIComponent(query)}`),
			parse: (text) => api("/api/debug/parse", {
				method: "POST",
				body: { text }
			}),
			sshList: () => api("/api/ssh"),
			sshSave: (resource) => api("/api/ssh", {
				method: "POST",
				body: resource
			}),
			sshDelete: (id) => api(`/api/ssh/${encodeURIComponent(id)}`, { method: "DELETE" }),
			sshTest: (id) => api(`/api/ssh/${encodeURIComponent(id)}/test`, { method: "POST" })
		};
		function Field(props) {
			return react.default.createElement("label", { className: "onm-field" }, react.default.createElement("span", null, props.label), props.textarea ? react.default.createElement("textarea", {
				value: props.value,
				placeholder: props.placeholder,
				onChange: (e) => props.onChange(e.target.value)
			}) : react.default.createElement("input", {
				value: props.value,
				placeholder: props.placeholder,
				onChange: (e) => props.onChange(e.target.value)
			}));
		}
		function Btn(props) {
			return react.default.createElement("button", {
				type: "button",
				title: props.title,
				className: "onm-btn" + (props.variant ? " " + props.variant : ""),
				onClick: props.onClick
			}, props.children);
		}
		function Banner(props) {
			return react.default.createElement("div", { className: "onm-banner " + props.kind }, props.text);
		}
		function ConnectionCard(props) {
			const [baseUrl, setBaseUrl] = react.default.useState(String(props.settings?.onenat?.baseUrl || ""));
			const [apiKey, setApiKey] = react.default.useState(String(props.settings?.onenat?.apiKey || ""));
			const [reuse, setReuse] = react.default.useState(props.settings?.defaults?.reuseSession !== false);
			const [timeoutMs, setTimeoutMs] = react.default.useState(String(props.settings?.defaults?.timeoutMs || 9e5));
			const [message, setMessage] = react.default.useState(void 0);
			const [busy, setBusy] = react.default.useState(false);
			react.default.useEffect(() => {
				setBaseUrl(String(props.settings?.onenat?.baseUrl || ""));
				setApiKey(String(props.settings?.onenat?.apiKey || ""));
				setReuse(props.settings?.defaults?.reuseSession !== false);
				setTimeoutMs(String(props.settings?.defaults?.timeoutMs || 9e5));
			}, [props.settings]);
			const save = () => {
				setBusy(true);
				consoleApi.settingsSave({
					onenat: {
						baseUrl,
						apiKey
					},
					defaults: {
						reuseSession: reuse,
						timeoutMs: Number(timeoutMs) || 9e5
					}
				}).then(() => {
					setMessage({
						kind: "ok",
						text: "已保存。ONENAT 资源目录将立即按新配置刷新。"
					});
					props.onSaved();
				}).catch((err) => setMessage({
					kind: "err",
					text: String(err?.message || err)
				})).finally(() => setBusy(false));
			};
			return react.default.createElement("div", { className: "onm-card" }, react.default.createElement("h3", null, "① ONENAT 连接与派发默认值"), react.default.createElement("div", { className: "onm-grid" }, react.default.createElement(Field, {
				label: "ONENAT 服务地址",
				value: baseUrl,
				onChange: setBaseUrl,
				placeholder: "https://onenat.sooncore.com"
			}), react.default.createElement(Field, {
				label: "ONENAT API Key",
				value: apiKey,
				onChange: setApiKey,
				placeholder: "onk-…"
			}), react.default.createElement(Field, {
				label: "派发超时（毫秒）",
				value: timeoutMs,
				onChange: setTimeoutMs
			})), react.default.createElement("div", { className: "onm-row" }, react.default.createElement("label", { className: "onm-row" }, react.default.createElement("input", {
				type: "checkbox",
				checked: reuse,
				onChange: (e) => setReuse(e.target.checked)
			}), react.default.createElement("span", null, "同一子智能体在本会话中复用远端会话（多轮续聊）"))), react.default.createElement("div", { className: "onm-row" }, react.default.createElement(Btn, {
				variant: "primary",
				onClick: save
			}, busy ? "保存中…" : "保存")), message ? react.default.createElement(Banner, message) : null);
		}
		function ResourceCard() {
			const state = useAsync(async () => await consoleApi.resources(true) || {}, [], {});
			const endpoints = state.value?.endpoints || [];
			return react.default.createElement("div", { className: "onm-card" }, react.default.createElement("h3", null, "② ONENAT 资源目录", react.default.createElement("span", { className: "onm-tag" }, String(endpoints.length))), react.default.createElement("div", { className: "onm-row" }, react.default.createElement(Btn, { onClick: state.reload }, state.loading ? "刷新中…" : "强制刷新"), react.default.createElement("span", { className: "onm-muted" }, "在输入框用 @ 可以直接选中下列资源；条目里的公网入口是实时解析结果。")), state.error ? react.default.createElement(Banner, {
				kind: "err",
				text: state.error
			}) : null, endpoints.length === 0 ? react.default.createElement("div", { className: "onm-muted" }, "暂无资源（检查 ONENAT 地址与 Key，或确认 ONENAT 客户端在线）。") : react.default.createElement("table", { className: "onm-table" }, react.default.createElement("thead", null, react.default.createElement("tr", null, react.default.createElement("th", null, "@ 名称"), react.default.createElement("th", null, "类型"), react.default.createElement("th", null, "状态"), react.default.createElement("th", null, "实时入口"), react.default.createElement("th", null, "隧道 / 技能"))), react.default.createElement("tbody", null, endpoints.map((ep) => react.default.createElement("tr", { key: ep.mappingId || ep.appId }, react.default.createElement("td", null, "@" + (ep.appName || ep.note || ep.mappingId)), react.default.createElement("td", null, String(ep.kind || "").toUpperCase()), react.default.createElement("td", null, react.default.createElement("span", { className: "onm-tag " + (ep.online ? "ok" : "off") }, ep.online ? "在线" : "离线")), react.default.createElement("td", { className: "onm-code" }, ep.kind === "ssh" ? `ssh -p ${ep.port} @${ep.host}` : ep.baseUrl || `${ep.proto}://${ep.host}:${ep.port || "?"}`), react.default.createElement("td", null, (ep.tunnelName || "") + (ep.appSkills?.length ? ` · ${ep.appSkills.length} 技能` : "")))))));
		}
		const EMPTY_FORM = {
			id: "",
			name: "",
			refKind: "mapping",
			refValue: "",
			apiBaseUrl: "",
			apiKey: "",
			agentPreset: "cordis",
			permission: "",
			provider: "",
			model: "",
			workDir: "",
			systemPrompt: "",
			description: "",
			skills: "",
			enabled: true
		};
		function AgentCard(props) {
			const [form, setForm] = react.default.useState({ ...EMPTY_FORM });
			const [message, setMessage] = react.default.useState(void 0);
			const [detail, setDetail] = react.default.useState(void 0);
			const [busy, setBusy] = react.default.useState(false);
			const set = (patch) => setForm((prev) => ({
				...prev,
				...patch
			}));
			const edit = (agent) => {
				setForm({
					id: agent.id,
					name: agent.name,
					refKind: agent.dshRef?.kind || "mapping",
					refValue: agent.dshRef?.kind === "app" ? agent.dshRef.appId : agent.dshRef?.mappingId || "",
					apiBaseUrl: agent.dshRef?.kind === "direct" ? agent.dshRef.apiBaseUrl : "",
					apiKey: agent.apiKey || "",
					agentPreset: agent.agentPreset || "cordis",
					permission: agent.permission || "",
					provider: agent.provider || "",
					model: agent.model || "",
					workDir: agent.workDir || "",
					systemPrompt: agent.systemPrompt || "",
					description: agent.description || "",
					skills: (agent.skills || []).join(", "),
					enabled: agent.enabled !== false
				});
				setDetail(void 0);
			};
			const save = () => {
				if (!form.name.trim()) {
					setMessage({
						kind: "err",
						text: "请填写子智能体名称（@ 菜单里显示的名字）"
					});
					return;
				}
				const dshRef = form.refKind === "direct" ? {
					kind: "direct",
					apiBaseUrl: form.apiBaseUrl.trim()
				} : form.refKind === "app" ? {
					kind: "app",
					appId: form.refValue
				} : {
					kind: "mapping",
					mappingId: form.refValue
				};
				if (dshRef.kind !== "direct" && !form.refValue) {
					setMessage({
						kind: "err",
						text: "请选择绑定的 DSH 实体（ONENAT 映射 / 应用）"
					});
					return;
				}
				setBusy(true);
				consoleApi.agentsSave({
					id: form.id || void 0,
					name: form.name.trim(),
					dshRef,
					apiKey: form.apiKey || void 0,
					agentPreset: form.agentPreset || void 0,
					permission: form.permission || void 0,
					provider: form.provider || void 0,
					model: form.model || void 0,
					workDir: form.workDir || void 0,
					systemPrompt: form.systemPrompt || void 0,
					description: form.description || void 0,
					skills: form.skills.split(",").map((s) => s.trim()).filter(Boolean),
					enabled: form.enabled
				}).then(() => {
					setMessage({
						kind: "ok",
						text: "已保存。输入框 @ 菜单会立即出现该子智能体。"
					});
					setForm({ ...EMPTY_FORM });
					props.onChanged();
				}).catch((err) => setMessage({
					kind: "err",
					text: String(err?.message || err)
				})).finally(() => setBusy(false));
			};
			const ping = (agent) => {
				setDetail("探测中…");
				consoleApi.agentsPing(agent.id).then((data) => setDetail(`[${agent.name}] 解析入口 ${data?.resolved?.baseUrl || "-"}\n` + JSON.stringify(data?.ping, null, 2))).catch((err) => setDetail(String(err?.message || err)));
			};
			const preview = (agent) => {
				setDetail("生成中…");
				consoleApi.agentsPreview(agent.id).then((data) => setDetail(`[${agent.name}] 派发提示词预览（脱敏）\n\n${data?.prompt || ""}`)).catch((err) => setDetail(String(err?.message || err)));
			};
			const remove = (agent) => {
				if (form.id !== agent.id) {
					setForm((prev) => ({
						...prev,
						id: agent.id,
						name: agent.name
					}));
					setMessage({
						kind: "err",
						text: `再次点击「删除」确认删除子智能体「${agent.name}」`
					});
					return;
				}
				consoleApi.agentsDelete(agent.id).then(() => {
					setMessage({
						kind: "ok",
						text: `已删除「${agent.name}」`
					});
					setForm({ ...EMPTY_FORM });
					props.onChanged();
				}).catch((err) => setMessage({
					kind: "err",
					text: String(err?.message || err)
				}));
			};
			const dshEndpoints = props.endpoints.filter((ep) => ep.kind === "dsh");
			const refOptions = form.refKind === "app" ? props.endpoints.filter((ep) => ep.appId) : form.refKind === "mapping" ? props.endpoints : [];
			return react.default.createElement("div", { className: "onm-card" }, react.default.createElement("h3", null, "③ 子智能体管理", react.default.createElement("span", { className: "onm-tag" }, String(props.agents.length))), react.default.createElement("div", { className: "onm-muted" }, "子智能体 = ONENAT 上的一个 DSH 实体（只存稳定 ID，端口漂移免疫）。绑好后在输入框打 @ 就能指名派发。", dshEndpoints.length > 0 ? ` 已识别 ${dshEndpoints.length} 个 DSH 实体。` : " 暂未在资源目录里识别到 DSH 实体（app.type=http-api 且带 dsh 技能）。"), message ? react.default.createElement(Banner, message) : null, props.agents.length === 0 ? react.default.createElement("div", { className: "onm-muted" }, "还没有子智能体，用下面的表单新建一个。") : react.default.createElement("table", { className: "onm-table" }, react.default.createElement("thead", null, react.default.createElement("tr", null, react.default.createElement("th", null, "@ 名称"), react.default.createElement("th", null, "绑定实体"), react.default.createElement("th", null, "模型 / preset"), react.default.createElement("th", null, "工作目录"), react.default.createElement("th", null, "技能 / 资源"), react.default.createElement("th", null, "操作"))), react.default.createElement("tbody", null, props.agents.map((agent) => react.default.createElement("tr", { key: agent.id }, react.default.createElement("td", null, "@" + agent.name, agent.enabled === false ? react.default.createElement("span", { className: "onm-tag off" }, "停用") : null), react.default.createElement("td", { className: "onm-code" }, agent.dshRef?.kind === "direct" ? agent.dshRef.apiBaseUrl : agent.dshRef?.kind === "app" ? agent.dshRef.appId : agent.dshRef?.mappingId), react.default.createElement("td", null, `${agent.model || "远端默认"}${agent.agentPreset ? " · " + agent.agentPreset : ""}`), react.default.createElement("td", { className: "onm-code" }, agent.workDir || "—"), react.default.createElement("td", null, `${(agent.skills || []).length} 技能 · ${(agent.resources || []).length} 资源`), react.default.createElement("td", null, react.default.createElement("div", { className: "onm-row" }, react.default.createElement(Btn, { onClick: () => edit(agent) }, "编辑"), react.default.createElement(Btn, { onClick: () => ping(agent) }, "探测"), react.default.createElement(Btn, { onClick: () => preview(agent) }, "提示词"), react.default.createElement(Btn, {
				variant: "danger",
				onClick: () => remove(agent)
			}, "删除"))))))), react.default.createElement("div", { className: "onm-section-title" }, form.id ? `编辑：${form.name}` : "新增子智能体"), react.default.createElement("div", { className: "onm-grid" }, react.default.createElement(Field, {
				label: "@ 名称（唯一、便于指名）",
				value: form.name,
				onChange: (v) => set({ name: v }),
				placeholder: "例如 kb-136-builder"
			}), react.default.createElement("label", { className: "onm-field" }, react.default.createElement("span", null, "DSH 实体绑定方式"), react.default.createElement("select", {
				value: form.refKind,
				onChange: (e) => set({
					refKind: e.target.value,
					refValue: ""
				})
			}, react.default.createElement("option", { value: "mapping" }, "ONENAT 映射（mappingId，推荐）"), react.default.createElement("option", { value: "app" }, "ONENAT 应用（appId）"), react.default.createElement("option", { value: "direct" }, "直连 URL（兜底）"))), form.refKind === "direct" ? react.default.createElement(Field, {
				label: "API Base URL",
				value: form.apiBaseUrl,
				onChange: (v) => set({ apiBaseUrl: v }),
				placeholder: "http://host:port/api/v1"
			}) : react.default.createElement("label", { className: "onm-field" }, react.default.createElement("span", null, form.refKind === "app" ? "选择应用" : "选择映射"), react.default.createElement("select", {
				value: form.refValue,
				onChange: (e) => set({ refValue: e.target.value })
			}, react.default.createElement("option", { value: "" }, "— 请选择 —"), refOptions.map((ep) => react.default.createElement("option", {
				key: form.refKind === "app" ? ep.appId : ep.mappingId,
				value: form.refKind === "app" ? ep.appId : ep.mappingId
			}, `${ep.appName || ep.note || ep.mappingId} · ${String(ep.kind).toUpperCase()} · ${ep.online ? "在线" : "离线"}`)))), react.default.createElement(Field, {
				label: "Agent Preset",
				value: form.agentPreset,
				onChange: (v) => set({ agentPreset: v }),
				placeholder: "cordis"
			}), react.default.createElement(Field, {
				label: "模型（provider/model 或 model）",
				value: form.model,
				onChange: (v) => set({ model: v })
			}), react.default.createElement(Field, {
				label: "运行权限",
				value: form.permission,
				onChange: (v) => set({ permission: v }),
				placeholder: "danger-full-access / workspace-write / read-only"
			}), react.default.createElement(Field, {
				label: "远端工作目录（绝对路径）",
				value: form.workDir,
				onChange: (v) => set({ workDir: v })
			}), react.default.createElement(Field, {
				label: "远端已装技能（逗号分隔，派发时写 /名 手势）",
				value: form.skills,
				onChange: (v) => set({ skills: v })
			}), react.default.createElement(Field, {
				label: "一句话说明（@ 菜单副标题）",
				value: form.description,
				onChange: (v) => set({ description: v })
			})), react.default.createElement("div", {
				className: "onm-field",
				style: { marginTop: 8 }
			}, react.default.createElement("span", null, "角色提示词（systemPrompt，派发时置于任务之前）"), react.default.createElement("textarea", {
				value: form.systemPrompt,
				onChange: (e) => set({ systemPrompt: e.target.value })
			})), react.default.createElement("div", {
				className: "onm-row",
				style: { marginTop: 10 }
			}, react.default.createElement(Btn, {
				variant: "primary",
				onClick: save
			}, busy ? "保存中…" : form.id ? "更新子智能体" : "新增子智能体"), form.id ? react.default.createElement(Btn, { onClick: () => setForm({ ...EMPTY_FORM }) }, "取消编辑") : null, react.default.createElement("label", { className: "onm-row" }, react.default.createElement("input", {
				type: "checkbox",
				checked: form.enabled,
				onChange: (e) => set({ enabled: e.target.checked })
			}), react.default.createElement("span", null, "启用"))), detail ? react.default.createElement("pre", { className: "onm-pre onm-code" }, detail) : null);
		}
		function SshCard(props) {
			const state = useAsync(async () => await consoleApi.sshList() || [], [], []);
			const [form, setForm] = react.default.useState({
				id: "",
				name: "",
				host: "",
				port: "22",
				authType: "password",
				username: "root",
				password: "",
				privateKey: "",
				description: ""
			});
			const [message, setMessage] = react.default.useState(void 0);
			const [detail, setDetail] = react.default.useState(void 0);
			const resources = Array.isArray(state.value) ? state.value : [];
			const set = (patch) => setForm((prev) => ({
				...prev,
				...patch
			}));
			const save = () => {
				consoleApi.sshSave({
					...form,
					port: Number(form.port) || 22
				}).then(() => {
					setMessage({
						kind: "ok",
						text: "已保存到本地 SSH 资源池。"
					});
					setForm({
						id: "",
						name: "",
						host: "",
						port: "22",
						authType: "password",
						username: "root",
						password: "",
						privateKey: "",
						description: ""
					});
					state.reload();
					props.onChanged();
				}).catch((err) => setMessage({
					kind: "err",
					text: String(err?.message || err)
				}));
			};
			return react.default.createElement("div", { className: "onm-card" }, react.default.createElement("h3", null, "④ 本地 SSH 资源池", react.default.createElement("span", { className: "onm-tag" }, String(resources.length))), react.default.createElement("div", { className: "onm-muted" }, "补充 ONENAT 之外的直连主机。@ 菜单里选中后，凭证会随资源清单一并交给执行方。"), message ? react.default.createElement(Banner, message) : null, resources.length === 0 ? react.default.createElement("div", { className: "onm-muted" }, "暂无本地 SSH 资源。") : react.default.createElement("div", { className: "onm-list" }, resources.map((r) => react.default.createElement("div", {
				className: "onm-list-item",
				key: r.id
			}, react.default.createElement("span", null, `${r.name} · ${r.username}@${r.host}:${r.port}${r.lastTestOk === void 0 ? "" : r.lastTestOk ? " · 上次连通 ✓" : " · 上次失败 ✗"}`), react.default.createElement("div", { className: "onm-row" }, react.default.createElement(Btn, { onClick: () => {
				setDetail("测试中…");
				consoleApi.sshTest(r.id).then((d) => setDetail(JSON.stringify(d, null, 2))).catch((e) => setDetail(String(e?.message || e)));
			} }, "测试"), react.default.createElement(Btn, { onClick: () => setForm({
				id: r.id,
				name: r.name,
				host: r.host,
				port: String(r.port),
				authType: r.authType,
				username: r.username,
				password: "",
				privateKey: "",
				description: r.description || ""
			}) }, "编辑"), react.default.createElement(Btn, {
				variant: "danger",
				onClick: () => {
					consoleApi.sshDelete(r.id).then(() => {
						state.reload();
						props.onChanged();
					});
				}
			}, "删除"))))), react.default.createElement("div", { className: "onm-section-title" }, form.id ? `编辑：${form.name}` : "新增 SSH 资源"), react.default.createElement("div", { className: "onm-grid" }, react.default.createElement(Field, {
				label: "名称（@ 菜单显示）",
				value: form.name,
				onChange: (v) => set({ name: v })
			}), react.default.createElement(Field, {
				label: "主机 IP / 域名",
				value: form.host,
				onChange: (v) => set({ host: v })
			}), react.default.createElement(Field, {
				label: "端口",
				value: form.port,
				onChange: (v) => set({ port: v })
			}), react.default.createElement(Field, {
				label: "登录账号",
				value: form.username,
				onChange: (v) => set({ username: v })
			}), react.default.createElement("label", { className: "onm-field" }, react.default.createElement("span", null, "认证方式"), react.default.createElement("select", {
				value: form.authType,
				onChange: (e) => set({ authType: e.target.value })
			}, react.default.createElement("option", { value: "password" }, "密码"), react.default.createElement("option", { value: "key" }, "私钥"))), react.default.createElement(Field, {
				label: "说明",
				value: form.description,
				onChange: (v) => set({ description: v })
			})), form.authType === "password" ? react.default.createElement(Field, {
				label: "密码（留空表示不修改）",
				value: form.password,
				onChange: (v) => set({ password: v })
			}) : react.default.createElement("div", {
				className: "onm-field",
				style: { marginTop: 8 }
			}, react.default.createElement("span", null, "私钥（PEM，留空表示不修改）"), react.default.createElement("textarea", {
				value: form.privateKey,
				onChange: (e) => set({ privateKey: e.target.value })
			})), react.default.createElement("div", {
				className: "onm-row",
				style: { marginTop: 10 }
			}, react.default.createElement(Btn, {
				variant: "primary",
				onClick: save
			}, form.id ? "更新" : "新增"), form.id ? react.default.createElement(Btn, { onClick: () => setForm({
				id: "",
				name: "",
				host: "",
				port: "22",
				authType: "password",
				username: "root",
				password: "",
				privateKey: "",
				description: ""
			}) }, "取消编辑") : null), detail ? react.default.createElement("pre", { className: "onm-pre onm-code" }, detail) : null);
		}
		/**
		* 输入框下方的一行状态：`@` 源是否已就绪 + 当前能 @ 到多少实体。
		* 它同时是这套集成的自检入口 —— 注册失败/候选拉取失败的原因直接显示在这里。
		*/
		function MentionStatusLine() {
			const [status, setStatus] = react.default.useState(STATUS.get());
			react.default.useEffect(() => STATUS.subscribe(() => setStatus(STATUS.get())), []);
			const [busy, setBusy] = react.default.useState(false);
			const tone = status.state === "ready" ? "#16a34a" : status.state === "error" ? "#dc2626" : "#d97706";
			const label = status.state === "ready" ? `WorkBuddy @ 就绪 · ${status.agentCount} 个子智能体 / ${status.resourceCount} 个资源可 @` : `WorkBuddy @ ${status.state === "error" ? "异常" : "等待中"}：${status.detail}`;
			const refresh = () => {
				setBusy(true);
				(async () => {
					try {
						const rows = await consoleApi.candidates("") || [];
						STATUS.set({
							state: "ready",
							sourceRegistered: STATUS.get().sourceRegistered,
							agentCount: rows.filter((r) => r.kind === "agent").length,
							resourceCount: rows.filter((r) => r.kind === "resource").length,
							detail: "已就绪"
						});
					} catch (err) {
						STATUS.set({
							state: "error",
							detail: String(err?.message || err)
						});
					} finally {
						setBusy(false);
					}
				})();
			};
			return react.default.createElement("div", { className: "onm-statusline" }, react.default.createElement("span", {
				className: "onm-statusdot",
				style: { background: tone }
			}), react.default.createElement("span", null, label), react.default.createElement("button", {
				type: "button",
				className: "onm-btn",
				style: {
					padding: "0 8px",
					fontSize: "11px"
				},
				onClick: refresh
			}, busy ? "刷新中…" : "刷新"));
		}
		function MentionTester() {
			const [text, setText] = react.default.useState("请 @kb-136-builder 帮我检查一下环境");
			const [result, setResult] = react.default.useState(void 0);
			return react.default.createElement("div", { className: "onm-card" }, react.default.createElement("h3", null, "⑤ 提及解析自检"), react.default.createElement("div", { className: "onm-muted" }, "验证一段文本会被解析成哪些实体（用于确认 @ 名称是否唯一可辨）。"), react.default.createElement("div", { className: "onm-row" }, react.default.createElement("input", {
				style: {
					flex: 1,
					padding: "5px 8px",
					borderRadius: 6,
					border: "1px solid var(--dsw-alias-border-secondary, #cbd5e1)",
					font: "inherit",
					background: "var(--dsw-alias-bg-primary, #fff)",
					color: "inherit"
				},
				value: text,
				onChange: (e) => setText(e.target.value)
			}), react.default.createElement(Btn, { onClick: () => consoleApi.parse(text).then((d) => setResult(JSON.stringify(d, null, 2))).catch((e) => setResult(String(e?.message || e))) }, "解析")), result ? react.default.createElement("pre", { className: "onm-pre onm-code" }, result) : null);
		}
		function Section(props) {
			const settings = useAsync(async () => await consoleApi.settingsGet() || {}, [], {});
			const agents = useAsync(async () => await consoleApi.agentsList() || [], [], []);
			const resources = useAsync(async () => await consoleApi.resources(false) || {}, [], {});
			const refreshAll = () => {
				settings.reload();
				agents.reload();
				resources.reload();
				props.onMentionChanged?.();
			};
			const endpoints = resources.value?.endpoints || [];
			const agentList = Array.isArray(agents.value) ? agents.value : [];
			return react.default.createElement("div", { className: "onm-root" }, react.default.createElement("div", { className: "onm-muted" }, "OneNat WorkBuddy @ —— 在 DSH 原生输入框用 @ 指定 ONENAT 上的子智能体与资源。", "选中即插入胶囊，发送后由宿主把「指认指令」与「资源清单（实时入口 + 凭证策略）」注入本轮上下文；", "子智能体派发走 onenat_agent 工具，远端会话按本会话长持复用。"), agents.error ? react.default.createElement(Banner, {
				kind: "err",
				text: agents.error
			}) : null, react.default.createElement(ConnectionCard, {
				settings: settings.value,
				onSaved: refreshAll
			}), react.default.createElement(ResourceCard, null), react.default.createElement(AgentCard, {
				agents: agentList,
				endpoints,
				onChanged: refreshAll
			}), react.default.createElement(SshCard, { onChanged: refreshAll }), react.default.createElement(MentionTester, null));
		}
		function apply(ctx) {
			const log = (msg) => {
				console.log(`[${NS}] ${msg}`);
			};
			ctx.effect(() => insertStyles(CSS), `${NS}: styles`);
			const mention = createMentionSource(log, (counts) => {
				STATUS.set({
					state: "ready",
					sourceRegistered: true,
					...counts,
					detail: "已就绪"
				});
			});
			const ctxAny = ctx;
			if (typeof ctxAny.inject === "function") ctxAny.inject(["inputTriggers"], (scope) => {
				const triggers = scope.inputTriggers;
				if (triggers === void 0) return;
				scope.effect(() => triggers.registerSource(mention.source), `${NS}: @ source`);
				STATUS.set({
					state: "ready",
					sourceRegistered: true,
					detail: "已就绪"
				});
				log("@ 源已注册（候选：ONENAT 子智能体 / ONENAT 资源 / 本地 SSH 资源）");
				mention.refresh();
			});
			else {
				const inputTriggers = ctxAny.get?.("inputTriggers");
				if (inputTriggers !== void 0) {
					ctx.effect(() => inputTriggers.registerSource(mention.source), `${NS}: @ source`);
					STATUS.set({
						state: "ready",
						sourceRegistered: true,
						detail: "已就绪（即时读取）"
					});
				} else {
					STATUS.set({
						state: "error",
						sourceRegistered: false,
						detail: "inputTriggers 服务不可用：@ 菜单未注册（设置页仍可用）"
					});
					log("inputTriggers 服务不可用：@ 菜单未注册（管理页仍可用）");
				}
			}
			ctx.effect(() => ctx.slots.inject("settings.section", () => {
				const unregister = ctx.slots.register({
					name: "settings.section",
					id: "onenat-workbuddy-mention",
					order: 42,
					label: () => "WorkBuddy @"
				}, () => react.default.createElement(Section, { onMentionChanged: () => {
					mention.refresh();
				} }));
				return () => {
					unregister();
				};
			}), `${NS}: settings section`);
			ctx.effect(() => ctx.slots.inject("conversation.composer.dock", () => {
				const unregister = ctx.slots.register({
					name: "conversation.composer.dock",
					id: "onenat-workbuddy-mention-status",
					order: 60
				}, MentionStatusLine);
				return () => {
					unregister();
				};
			}), `${NS}: composer status line`);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
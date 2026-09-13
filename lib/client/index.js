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
 *
 * 视觉约定（v0.2）：
 *  - 颜色一律走 DSH 平台设计令牌（--dsw-alias-*），不再写死浅色兜底；
 *    早期版本用了不存在的令牌名（--dsw-alias-bg-primary 等），深色主题下全部退回
 *    白色兜底 + inherit 文字色 → 输入框白底白字、分隔线刺眼。
 *  - 布局面向「设置面板内容列可能很窄（移动端/窄窗）」设计：不使用横向表格，
 *    改为卡片 + 标签/值两列网格，长路径任意断行，控件按容器宽度自适应换行。
 */
export const inject = ['slots'];
import React from 'react';
import { createPortal } from 'react-dom';
/**
 * 静态 bundle 工厂只拿到 require —— 动态插件专属的 `styles` 闭包全局在这里
 * 不存在。自己插 <style>，按平台 data-plugin / data-plugin-css 约定打标
 * （重复加载时按 tagId 去重），返回卸载清理函数。
 */
function insertStyles(css) {
    const tagId = `${NS}/client.css`;
    let tag = document.querySelector(`style[data-plugin-css="${tagId}"]`);
    if (tag === null) {
        tag = document.createElement('style');
        tag.dataset.plugin = NS;
        tag.dataset.pluginCss = tagId;
        tag.textContent = css;
        document.head.appendChild(tag);
    }
    return () => { tag.remove(); };
}
const NS = 'onenat-workbuddy-mention';
const STATUS = {
    listeners: new Set(),
    snapshot: { state: 'waiting', sourceRegistered: false, agentCount: 0, resourceCount: 0, detail: '正在等待 inputTriggers 服务…' },
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
        STATUS.snapshot = { ...STATUS.snapshot, ...patch };
        for (const listener of STATUS.listeners) {
            try {
                listener();
            }
            catch {
                /* ignore */
            }
        }
    },
};
/**
 * 管理 API 前缀：由 Host 注入到 index.html（插件为普通 bundle，浏览器半边走同源 HTTP）。
 */
function apiPrefix() {
    const injected = globalThis.__DSH_ONENAT_WORKBUDDY__;
    const prefix = injected && typeof injected.pathPrefix === 'string' ? injected.pathPrefix : '/onenat-workbuddy-mention';
    return String(prefix).replace(/\/+$/, '');
}
/** 同源管理 API 调用：统一信封 { ok, data?, error? } */
async function api(path, init) {
    const response = await globalThis.fetch(`${apiPrefix()}${path}`, {
        method: init?.method || 'GET',
        ...(init?.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false)
        throw new Error(String(payload?.error || `HTTP ${response.status}`));
    return payload?.data;
}
// --------------------------------------------------------------- @ 输入触发源
function createMentionSource(log, onCounts) {
    /** 最近一次候选快照：warm/candidates 写入，lexicon/onPick 同步读取 */
    let snapshot = [];
    let lexicon;
    const listeners = new Set();
    const publish = (rows) => {
        snapshot = rows;
        lexicon = rows.length > 0 ? rows.map((r) => r.name) : undefined;
        onCounts?.({
            agentCount: rows.filter((r) => r.kind === 'agent').length,
            resourceCount: rows.filter((r) => r.kind === 'resource').length,
        });
        for (const listener of listeners) {
            try {
                listener();
            }
            catch {
                /* ignore */
            }
        }
    };
    const hostCandidates = async (query) => {
        const rows = await api(`/api/candidates?q=${encodeURIComponent(query)}`);
        return Array.isArray(rows) ? rows : [];
    };
    const source = {
        trigger: '@',
        name: 'onenat',
        order: 2,
        showGroupTitle: false,
        async candidates(_session, req) {
            const query = String(req?.query ?? '');
            try {
                // 空查询直接复用预热快照，避免每次打开菜单都打一次 RPC
                if (query === '' && snapshot.length > 0)
                    return rows(snapshot);
                const rowsNow = await hostCandidates(query);
                if (query === '')
                    publish(rowsNow);
                return rows(rowsNow);
            }
            catch (err) {
                log(`候选拉取失败：${err?.message || err}`);
                STATUS.set({ state: 'error', detail: `候选拉取失败：${err?.message || err}` });
                return [];
            }
        },
        warm() {
            void hostCandidates('')
                .then((rowsNow) => publish(rowsNow))
                .catch((err) => log(`预热失败：${err?.message || err}`));
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
            const uri = String(pick?.candidate?.value || '');
            const name = String(pick?.candidate?.name || '');
            if (!uri)
                return undefined;
            return {
                insert: {
                    source: 'onenat',
                    ref: uri,
                    label: name,
                    clipboardText: `@[${name}](${uri})`,
                },
            };
        },
        codec: {
            clipboardText: (ref) => `@[${labelOf(ref)}](${ref})`,
            serialize: (ref) => Promise.resolve(`@[${labelOf(ref)}](${ref})`),
        },
    };
    const labelOf = (ref) => {
        const hit = snapshot.find((row) => row.uri === ref);
        return hit?.name || ref.replace(/^onenat-(agent|resource):/, '');
    };
    const rows = (list) => list.map((row) => ({
        name: row.name,
        description: row.description,
        section: row.section,
        value: row.uri,
        icon: 'session',
    }));
    return { source, refresh: () => hostCandidates('').then(publish).catch(() => { }) };
}
// ------------------------------------------------------------------- 样式表
/**
 * 全部颜色取自 DSH 平台设计令牌（--dsw-alias-* 在中性蓝浅/深两套主题下都有定义）。
 * 每个 var() 仍带一个兜底值：令牌缺失时至少不出现「白底白字」。
 */
const CSS = `
.onm-root { display:flex; flex-direction:column; gap:14px; padding:2px 0 40px; font-size:13px; line-height:1.55;
  color: var(--dsw-alias-label-primary, #1f2328); }
.onm-card { border:1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.12)); border-radius:12px;
  background: var(--dsw-alias-bg-layer-1, transparent); padding:12px 14px; }
.onm-card + .onm-card { margin-top:0; }
.onm-card-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
.onm-card-title { font-size:13.5px; font-weight:600; margin:0; display:flex; align-items:center; gap:8px; }
.onm-muted { color: var(--dsw-alias-label-secondary, #4b5563); font-size:12px; line-height:1.65; }
.onm-sub { font-size:11.5px; font-weight:600; color: var(--dsw-alias-label-secondary, #4b5563); margin:12px 0 2px; }
.onm-divider { height:1px; background: var(--dsw-alias-border-l1, rgba(0,0,0,.06)); margin:10px 0; }
.onm-field { display:flex; flex-direction:column; gap:4px; min-width:0; }
.onm-label { font-size:11.5px; font-weight:500; color: var(--dsw-alias-label-secondary, #4b5563); }
.onm-hint { font-size:11px; color: var(--dsw-alias-label-secondary, #4b5563); line-height:1.6; }
/* minmax(220px)：窄窗一列到底（下拉里的长模型名/预设名不被硬裁），宽窗自动两列 */
.onm-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:10px 12px; }
.onm-input, .onm-select, .onm-textarea { width:100%; box-sizing:border-box; font:inherit; font-size:12.5px;
  padding:7px 9px; border-radius:8px; outline:none; min-width:0; text-overflow:ellipsis;
  color: var(--dsw-alias-label-primary, #1f2328);
  background: var(--dsw-alias-bg-base, rgba(127,127,127,.06));
  border:1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.14)); }
.onm-textarea { min-height:76px; resize:vertical; font-family:inherit; line-height:1.6; }
.onm-input:focus, .onm-select:focus, .onm-textarea:focus {
  border-color: var(--dsw-alias-state-business-primary, #4176e6);
  box-shadow: 0 0 0 2px var(--dsw-alias-interactive-bg-hover-accent, rgba(65,118,230,.16)); }
.onm-input::placeholder, .onm-textarea::placeholder { color: var(--dsw-alias-label-tertiary, #6b7280); opacity:1; }
.onm-input:disabled, .onm-select:disabled { opacity:.55; cursor:not-allowed; }
.onm-btn { font:inherit; font-size:12px; padding:5px 11px; border-radius:8px; cursor:pointer; white-space:nowrap;
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-button-elevated-fill, rgba(127,127,127,.08));
  border:1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.14)); }
.onm-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.onm-btn:disabled { opacity:.5; cursor:not-allowed; }
.onm-btn.primary { background: var(--dsw-alias-button-primary-fill, #1f2328); border-color:transparent; font-weight:500;
  color: var(--dsw-alias-label-primary-foreground, #fff); }
.onm-btn.ghost { background:transparent; border-color:transparent;
  color: var(--dsw-alias-label-secondary, #4b5563); }
.onm-btn.ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.onm-btn.danger { color: var(--dsw-alias-state-error-primary, #dc2626); }
.onm-btn.sm { padding:3px 8px; font-size:11.5px; }
.onm-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.onm-spacer { flex:1 1 auto; }
/* 状态胶囊：淡色底 + 同色文字（深/浅两套主题下都能一眼区分启用与停用） */
.onm-tag { display:inline-block; padding:0 7px; border-radius:999px; line-height:18px; vertical-align:middle;
  font-size:11px; white-space:nowrap; max-width:100%; overflow:hidden; text-overflow:ellipsis;
  color: var(--dsw-alias-label-secondary, #4b5563);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08));
  border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); }
.onm-tag.ok { color: var(--dsw-alias-state-success-primary, #16a34a);
  background: var(--dsw-alias-state-success-tertiary, rgba(22,163,74,.12)); border-color: currentColor; }
.onm-tag.off { color: var(--dsw-alias-state-error-primary, #dc2626);
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(220,38,38,.1)); border-color: currentColor; }
.onm-tag.warn { color: var(--dsw-alias-state-warn-primary, #d97706);
  background: var(--dsw-alias-state-warn-tertiary, rgba(217,119,6,.12)); border-color: currentColor; }
.onm-tag.brand { color: var(--dsw-alias-state-business-primary, #4176e6);
  background: var(--dsw-alias-state-business-tertiary, rgba(65,118,230,.12)); border-color: currentColor; }
.onm-list { display:flex; flex-direction:column; gap:8px; margin-top:8px; }
.onm-item { display:flex; flex-direction:column; gap:8px; padding:10px 12px; border-radius:10px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.06));
  border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); }
.onm-item-head { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
.onm-item-title { font-size:13px; font-weight:600; }
.onm-meta { display:grid; grid-template-columns: minmax(58px, auto) minmax(0, 1fr); gap:3px 10px; margin:0; font-size:12px; }
.onm-meta dt { color: var(--dsw-alias-label-secondary, #6b7280); }
.onm-meta dd { margin:0; overflow-wrap:anywhere; word-break:break-word; }
.onm-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
.onm-actions { display:flex; gap:6px; flex-wrap:wrap; }
.onm-banner { padding:8px 10px; border-radius:8px; font-size:12px; line-height:1.6; overflow-wrap:anywhere; }
.onm-banner.ok { background: var(--dsw-alias-state-success-tertiary, rgba(22,163,74,.12));
  color: var(--dsw-alias-state-success-primary, #15803d); }
.onm-banner.err { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(220,38,38,.1));
  color: var(--dsw-alias-state-error-primary, #b91c1c); }
.onm-banner.info { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08));
  color: var(--dsw-alias-label-secondary, #4b5563); }
.onm-pre { max-height:260px; overflow:auto; border-radius:8px; padding:9px 10px; margin:6px 0 0;
  white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word;
  background: var(--dsw-alias-markdown-code-block, rgba(127,127,127,.08));
  color: var(--dsw-alias-label-primary, inherit); }
.onm-statusline { display:flex; align-items:center; gap:8px; padding:2px 4px; font-size:11px;
  color: var(--dsw-alias-label-tertiary, #6b7280); }
.onm-statusdot { width:7px; height:7px; border-radius:50%; flex:none; display:inline-block; }
/* 浮层：编辑器 / 远端目录选择器（createPortal 到 body，避免被面板 overflow 裁切） */
.onm-overlay { position:fixed; inset:0; z-index:9200; display:flex; align-items:center; justify-content:center;
  padding:14px; background: var(--dsw-alias-bg-mask-3, rgba(0,0,0,.45)); }
.onm-overlay.on-top { z-index:9300; }
.onm-modal { width:100%; max-width:660px; max-height:88vh; display:flex; flex-direction:column; overflow:hidden;
  background: var(--dsw-alias-bg-layer-3, #fff);
  border:1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.14)); border-radius:14px;
  box-shadow: 0 20px 50px rgba(0,0,0,.35); }
.onm-modal-head { display:flex; align-items:center; gap:8px; padding:12px 14px;
  border-bottom:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06)); }
.onm-modal-title { font-size:13.5px; font-weight:600; margin:0; }
.onm-modal-body { flex:1 1 auto; min-height:0; padding:12px 14px; overflow:auto;
  display:flex; flex-direction:column; gap:10px; }
.onm-modal-foot { flex:0 0 auto; display:flex; align-items:center; gap:8px; padding:10px 14px;
  padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
  border-top:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06)); }
.onm-modal-head .onm-btn { min-width:32px; min-height:30px; padding:5px 9px; }
/* 远端目录选择器 */
.onm-db-path { display:flex; gap:6px; align-items:center; flex:0 0 auto; }
.onm-db-path .onm-btn { padding:7px 10px; }
.onm-db-list { display:flex; flex-direction:column; gap:3px; padding:4px; border-radius:10px;
  min-height:150px; max-height:46vh; overflow:auto;
  background: var(--dsw-alias-bg-base, rgba(127,127,127,.05));
  border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06)); }
.onm-dirrow { display:flex; align-items:center; gap:8px; padding:11px 10px; border-radius:7px; cursor:pointer; font-size:12.5px; }
.onm-dirrow:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.onm-dirrow .nm { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.onm-dirrow .chev { flex:none; color: var(--dsw-alias-label-tertiary, #9ca3af); }
.onm-dirrow.up { color: var(--dsw-alias-state-business-primary, #4176e6); }
.onm-dirrow.is-hidden .nm { opacity:.55; }
.onm-empty { padding:14px 10px; text-align:center; font-size:12px; color: var(--dsw-alias-label-tertiary, #6b7280); }
.onm-chips { display:flex; flex-wrap:wrap; gap:6px; }
.onm-chip { font-size:11.5px; padding:3px 9px; border-radius:999px; cursor:pointer; user-select:none;
  color: var(--dsw-alias-label-secondary, #4b5563);
  border:1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); }
.onm-chip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.onm-chip.on { background: var(--dsw-alias-state-business-primary, #4176e6); border-color:transparent;
  color: var(--dsw-alias-label-primary-foreground, #fff); }
@media (max-width:560px) {
  .onm-overlay { padding:0; align-items:stretch; }
  .onm-modal { max-width:none; max-height:none; height:100%; border-radius:0; border:none; }
  .onm-db-list { max-height:none; flex:1 1 auto; }
}
`;
function useAsync(fn, deps, initial) {
    const [value, setValue] = React.useState(initial);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(undefined);
    const reload = React.useCallback(() => {
        setLoading(true);
        setError(undefined);
        fn()
            .then((result) => setValue(result))
            .catch((err) => setError(String(err?.message || err)))
            .finally(() => setLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    React.useEffect(() => {
        reload();
    }, [reload]);
    return { value, loading, error, reload, setValue };
}
/**
 * 管理 API 客户端：每个函数对应 router.ts 的一条路由，避免在 UI 里拼路径。
 */
const consoleApi = {
    settingsGet: () => api('/api/settings'),
    settingsSave: (patch) => api('/api/settings', { method: 'POST', body: patch }),
    agentsList: () => api('/api/agents'),
    agentsSave: (agent) => api('/api/agents', { method: 'POST', body: agent }),
    agentsDelete: (id) => api(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    agentsPing: (key) => api(`/api/agents/${encodeURIComponent(key)}/ping`, { method: 'POST' }),
    agentsPreview: (key) => api(`/api/agents/${encodeURIComponent(key)}/preview`),
    /** 保存前也能用的远端探测（吃表单里的 dshRef/apiKey） */
    probeOptions: (body) => api('/api/probe/options', { method: 'POST', body }),
    probeSkills: (body) => api('/api/probe/skills', { method: 'POST', body }),
    probeFs: (body) => api('/api/probe/fs', { method: 'POST', body }),
    probeMkdir: (body) => api('/api/probe/mkdir', { method: 'POST', body }),
    resources: (refresh) => api(`/api/resources${refresh ? '?refresh=1' : ''}`),
    candidates: (query) => api(`/api/candidates?q=${encodeURIComponent(query)}`),
    parse: (text) => api('/api/debug/parse', { method: 'POST', body: { text } }),
    sshList: () => api('/api/ssh'),
    sshSave: (resource) => api('/api/ssh', { method: 'POST', body: resource }),
    sshDelete: (id) => api(`/api/ssh/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    sshTest: (id) => api(`/api/ssh/${encodeURIComponent(id)}/test`, { method: 'POST' }),
};
function Field(props) {
    return React.createElement('div', { className: 'onm-field' }, props.label ? React.createElement('span', { className: 'onm-label' }, props.label) : null, props.children, props.hint ? React.createElement('span', { className: 'onm-hint' }, props.hint) : null);
}
function TextInput(props) {
    return React.createElement('input', {
        className: 'onm-input' + (props.mono ? ' onm-mono' : ''),
        value: props.value,
        placeholder: props.placeholder,
        disabled: props.disabled,
        inputMode: props.inputMode,
        spellCheck: false,
        onChange: (e) => props.onChange(e.target.value),
        onKeyDown: (e) => {
            if (e.key === 'Enter' && props.onEnter)
                props.onEnter();
        },
    });
}
function TextArea(props) {
    return React.createElement('textarea', {
        className: 'onm-textarea',
        value: props.value,
        placeholder: props.placeholder,
        rows: props.rows,
        onChange: (e) => props.onChange(e.target.value),
    });
}
function Select(props) {
    return React.createElement('select', {
        className: 'onm-select',
        value: props.value,
        disabled: props.disabled,
        onChange: (e) => props.onChange(e.target.value),
    }, props.options.map((o) => React.createElement('option', { key: o.value, value: o.value, title: o.title, disabled: o.disabled }, o.label)));
}
function Btn(props) {
    const cls = ['onm-btn', props.variant, props.size].filter(Boolean).join(' ');
    return React.createElement('button', { type: 'button', title: props.title, className: cls, disabled: props.disabled, onClick: props.onClick }, props.children);
}
function Tag(props) {
    return React.createElement('span', { className: 'onm-tag' + (props.tone ? ' ' + props.tone : ''), title: props.title }, props.children);
}
function Banner(props) {
    return React.createElement('div', { className: 'onm-banner ' + props.kind }, props.text);
}
/** 标签 / 值两列网格：长路径只在值列内断行，不会把相邻列挤成竖排 */
function MetaRow(props) {
    return [React.createElement('dt', { key: 'k' }, props.label), React.createElement('dd', { key: 'v' }, props.children)];
}
/** 通用浮层（createPortal 到 body） */
function Overlay(props) {
    return createPortal(React.createElement('div', {
        className: 'onm-overlay' + (props.top ? ' on-top' : ''),
        onClick: (e) => {
            if (e.target === e.currentTarget)
                props.onClose();
        },
    }, React.createElement('div', { className: 'onm-modal', onClick: (e) => e.stopPropagation() }, React.createElement('div', { className: 'onm-modal-head' }, React.createElement('h3', { className: 'onm-modal-title' }, props.title), props.subtitle ? React.createElement('span', { className: 'onm-muted' }, props.subtitle) : null, React.createElement('div', { className: 'onm-spacer' }), React.createElement(Btn, { variant: 'ghost', size: 'sm', onClick: props.onClose, title: '关闭' }, '✕')), React.createElement('div', { className: 'onm-modal-body' }, props.children), props.footer ? React.createElement('div', { className: 'onm-modal-foot' }, props.footer) : null)), document.body);
}
// ----------------------------------------------------------- 远端目录选择器
/**
 * 远端 DSH 目录浏览器：`/api/probe/fs` 直接代理远端 dsh-web-service 的
 * /fs/list（只返回目录行）。选中路径写回工作目录输入框。
 */
function DirPicker(props) {
    const [state, setState] = React.useState({
        loading: true,
        path: props.initial || '',
        home: '',
        parent: undefined,
        entries: [],
        truncated: false,
    });
    const [typed, setTyped] = React.useState(props.initial || '');
    const [error, setError] = React.useState(undefined);
    const [showHidden, setShowHidden] = React.useState(false);
    const [creating, setCreating] = React.useState(undefined);
    const [busy, setBusy] = React.useState(false);
    const load = (p, allowFallback = true) => {
        setError(undefined);
        setState((s) => ({ ...s, loading: true }));
        consoleApi
            .probeFs({ dshRef: props.dshRef, apiKey: props.apiKey, path: p || undefined })
            .then((data) => {
            const d = data || {};
            setState({
                loading: false,
                path: d.path || '',
                home: d.home || '',
                parent: d.parent,
                entries: Array.isArray(d.entries) ? d.entries : [],
                truncated: !!d.truncated,
            });
            setTyped(d.path && d.path !== d.home ? d.path : '');
        })
            .catch((err) => {
            // 回填的历史工作目录可能已被删除：退回远端主目录，而不是死在错误上
            if (p && allowFallback) {
                load(undefined, false);
                return;
            }
            setState((s) => ({ ...s, loading: false }));
            setError(String(err?.message || err));
        });
    };
    React.useEffect(() => {
        load(props.initial || undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const mkdir = () => {
        const name = String(creating || '').trim();
        if (!name)
            return;
        setBusy(true);
        consoleApi
            .probeMkdir({ dshRef: props.dshRef, apiKey: props.apiKey, path: state.path, name })
            .then(() => {
            setCreating(undefined);
            load(state.path);
        })
            .catch((err) => setError(String(err?.message || err)))
            .finally(() => setBusy(false));
    };
    const entries = (state.entries || []).filter((e) => showHidden || !e.hidden);
    const rows = [];
    if (state.parent) {
        rows.push(React.createElement('div', { key: 'up', className: 'onm-dirrow up', onClick: () => load(state.parent) }, React.createElement('span', null, '↩'), React.createElement('span', { className: 'nm' }, '上级目录')));
    }
    for (const e of entries) {
        rows.push(React.createElement('div', {
            key: e.path,
            className: 'onm-dirrow' + (e.hidden ? ' is-hidden' : ''),
            title: e.path,
            onClick: () => load(e.path),
        }, React.createElement('span', null, '📁'), React.createElement('span', { className: 'nm' }, e.name), React.createElement('span', { className: 'chev' }, '›')));
    }
    if (!state.loading && rows.length === 0 && !error) {
        rows.push(React.createElement('div', { key: 'empty', className: 'onm-empty' }, '此目录下没有子目录'));
    }
    if (state.loading)
        rows.push(React.createElement('div', { key: 'loading', className: 'onm-empty' }, '加载中…'));
    return React.createElement(Overlay, {
        title: '选择远端工作目录',
        subtitle: props.subtitle,
        onClose: props.onClose,
        top: true,
        footer: [
            React.createElement(Btn, { key: 'cancel', onClick: props.onClose }, '取消'),
            React.createElement(Btn, {
                key: 'pick',
                variant: 'primary',
                disabled: !state.path,
                onClick: () => props.onPick(state.path),
            }, '使用此目录'),
        ],
    }, React.createElement('div', { className: 'onm-db-path' }, React.createElement(Btn, { size: 'sm', title: '回到远端主目录', onClick: () => load() }, '🏠'), React.createElement(TextInput, {
        value: typed,
        mono: true,
        placeholder: state.home ? `主目录（${state.home}）· 可输入绝对路径回车跳转` : '输入绝对路径后回车跳转',
        onChange: setTyped,
        onEnter: () => {
            if (typed.trim())
                load(typed.trim());
        },
    }), React.createElement(Btn, { size: 'sm', onClick: () => typed.trim() && load(typed.trim()) }, '前往')), error ? React.createElement(Banner, { kind: 'err', text: '浏览失败：' + error }) : null, React.createElement('div', { className: 'onm-db-list' }, rows), React.createElement('div', { className: 'onm-row' }, React.createElement(Btn, {
        size: 'sm',
        disabled: !state.path,
        onClick: () => setCreating(creating === undefined ? '' : undefined),
    }, '＋ 新建文件夹'), React.createElement(Btn, { size: 'sm', variant: 'ghost', onClick: () => setShowHidden(!showHidden) }, showHidden ? '✓ 显示隐藏目录' : '显示隐藏目录'), React.createElement('div', { className: 'onm-spacer' }), state.truncated ? React.createElement('span', { className: 'onm-hint' }, '目录过多，仅显示开头部分') : null), creating !== undefined
        ? React.createElement('div', { className: 'onm-row' }, React.createElement(TextInput, {
            value: creating,
            placeholder: `在「${String(state.path).split('/').pop() || state.path}」中新建文件夹名`,
            onChange: setCreating,
            onEnter: mkdir,
        }), React.createElement(Btn, { size: 'sm', variant: 'primary', disabled: busy || !creating.trim(), onClick: mkdir }, busy ? '创建中…' : '创建'))
        : null, React.createElement('div', { className: 'onm-hint' }, state.path ? `当前：${state.path}` : '尚未进入任何目录'));
}
// ---------------------------------------------------------------- 子智能体编辑
const EMPTY_FORM = {
    id: '',
    name: '',
    refKind: 'mapping',
    refValue: '',
    apiBaseUrl: '',
    apiKey: '',
    agentPreset: '',
    provider: '',
    model: '',
    permission: '',
    workDir: '',
    systemPrompt: '',
    description: '',
    skills: '',
    enabled: true,
};
const PERMISSIONS = [
    { value: '', label: '远端默认（不指定）' },
    { value: 'read-only', label: 'read-only · 只读' },
    { value: 'workspace-write', label: 'workspace-write · 工作区可写' },
    { value: 'danger-full-access', label: 'danger-full-access · 完全访问' },
];
function formFromAgent(agent) {
    if (!agent)
        return { ...EMPTY_FORM };
    return {
        id: agent.id || '',
        name: agent.name || '',
        refKind: agent.dshRef?.kind || 'mapping',
        refValue: agent.dshRef?.kind === 'app' ? agent.dshRef.appId : agent.dshRef?.kind === 'mapping' ? agent.dshRef.mappingId : '',
        apiBaseUrl: agent.dshRef?.kind === 'direct' ? agent.dshRef.apiBaseUrl : '',
        apiKey: agent.apiKey || '',
        agentPreset: agent.agentPreset || '',
        provider: agent.provider || '',
        model: agent.model || '',
        permission: agent.permission || '',
        workDir: agent.workDir || '',
        systemPrompt: agent.systemPrompt || '',
        description: agent.description || '',
        skills: (agent.skills || []).join(', '),
        enabled: agent.enabled !== false,
    };
}
function dshRefOf(form) {
    if (form.refKind === 'direct') {
        const url = String(form.apiBaseUrl || '').trim();
        return url ? { kind: 'direct', apiBaseUrl: url } : undefined;
    }
    if (!form.refValue)
        return undefined;
    return form.refKind === 'app' ? { kind: 'app', appId: form.refValue } : { kind: 'mapping', mappingId: form.refValue };
}
function AgentEditor(props) {
    const isEdit = Boolean(props.agent?.id);
    const [form, setForm] = React.useState(() => formFromAgent(props.agent));
    const [remote, setRemote] = React.useState(undefined);
    const [sync, setSync] = React.useState({ state: 'idle', text: '' });
    const [message, setMessage] = React.useState(undefined);
    const [busy, setBusy] = React.useState(false);
    const [picker, setPicker] = React.useState(false);
    const [permCustom, setPermCustom] = React.useState(() => Boolean(form.permission) && !PERMISSIONS.some((p) => p.value === form.permission));
    const [skillOptions, setSkillOptions] = React.useState(undefined);
    const [skillBusy, setSkillBusy] = React.useState(false);
    const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));
    const ref = dshRefOf(form);
    const canProbe = Boolean(ref);
    /** 从远端 DSH 拉「模式预设 / Provider / 模型」——保存前即可拉，靠 dshRef 实时解析 */
    const syncRemote = () => {
        const target = dshRefOf(form);
        if (!target) {
            setSync({ state: 'error', text: '请先选择 DSH 实体绑定' });
            return;
        }
        setSync({ state: 'loading', text: '正在从远端 DSH 拉取模型与模式预设…' });
        consoleApi
            .probeOptions({ dshRef: target, apiKey: form.apiKey || undefined })
            .then((data) => {
            setRemote(data || {});
            const models = Array.isArray(data?.models) ? data.models : [];
            const presets = Array.isArray(data?.presets) ? data.presets : [];
            const patch = {};
            if (!form.model && data?.defaultModel?.model)
                patch.model = data.defaultModel.model;
            if (!form.provider && data?.defaultModel?.provider)
                patch.provider = data.defaultModel.provider;
            if (!form.agentPreset && presets.length > 0) {
                const preferred = presets.find((p) => p.isDefault) || presets[0];
                if (preferred?.id)
                    patch.agentPreset = preferred.id;
            }
            if (Object.keys(patch).length > 0)
                set(patch);
            const notes = [];
            if (data?.modelsError)
                notes.push('模型接口：' + data.modelsError);
            if (data?.presetsError)
                notes.push('预设接口：' + data.presetsError);
            setSync({
                state: 'ok',
                text: `已同步 ${models.length} 个模型 · ${presets.length} 个模式预设` + (notes.length ? `（${notes.join('；')}）` : ''),
            });
        })
            .catch((err) => {
            setSync({ state: 'error', text: '远端选项同步失败：' + String(err?.message || err) + ' —— 可手工填写' });
        });
    };
    React.useEffect(() => {
        if (dshRefOf(form))
            syncRemote();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // 换绑 ONENAT 映射 / 应用后自动重拉新实体的清单（直连 URL 是手输，不按键自动打远端）
    const firstBind = React.useRef(true);
    React.useEffect(() => {
        if (firstBind.current) {
            firstBind.current = false;
            return;
        }
        if (!dshRefOf(form))
            return;
        setRemote(undefined);
        syncRemote();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [form.refKind, form.refValue]);
    const loadSkills = () => {
        const target = dshRefOf(form);
        if (!target) {
            setMessage({ kind: 'err', text: '请先选择 DSH 实体绑定' });
            return;
        }
        setSkillBusy(true);
        consoleApi
            .probeSkills({ dshRef: target, apiKey: form.apiKey || undefined, cwd: form.workDir || undefined })
            .then((data) => {
            const skills = Array.isArray(data?.skills) ? data.skills : [];
            setSkillOptions(skills);
            setMessage(skills.length > 0 ? { kind: 'info', text: `远端返回 ${skills.length} 个已装技能，点选即可加入清单。` } : { kind: 'info', text: '远端没有返回技能（可能未安装技能或服务端版本较低）。' });
        })
            .catch((err) => setMessage({ kind: 'err', text: '技能清单拉取失败：' + String(err?.message || err) }))
            .finally(() => setSkillBusy(false));
    };
    const skills = String(form.skills || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const toggleSkill = (name) => {
        const next = skills.includes(name) ? skills.filter((s) => s !== name) : [...skills, name];
        set({ skills: next.join(', ') });
    };
    const save = () => {
        if (!String(form.name || '').trim()) {
            setMessage({ kind: 'err', text: '请填写子智能体名称（@ 菜单里显示的名字）' });
            return;
        }
        const target = dshRefOf(form);
        if (!target) {
            setMessage({ kind: 'err', text: '请选择绑定的 DSH 实体（ONENAT 映射 / 应用）或填写直连地址' });
            return;
        }
        setBusy(true);
        consoleApi
            .agentsSave({
            id: form.id || undefined,
            name: String(form.name).trim(),
            dshRef: target,
            apiKey: form.apiKey || undefined,
            agentPreset: form.agentPreset || undefined,
            permission: form.permission || undefined,
            provider: form.provider || undefined,
            model: form.model || undefined,
            workDir: form.workDir || undefined,
            systemPrompt: form.systemPrompt || undefined,
            description: form.description || undefined,
            skills,
            enabled: form.enabled,
        })
            .then(() => props.onSaved(isEdit ? `已更新「${form.name}」` : `已新增「${form.name}」`))
            .catch((err) => setMessage({ kind: 'err', text: String(err?.message || err) }))
            .finally(() => setBusy(false));
    };
    const refOptions = form.refKind === 'app'
        ? props.endpoints.filter((ep) => ep.appId)
        : form.refKind === 'mapping'
            ? props.endpoints
            : [];
    const models = Array.isArray(remote?.models) ? remote.models : [];
    const providers = Array.isArray(remote?.providers) ? remote.providers : [];
    const presets = Array.isArray(remote?.presets) ? remote.presets : [];
    // 模式（agentPreset）：有远端清单就下拉，否则退化为手工输入
    const presetOptions = [];
    if (!form.agentPreset)
        presetOptions.push({ value: '', label: '远端默认' });
    for (const p of presets) {
        presetOptions.push({ value: p.id, label: p.name && p.name !== p.id ? `${p.id} · ${p.name}` : p.id, title: p.description });
    }
    if (form.agentPreset && !presets.some((p) => p.id === form.agentPreset)) {
        presetOptions.unshift({ value: form.agentPreset, label: `${form.agentPreset}（当前）` });
    }
    const providerOptions = [{ value: '', label: '远端默认' }, ...providers.map((p) => ({ value: p, label: p }))];
    if (form.provider && !providers.includes(form.provider)) {
        providerOptions.unshift({ value: form.provider, label: `${form.provider}（当前）` });
    }
    const visibleModels = form.provider ? models.filter((m) => m.provider === form.provider) : models;
    const modelOptions = [{ value: '', label: '远端默认模型' }];
    for (const m of visibleModels) {
        modelOptions.push({
            value: m.id,
            label: `${m.id}${m.isDefault ? '（远端默认）' : ''}${form.provider ? '' : ' · ' + m.provider}`,
            title: [m.name && m.name !== m.id ? m.name : '', m.description || '', m.reasoning ? '支持推理' : ''].filter(Boolean).join(' · '),
        });
    }
    if (form.model && !visibleModels.some((m) => m.id === form.model)) {
        modelOptions.unshift({ value: form.model, label: `${form.model}（当前）` });
    }
    return React.createElement(Overlay, {
        title: isEdit ? `编辑子智能体：@${form.name || ''}` : '新增子智能体',
        subtitle: remote?.baseUrl ? `远端 ${remote.baseUrl}` : undefined,
        onClose: props.onClose,
        footer: [
            message ? React.createElement('span', { key: 'msg', className: 'onm-hint' }, message.text) : null,
            React.createElement('div', { key: 'sp', className: 'onm-spacer' }),
            React.createElement(Btn, { key: 'cancel', onClick: props.onClose }, '取消'),
            React.createElement(Btn, { key: 'save', variant: 'primary', disabled: busy, onClick: save }, busy ? '保存中…' : isEdit ? '保存修改' : '新增'),
        ].filter(Boolean),
    }, message ? React.createElement(Banner, { kind: message.kind, text: message.text }) : null, 
    // ---- 身份与绑定 ----
    React.createElement('div', { className: 'onm-grid' }, React.createElement(Field, {
        label: '@ 名称（唯一、便于指名）',
        children: React.createElement(TextInput, { value: form.name, onChange: (v) => set({ name: v }), placeholder: '例如 kb-136-builder' }),
    }), React.createElement(Field, {
        label: 'DSH 实体绑定方式',
        children: React.createElement(Select, {
            value: form.refKind,
            onChange: (v) => set({ refKind: v, refValue: '' }),
            options: [
                { value: 'mapping', label: 'ONENAT 映射（mappingId，推荐）' },
                { value: 'app', label: 'ONENAT 应用（appId）' },
                { value: 'direct', label: '直连 URL（兜底）' },
            ],
        }),
    })), form.refKind === 'direct'
        ? React.createElement(Field, {
            label: 'API Base URL',
            hint: '直连地址绕过 ONENAT 解析，仅在该 DSH 有固定入口时使用。',
            children: React.createElement(TextInput, { value: form.apiBaseUrl, mono: true, onChange: (v) => set({ apiBaseUrl: v }), placeholder: 'http://host:port/api/v1' }),
        })
        : React.createElement(Field, {
            label: form.refKind === 'app' ? '选择应用' : '选择映射',
            hint: '只存稳定 ID：ONENAT 客户端重连导致端口漂移时无需改配置。',
            children: React.createElement(Select, {
                value: form.refValue,
                onChange: (v) => set({ refValue: v }),
                options: [
                    { value: '', label: '— 请选择 —' },
                    ...refOptions.map((ep) => ({
                        value: form.refKind === 'app' ? ep.appId : ep.mappingId,
                        label: `${ep.appName || ep.note || ep.mappingId} · ${String(ep.kind).toUpperCase()} · ${ep.online ? '在线' : '离线'}`,
                        title: ep.baseUrl || `${ep.proto}://${ep.host}:${ep.port || '?'}`,
                    })),
                ],
            }),
        }), React.createElement(Field, {
        label: 'API Key（可选）',
        children: React.createElement(TextInput, { value: form.apiKey, onChange: (v) => set({ apiKey: v }), placeholder: '留空则经 ONENAT 映射凭证接口解析' }),
    }), React.createElement('div', { className: 'onm-sub' }, '远端运行参数（模式 / 模型 / 工作目录）'), React.createElement('div', { className: 'onm-row' }, React.createElement(Btn, { size: 'sm', disabled: !canProbe || sync.state === 'loading', onClick: syncRemote }, sync.state === 'loading' ? '同步中…' : '↻ 从远端 DSH 拉取'), React.createElement('span', { className: 'onm-hint' }, sync.text || '模式预设、Provider、模型清单与目录，都取自该 DSH 实体当前实际可用的东西。')), React.createElement('div', { className: 'onm-grid' }, React.createElement(Field, {
        label: '模式（agentPreset）',
        hint: presets.length > 0 ? '来自远端 DSH 的 agent preset 清单。' : '远端清单不可用时手工填写。',
        children: presets.length > 0
            ? React.createElement(Select, { value: form.agentPreset, onChange: (v) => set({ agentPreset: v }), options: presetOptions })
            : React.createElement(TextInput, { value: form.agentPreset, onChange: (v) => set({ agentPreset: v }), placeholder: 'cordis' }),
    }), React.createElement(Field, {
        label: 'Provider',
        hint: providers.length > 0 ? `${providers.length} 个提供商来自远端。` : '远端清单不可用时手工填写。',
        children: providers.length > 0
            ? React.createElement(Select, { value: form.provider, onChange: (v) => set({ provider: v, model: '' }), options: providerOptions })
            : React.createElement(TextInput, { value: form.provider, onChange: (v) => set({ provider: v }), placeholder: '留空用远端默认' }),
    }), React.createElement(Field, {
        label: '模型',
        hint: models.length > 0 ? `远端共 ${models.length} 个模型${form.provider ? `，当前 Provider ${visibleModels.length} 个` : ''}。` : '远端清单不可用时手工填写。',
        children: models.length > 0
            ? React.createElement(Select, { value: form.model, onChange: (v) => set({ model: v }), options: modelOptions })
            : React.createElement(TextInput, { value: form.model, onChange: (v) => set({ model: v }), placeholder: '留空用远端默认' }),
    }), React.createElement(Field, {
        label: '运行权限',
        children: React.createElement(Select, {
            value: permCustom ? '__custom__' : form.permission,
            onChange: (v) => {
                if (v === '__custom__') {
                    setPermCustom(true);
                    return;
                }
                setPermCustom(false);
                set({ permission: v });
            },
            options: [
                ...PERMISSIONS,
                { value: '__custom__', label: '自定义…' },
            ],
        }),
    })), permCustom
        ? React.createElement(Field, {
            label: '自定义运行权限',
            children: React.createElement(TextInput, { value: form.permission, onChange: (v) => set({ permission: v }), placeholder: '例如 danger-full-access' }),
        })
        : null, React.createElement(Field, {
        label: '工作目录（远端绝对路径）',
        hint: '该成员远端会话的 cwd：文件工具根目录、附件落盘处；留空用远端默认。',
        children: React.createElement('div', { className: 'onm-row' }, React.createElement('div', { style: { flex: '1 1 200px', minWidth: 0 } }, React.createElement(TextInput, { value: form.workDir, mono: true, onChange: (v) => set({ workDir: v }), placeholder: '如 /data/panzj/workspace/demo' })), React.createElement(Btn, { disabled: !canProbe, title: canProbe ? '浏览远端目录' : '先选择 DSH 实体', onClick: () => setPicker(true) }, '📁 浏览远端…')),
    }), React.createElement('div', { className: 'onm-sub' }, '技能与提示词'), React.createElement(Field, {
        label: '远端已装技能（逗号分隔，派发时写 /名 手势）',
        hint: '点下方按钮从远端拉当前已装技能清单，点选即可加入。',
        children: React.createElement(TextInput, { value: form.skills, onChange: (v) => set({ skills: v }), placeholder: 'baidu-netdisk, kb-bugs' }),
    }), React.createElement('div', { className: 'onm-row' }, React.createElement(Btn, { size: 'sm', disabled: !canProbe || skillBusy, onClick: loadSkills }, skillBusy ? '拉取中…' : '↻ 拉取远端技能清单'), skillOptions && skillOptions.length > 0
        ? React.createElement('span', { className: 'onm-hint' }, `远端 ${skillOptions.length} 个技能，点选切换`)
        : null), skillOptions && skillOptions.length > 0
        ? React.createElement('div', { className: 'onm-chips' }, skillOptions.map((s) => React.createElement('span', {
            key: s.name,
            className: 'onm-chip' + (skills.includes(s.name) ? ' on' : ''),
            title: s.description || s.name,
            onClick: () => toggleSkill(s.name),
        }, s.name)))
        : null, React.createElement(Field, {
        label: '一句话说明（@ 菜单副标题）',
        children: React.createElement(TextInput, { value: form.description, onChange: (v) => set({ description: v }), placeholder: '例如 负责 KB 后端构建与回归' }),
    }), React.createElement(Field, {
        label: '角色提示词（systemPrompt，派发时置于任务之前）',
        children: React.createElement(TextArea, { value: form.systemPrompt, onChange: (v) => set({ systemPrompt: v }), placeholder: '你是……负责……' }),
    }), React.createElement('label', { className: 'onm-row' }, React.createElement('input', { type: 'checkbox', checked: form.enabled, onChange: (e) => set({ enabled: e.target.checked }) }), React.createElement('span', null, '启用（停用后不出现在 @ 菜单）')), picker && ref
        ? React.createElement(DirPicker, {
            dshRef: ref,
            apiKey: form.apiKey || undefined,
            subtitle: form.name || undefined,
            initial: form.workDir || undefined,
            onPick: (path) => {
                set({ workDir: path });
                setPicker(false);
            },
            onClose: () => setPicker(false),
        })
        : null);
}
// ------------------------------------------------------------------ 子智能体
function AgentCard(props) {
    const [editing, setEditing] = React.useState(undefined);
    const [message, setMessage] = React.useState(undefined);
    const [detail, setDetail] = React.useState(undefined);
    const [confirmId, setConfirmId] = React.useState(undefined);
    const ping = (agent) => {
        setDetail(`[${agent.name}] 探测中…`);
        consoleApi
            .agentsPing(agent.id)
            .then((data) => setDetail(`[${agent.name}] 解析入口 ${data?.resolved?.baseUrl || '-'}\n` + JSON.stringify(data?.ping, null, 2)))
            .catch((err) => setDetail(String(err?.message || err)));
    };
    const preview = (agent) => {
        setDetail(`[${agent.name}] 生成中…`);
        consoleApi
            .agentsPreview(agent.id)
            .then((data) => setDetail(`[${agent.name}] 派发提示词预览（脱敏）\n\n${data?.prompt || ''}`))
            .catch((err) => setDetail(String(err?.message || err)));
    };
    const remove = (agent) => {
        if (confirmId !== agent.id) {
            setConfirmId(agent.id);
            setMessage({ kind: 'err', text: `再次点击「删除」确认删除子智能体「${agent.name}」` });
            return;
        }
        consoleApi
            .agentsDelete(agent.id)
            .then(() => {
            setConfirmId(undefined);
            setMessage({ kind: 'ok', text: `已删除「${agent.name}」` });
            props.onChanged();
        })
            .catch((err) => setMessage({ kind: 'err', text: String(err?.message || err) }));
    };
    const refLabel = (agent) => {
        const ref = agent.dshRef || {};
        if (ref.kind === 'direct')
            return ref.apiBaseUrl;
        if (ref.kind === 'app')
            return `应用 ${ref.appId}`;
        return `映射 ${ref.mappingId}`;
    };
    return React.createElement('div', { className: 'onm-card' }, React.createElement('div', { className: 'onm-card-head' }, React.createElement('h3', { className: 'onm-card-title' }, '子智能体', React.createElement(Tag, { tone: 'brand' }, String(props.agents.length))), React.createElement('div', { className: 'onm-spacer' }), React.createElement(Btn, { variant: 'primary', size: 'sm', onClick: () => setEditing(null) }, '＋ 新增')), React.createElement('div', { className: 'onm-muted' }, '子智能体 = ONENAT 上的一个 DSH 实体（只存稳定 ID，端口漂移免疫）。绑好后在输入框打 @ 就能指名派发。'), message ? React.createElement('div', { style: { marginTop: 8 } }, React.createElement(Banner, { kind: message.kind, text: message.text })) : null, props.agents.length === 0
        ? React.createElement('div', { className: 'onm-muted', style: { marginTop: 8 } }, '还没有子智能体，点右上角「新增」创建一个。')
        : React.createElement('div', { className: 'onm-list' }, props.agents.map((agent) => React.createElement('div', { key: agent.id, className: 'onm-item' }, React.createElement('div', { className: 'onm-item-head' }, React.createElement('span', { className: 'onm-item-title' }, '@' + agent.name), agent.enabled === false ? React.createElement(Tag, { tone: 'off' }, '已停用') : React.createElement(Tag, { tone: 'ok' }, '启用'), React.createElement('div', { className: 'onm-spacer' }), React.createElement(Tag, null, agent.model ? `${agent.provider ? agent.provider + ' / ' : ''}${agent.model}` : '远端默认模型')), React.createElement('dl', { className: 'onm-meta' }, React.createElement(MetaRow, { label: '绑定', children: React.createElement('span', { className: 'onm-mono' }, refLabel(agent)) }), React.createElement(MetaRow, { label: '模式', children: agent.agentPreset || 'cordis' }), React.createElement(MetaRow, { label: '工作目录', children: React.createElement('span', { className: 'onm-mono' }, agent.workDir || '远端默认') }), React.createElement(MetaRow, { label: '技能/资源', children: `${(agent.skills || []).length} 技能 · ${(agent.resources || []).length} 资源` })), React.createElement('div', { className: 'onm-actions' }, React.createElement(Btn, { size: 'sm', onClick: () => setEditing(agent) }, '编辑'), React.createElement(Btn, { size: 'sm', onClick: () => ping(agent) }, '探测'), React.createElement(Btn, { size: 'sm', onClick: () => preview(agent) }, '提示词'), React.createElement(Btn, { size: 'sm', variant: 'danger', onClick: () => remove(agent) }, confirmId === agent.id ? '确认删除' : '删除'))))), detail
        ? React.createElement('div', null, React.createElement('div', { className: 'onm-row', style: { marginTop: 10 } }, React.createElement('span', { className: 'onm-sub', style: { margin: 0 } }, '探测详情'), React.createElement('div', { className: 'onm-spacer' }), React.createElement(Btn, { size: 'sm', variant: 'ghost', onClick: () => setDetail(undefined) }, '收起')), React.createElement('pre', { className: 'onm-pre onm-mono' }, detail))
        : null, editing !== undefined
        ? React.createElement(AgentEditor, {
            agent: editing,
            endpoints: props.endpoints,
            onClose: () => setEditing(undefined),
            onSaved: (text) => {
                setEditing(undefined);
                setMessage({ kind: 'ok', text: text + '。输入框 @ 菜单会立即生效。' });
                props.onChanged();
            },
        })
        : null);
}
// ------------------------------------------------------------------- 连接设置
function ConnectionCard(props) {
    const [baseUrl, setBaseUrl] = React.useState(String(props.settings?.onenat?.baseUrl || ''));
    const [apiKey, setApiKey] = React.useState(String(props.settings?.onenat?.apiKey || ''));
    const [reuse, setReuse] = React.useState(props.settings?.defaults?.reuseSession !== false);
    const [timeoutMs, setTimeoutMs] = React.useState(String(props.settings?.defaults?.timeoutMs || 900000));
    const [message, setMessage] = React.useState(undefined);
    const [busy, setBusy] = React.useState(false);
    const [open, setOpen] = React.useState(false);
    React.useEffect(() => {
        setBaseUrl(String(props.settings?.onenat?.baseUrl || ''));
        setApiKey(String(props.settings?.onenat?.apiKey || ''));
        setReuse(props.settings?.defaults?.reuseSession !== false);
        setTimeoutMs(String(props.settings?.defaults?.timeoutMs || 900000));
    }, [props.settings]);
    const save = () => {
        setBusy(true);
        consoleApi
            .settingsSave({
            onenat: { baseUrl, apiKey },
            defaults: { reuseSession: reuse, timeoutMs: Number(timeoutMs) || 900000 },
        })
            .then(() => {
            setMessage({ kind: 'ok', text: '已保存。ONENAT 资源目录将立即按新配置刷新。' });
            props.onSaved();
        })
            .catch((err) => setMessage({ kind: 'err', text: String(err?.message || err) }))
            .finally(() => setBusy(false));
    };
    return React.createElement('div', { className: 'onm-card' }, React.createElement('div', { className: 'onm-card-head' }, React.createElement('h3', { className: 'onm-card-title' }, 'ONENAT 连接与派发默认值'), React.createElement('div', { className: 'onm-spacer' }), React.createElement(Btn, { size: 'sm', variant: 'ghost', onClick: () => setOpen(!open) }, open ? '收起' : '展开')), open
        ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, React.createElement('div', { className: 'onm-grid' }, React.createElement(Field, { label: 'ONENAT 服务地址', children: React.createElement(TextInput, { value: baseUrl, mono: true, onChange: setBaseUrl, placeholder: 'https://onenat.sooncore.com' }) }), React.createElement(Field, { label: 'ONENAT API Key', children: React.createElement(TextInput, { value: apiKey, mono: true, onChange: setApiKey, placeholder: 'onk-…' }) }), React.createElement(Field, { label: '派发超时（毫秒）', children: React.createElement(TextInput, { value: timeoutMs, inputMode: 'numeric', onChange: setTimeoutMs }) })), React.createElement('label', { className: 'onm-row' }, React.createElement('input', { type: 'checkbox', checked: reuse, onChange: (e) => setReuse(e.target.checked) }), React.createElement('span', null, '同一子智能体在本会话中复用远端会话（多轮续聊）')), React.createElement('div', { className: 'onm-row' }, React.createElement(Btn, { variant: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存')), message ? React.createElement(Banner, { kind: message.kind, text: message.text }) : null)
        : React.createElement('div', { className: 'onm-muted' }, 'ONENAT 资源面地址与派发默认值（超时、会话复用）。', baseUrl ? ` 当前：${baseUrl}` : ' 当前未配置。'));
}
// --------------------------------------------------------------- 资源目录
function ResourceCard() {
    const state = useAsync(async () => (await consoleApi.resources(true)) || {}, [], {});
    const endpoints = state.value?.endpoints || [];
    return React.createElement('div', { className: 'onm-card' }, React.createElement('div', { className: 'onm-card-head' }, React.createElement('h3', { className: 'onm-card-title' }, 'ONENAT 资源目录', React.createElement(Tag, { tone: 'brand' }, String(endpoints.length))), React.createElement('div', { className: 'onm-spacer' }), React.createElement(Btn, { size: 'sm', onClick: state.reload, disabled: state.loading }, state.loading ? '刷新中…' : '↻ 刷新')), React.createElement('div', { className: 'onm-muted' }, '在输入框用 @ 可以直接选中下列资源；条目里的公网入口是实时解析结果。'), state.error ? React.createElement('div', { style: { marginTop: 8 } }, React.createElement(Banner, { kind: 'err', text: state.error })) : null, endpoints.length === 0
        ? React.createElement('div', { className: 'onm-muted', style: { marginTop: 8 } }, '暂无资源（检查 ONENAT 地址与 Key，或确认 ONENAT 客户端在线）。')
        : React.createElement('div', { className: 'onm-list' }, endpoints.map((ep) => React.createElement('div', { key: ep.mappingId || ep.appId, className: 'onm-item' }, React.createElement('div', { className: 'onm-item-head' }, React.createElement('span', { className: 'onm-item-title' }, '@' + (ep.appName || ep.note || ep.mappingId)), React.createElement(Tag, { tone: ep.online ? 'ok' : 'off' }, ep.online ? '在线' : '离线'), React.createElement(Tag, null, String(ep.kind || '').toUpperCase()), (ep.appSkills || []).length > 0 ? React.createElement(Tag, null, `${ep.appSkills.length} 技能`) : null), React.createElement('dl', { className: 'onm-meta' }, React.createElement(MetaRow, {
            label: '入口',
            children: React.createElement('span', { className: 'onm-mono' }, ep.kind === 'ssh' ? `ssh -p ${ep.port} @${ep.host}` : ep.baseUrl || `${ep.proto}://${ep.host}:${ep.port || '?'}`),
        }), React.createElement(MetaRow, { label: '隧道', children: ep.tunnelName || '—' }))))));
}
// --------------------------------------------------------------- 本地 SSH 池
const BLANK_SSH = {
    id: '',
    name: '',
    host: '',
    port: '22',
    authType: 'password',
    username: 'root',
    password: '',
    privateKey: '',
    description: '',
};
/** 已有资源 → 表单初值。凭证字段一律留空：留空 = 不修改（Host 侧按 id 合并旧值）。 */
function sshFormFrom(resource) {
    if (!resource)
        return { ...BLANK_SSH };
    return {
        ...BLANK_SSH,
        id: resource.id || '',
        name: resource.name || '',
        host: resource.host || '',
        port: String(resource.port ?? 22),
        authType: resource.authType || 'password',
        username: resource.username || 'root',
        description: resource.description || '',
    };
}
/** SSH 资源编辑器浮层：与子智能体编辑器同一套浮层/表单语言 */
function SshEditor(props) {
    const isEdit = Boolean(props.resource?.id);
    const [form, setForm] = React.useState(() => sshFormFrom(props.resource));
    const [message, setMessage] = React.useState(undefined);
    const [testResult, setTestResult] = React.useState(undefined);
    const [busy, setBusy] = React.useState(false);
    const [testing, setTesting] = React.useState(false);
    const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));
    const save = () => {
        if (!String(form.name || '').trim()) {
            setMessage({ kind: 'err', text: '请填写名称（@ 菜单里显示的名字）' });
            return;
        }
        if (!String(form.host || '').trim()) {
            setMessage({ kind: 'err', text: '请填写主机 IP / 域名' });
            return;
        }
        setBusy(true);
        const payload = { ...form, port: Number(form.port) || 22 };
        // 留空 = 不修改：空串不上送，Host 才会沿用已存凭证（新建时缺凭证仍会明确报错）
        if (!String(payload.password || '').trim())
            delete payload.password;
        if (!String(payload.privateKey || '').trim())
            delete payload.privateKey;
        consoleApi
            .sshSave(payload)
            .then(() => props.onSaved(isEdit ? `已更新「${form.name}」` : `已新增「${form.name}」`))
            .catch((err) => setMessage({ kind: 'err', text: String(err?.message || err) }))
            .finally(() => setBusy(false));
    };
    const test = () => {
        setTesting(true);
        setTestResult('测试中…');
        consoleApi
            .sshTest(form.id)
            .then((data) => {
            setTestResult(JSON.stringify(data, null, 2));
            setMessage({ kind: data?.ok === false ? 'err' : 'ok', text: data?.ok === false ? '连通测试失败，详见下方结果。' : '连通测试通过。' });
        })
            .catch((err) => {
            setTestResult(String(err?.message || err));
            setMessage({ kind: 'err', text: '连通测试失败。' });
        })
            .finally(() => setTesting(false));
    };
    const hasSavedCredential = Boolean(props.resource?.hasPassword || props.resource?.hasPrivateKey);
    return React.createElement(Overlay, {
        title: isEdit ? `编辑 SSH 资源：${form.name || ''}` : '新增 SSH 资源',
        onClose: props.onClose,
        footer: [
            isEdit
                ? React.createElement(Btn, { key: 'test', disabled: testing, onClick: test }, testing ? '测试中…' : '测试连通')
                : null,
            React.createElement('div', { key: 'sp', className: 'onm-spacer' }),
            React.createElement(Btn, { key: 'cancel', onClick: props.onClose }, '取消'),
            React.createElement(Btn, { key: 'save', variant: 'primary', disabled: busy, onClick: save }, busy ? '保存中…' : isEdit ? '保存修改' : '新增'),
        ].filter(Boolean),
    }, React.createElement('div', { className: 'onm-hint' }, '本地 SSH 资源池是 ONENAT 之外的直连补充。@ 菜单里选中后，宿主会把该资源的连接方式（与凭证策略）注入本轮上下文；凭证只在本机存储，不回传远端。'), message ? React.createElement(Banner, { kind: message.kind, text: message.text }) : null, React.createElement('div', { className: 'onm-grid' }, React.createElement(Field, {
        label: '名称（@ 菜单显示）',
        children: React.createElement(TextInput, { value: form.name, onChange: (v) => set({ name: v }), placeholder: '例如 kb-136 生产机' }),
    }), React.createElement(Field, {
        label: '主机 IP / 域名',
        children: React.createElement(TextInput, { value: form.host, mono: true, onChange: (v) => set({ host: v }), placeholder: '192.168.30.136' }),
    }), React.createElement(Field, {
        label: '端口',
        children: React.createElement(TextInput, { value: form.port, inputMode: 'numeric', onChange: (v) => set({ port: v }), placeholder: '22' }),
    }), React.createElement(Field, {
        label: '登录账号',
        children: React.createElement(TextInput, { value: form.username, onChange: (v) => set({ username: v }), placeholder: 'root' }),
    }), React.createElement(Field, {
        label: '认证方式',
        children: React.createElement(Select, {
            value: form.authType,
            onChange: (v) => set({ authType: v }),
            options: [{ value: 'password', label: '密码' }, { value: 'key', label: '私钥（PEM）' }],
        }),
    }), React.createElement(Field, {
        label: '说明（可选）',
        children: React.createElement(TextInput, { value: form.description, onChange: (v) => set({ description: v }), placeholder: '例如 138 测试环境' }),
    })), form.authType === 'password'
        ? React.createElement(Field, {
            label: '密码',
            hint: isEdit && hasSavedCredential ? '已保存密码：留空表示不修改，填写则整体替换。只落在本机存储（~/.dsh）。' : '只落在本机存储（~/.dsh），不会回传远端。',
            children: React.createElement(TextInput, { value: form.password, onChange: (v) => set({ password: v }), placeholder: isEdit && hasSavedCredential ? '不修改请留空' : '登录密码' }),
        })
        : React.createElement(Field, {
            label: '私钥（PEM 全文）',
            hint: isEdit && hasSavedCredential ? '已保存私钥：留空表示不修改，粘贴新私钥则整体替换。' : '以 -----BEGIN 开头，只落在本机存储。',
            children: React.createElement(TextArea, { value: form.privateKey, onChange: (v) => set({ privateKey: v }), rows: 6, placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----' }),
        }), testResult ? React.createElement('pre', { className: 'onm-pre onm-mono' }, testResult) : null);
}
function SshCard(props) {
    const state = useAsync(async () => (await consoleApi.sshList()) || [], [], []);
    const [editing, setEditing] = React.useState(undefined);
    const [message, setMessage] = React.useState(undefined);
    const [detail, setDetail] = React.useState(undefined);
    const resources = Array.isArray(state.value) ? state.value : [];
    return React.createElement('div', { className: 'onm-card' }, React.createElement('div', { className: 'onm-card-head' }, React.createElement('h3', { className: 'onm-card-title' }, '本地 SSH 资源池', React.createElement(Tag, { tone: 'brand' }, String(resources.length))), React.createElement('div', { className: 'onm-spacer' }), React.createElement(Btn, { size: 'sm', variant: 'primary', onClick: () => setEditing(null) }, '＋ 新增')), React.createElement('div', { className: 'onm-muted' }, '补充 ONENAT 之外的直连主机。@ 菜单里选中后，凭证会随资源清单一并交给执行方。'), message ? React.createElement('div', { style: { marginTop: 8 } }, React.createElement(Banner, { kind: message.kind, text: message.text })) : null, resources.length === 0
        ? React.createElement('div', { className: 'onm-muted', style: { marginTop: 8 } }, '暂无本地 SSH 资源，点右上角「新增」添加一台。')
        : React.createElement('div', { className: 'onm-list' }, resources.map((r) => React.createElement('div', { key: r.id, className: 'onm-item' }, React.createElement('div', { className: 'onm-item-head' }, React.createElement('span', { className: 'onm-item-title' }, r.name), r.lastTestOk === undefined
            ? null
            : React.createElement(Tag, { tone: r.lastTestOk ? 'ok' : 'off' }, r.lastTestOk ? '上次连通 ✓' : '上次失败 ✗'), r.hasPassword || r.hasPrivateKey
            ? React.createElement(Tag, null, r.hasPrivateKey ? '私钥' : '密码')
            : React.createElement(Tag, { tone: 'warn' }, '未设凭证')), React.createElement('dl', { className: 'onm-meta' }, React.createElement(MetaRow, { label: '地址', children: React.createElement('span', { className: 'onm-mono' }, `${r.username}@${r.host}:${r.port}`) }), r.description ? React.createElement(MetaRow, { label: '说明', children: r.description }) : null), React.createElement('div', { className: 'onm-actions' }, React.createElement(Btn, {
            size: 'sm',
            onClick: () => {
                setDetail(`[${r.name}] 测试中…`);
                consoleApi.sshTest(r.id).then((d) => setDetail(JSON.stringify(d, null, 2))).catch((e) => setDetail(String(e?.message || e)));
            },
        }, '测试'), React.createElement(Btn, { size: 'sm', onClick: () => setEditing(r) }, '编辑'), React.createElement(Btn, {
            size: 'sm',
            variant: 'danger',
            onClick: () => {
                consoleApi.sshDelete(r.id).then(() => {
                    state.reload();
                    props.onChanged();
                });
            },
        }, '删除'))))), detail ? React.createElement('pre', { className: 'onm-pre onm-mono' }, detail) : null, editing !== undefined
        ? React.createElement(SshEditor, {
            resource: editing,
            onClose: () => setEditing(undefined),
            onSaved: (text) => {
                setEditing(undefined);
                setMessage({ kind: 'ok', text: text + '。@ 菜单会立即生效。' });
                state.reload();
                props.onChanged();
            },
        })
        : null);
}
// --------------------------------------------------- 输入框下方的 @ 状态指示器
/**
 * 输入框下方的一行状态：`@` 源是否已就绪 + 当前能 @ 到多少实体。
 * 它同时是这套集成的自检入口 —— 注册失败/候选拉取失败的原因直接显示在这里。
 */
function MentionStatusLine() {
    const [status, setStatus] = React.useState(STATUS.get());
    React.useEffect(() => STATUS.subscribe(() => setStatus(STATUS.get())), []);
    const [busy, setBusy] = React.useState(false);
    const tone = status.state === 'ready'
        ? 'var(--dsw-alias-state-success-primary, #16a34a)'
        : status.state === 'error'
            ? 'var(--dsw-alias-state-error-primary, #dc2626)'
            : 'var(--dsw-alias-state-warn-primary, #d97706)';
    const label = status.state === 'ready'
        ? `WorkBuddy @ 就绪 · ${status.agentCount} 个子智能体 / ${status.resourceCount} 个资源可 @`
        : `WorkBuddy @ ${status.state === 'error' ? '异常' : '等待中'}：${status.detail}`;
    const refresh = () => {
        setBusy(true);
        void (async () => {
            try {
                const rows = (await consoleApi.candidates('')) || [];
                STATUS.set({
                    state: 'ready',
                    sourceRegistered: STATUS.get().sourceRegistered,
                    agentCount: rows.filter((r) => r.kind === 'agent').length,
                    resourceCount: rows.filter((r) => r.kind === 'resource').length,
                    detail: '已就绪',
                });
            }
            catch (err) {
                STATUS.set({ state: 'error', detail: String(err?.message || err) });
            }
            finally {
                setBusy(false);
            }
        })();
    };
    return React.createElement('div', { className: 'onm-statusline' }, React.createElement('span', { className: 'onm-statusdot', style: { background: tone } }), React.createElement('span', null, label), React.createElement(Btn, { size: 'sm', variant: 'ghost', onClick: refresh, disabled: busy }, busy ? '刷新中…' : '刷新'));
}
// --------------------------------------------------------------- 提及解析自检
function MentionTester() {
    const [text, setText] = React.useState('请 @kb-136-builder 帮我检查一下环境');
    const [result, setResult] = React.useState(undefined);
    return React.createElement('div', { className: 'onm-card' }, React.createElement('h3', { className: 'onm-card-title' }, '提及解析自检'), React.createElement('div', { className: 'onm-muted', style: { marginTop: 6 } }, '验证一段文本会被解析成哪些实体（用于确认 @ 名称是否唯一可辨）。'), React.createElement('div', { className: 'onm-row', style: { marginTop: 8 } }, React.createElement('div', { style: { flex: '1 1 200px', minWidth: 0 } }, React.createElement(TextInput, { value: text, onChange: setText })), React.createElement(Btn, { onClick: () => consoleApi.parse(text).then((d) => setResult(JSON.stringify(d, null, 2))).catch((e) => setResult(String(e?.message || e))) }, '解析')), result ? React.createElement('pre', { className: 'onm-pre onm-mono' }, result) : null);
}
// ---------------------------------------------------------------------- 页面
function Section(props) {
    const settings = useAsync(async () => (await consoleApi.settingsGet()) || {}, [], {});
    const agents = useAsync(async () => (await consoleApi.agentsList()) || [], [], []);
    const resources = useAsync(async () => (await consoleApi.resources(false)) || {}, [], {});
    const refreshAll = () => {
        settings.reload();
        agents.reload();
        resources.reload();
        props.onMentionChanged?.();
    };
    const endpoints = resources.value?.endpoints || [];
    const agentList = Array.isArray(agents.value) ? agents.value : [];
    return React.createElement('div', { className: 'onm-root' }, React.createElement('div', { className: 'onm-muted' }, 'OneNat WorkBuddy @ —— 在 DSH 原生输入框用 @ 指定 ONENAT 上的子智能体与资源。选中即插入胶囊，发送后由宿主把「指认指令」与「资源清单」注入本轮上下文；子智能体派发走 onenat_agent 工具，远端会话按本会话长持复用。'), agents.error ? React.createElement(Banner, { kind: 'err', text: agents.error }) : null, React.createElement(AgentCard, { agents: agentList, endpoints, onChanged: refreshAll }), React.createElement(ConnectionCard, { settings: settings.value, onSaved: refreshAll }), React.createElement(ResourceCard, null), React.createElement(SshCard, { onChanged: refreshAll }), React.createElement(MentionTester, null));
}
// ---------------------------------------------------------------------- apply
export function apply(ctx) {
    const log = (msg) => {
        console.log(`[${NS}] ${msg}`);
    };
    // 1. 样式
    ctx.effect(() => insertStyles(CSS), `${NS}: styles`);
    // 2. @ 输入触发源
    //
    // 用 ctx.inject 等 inputTriggers 就绪，而不是一次性 ctx.get：
    // 客户端插件是按装填顺序并行 apply 的，不能假设 ui-input-trigger 一定先于本插件完成注册。
    // 早前一次性读取会静默跳过注册 —— @ 菜单里就完全不出现 ONENAT 三组候选。
    const mention = createMentionSource(log, (counts) => {
        STATUS.set({ state: 'ready', sourceRegistered: true, ...counts, detail: '已就绪' });
    });
    const ctxAny = ctx;
    if (typeof ctxAny.inject === 'function') {
        ctxAny.inject(['inputTriggers'], (scope) => {
            const triggers = scope.inputTriggers;
            if (triggers === undefined)
                return;
            scope.effect(() => triggers.registerSource(mention.source), `${NS}: @ source`);
            STATUS.set({ state: 'ready', sourceRegistered: true, detail: '已就绪' });
            log('@ 源已注册（候选：ONENAT 子智能体 / ONENAT 资源 / 本地 SSH 资源）');
            void mention.refresh();
        });
    }
    else {
        const inputTriggers = ctxAny.get?.('inputTriggers');
        if (inputTriggers !== undefined) {
            ctx.effect(() => inputTriggers.registerSource(mention.source), `${NS}: @ source`);
            STATUS.set({ state: 'ready', sourceRegistered: true, detail: '已就绪（即时读取）' });
        }
        else {
            STATUS.set({ state: 'error', sourceRegistered: false, detail: 'inputTriggers 服务不可用：@ 菜单未注册（设置页仍可用）' });
            log('inputTriggers 服务不可用：@ 菜单未注册（管理页仍可用）');
        }
    }
    // 3. 设置页（root 作用域，零替换风险）
    ctx.effect(() => ctx.slots.inject('settings.section', () => {
        // NOTE: `{ name: ... }` 必须与 register( 同行内联——注入器骨架校验
        // 用 register\(\{ 前缀正则匹配 slot 名，换行会导致重启恢复被跳过。
        const unregister = ctx.slots.register({ name: 'settings.section', id: 'onenat-workbuddy-mention', order: 42, label: () => 'WorkBuddy @' }, () => React.createElement(Section, { onMentionChanged: () => { void mention.refresh(); } }));
        return () => {
            unregister();
        };
    }), `${NS}: settings section`);
    // 4. 输入框下方状态行（注册失败时这里会直接写出原因）
    ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => {
        // NOTE: `{ name: ... }` 必须与 register( 同行内联——注入器骨架校验
        // 用 register\(\{ 前缀正则匹配 slot 名，换行会导致重启恢复被跳过。
        const unregister = ctx.slots.register({ name: 'conversation.composer.dock', id: 'onenat-workbuddy-mention-status', order: 60 }, MentionStatusLine);
        return () => {
            unregister();
        };
    }), `${NS}: composer status line`);
}
//# sourceMappingURL=index.js.map
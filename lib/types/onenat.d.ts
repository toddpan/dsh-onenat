/**
 * @dsh-external/dsh-onenat - ONENAT 资源目录与解析器
 *
 * 唯一实时数据源: GET /api/v1/resources（+ /api/v1/apps 交叉补充）
 * 解析规则对齐 onenat.md（实测语义）:
 *  - online=false 或缺 public_url ⇒ 不可达，不缓存旧端口
 *  - tcp 隧道承载 HTTP（local 指向 web 端口或绑定 http-api 应用）⇒ 合成 baseUrl
 *  - DSH 实体识别: app.type === 'http-api' 且技能清单含 dsh-web-service（双重校验防绑错）
 *  - 公网端口动态: 每次派发前强刷新，绝不变异缓存 URL（D1）
 */
import type { OnenatCredentials, ResolvedEndpoint, ResourceSnapshot } from './types.js';
export declare function cleanBaseUrl(url: string): string;
export declare class OnenatDirectory {
    private baseUrl;
    private apiKey;
    private log;
    private snapshot;
    private refreshPromise;
    private timer;
    private credCache;
    /**
     * 凭证缓存 TTL。**必须短**：映射实例凭证在 OneNat 后台改完后，本进程缓存最多
     * 只会阻碍这么久（旧实现 10 分钟 ⇒ "设了独立凭证，注入的还是应用默认/旧密码"）。
     * 同时它也是 OneNat 侧 5 次/分限速的保护：30s 内同映射最多取 2 次。
     */
    private static CRED_TTL;
    /** 失败（403/429）负缓存 TTL：只用来挡连环触发，绝不当成功凭证用 */
    private static CRED_NEG_TTL;
    constructor(baseUrl: string, apiKey: string, log?: (msg: string) => void);
    configure(baseUrl: string, apiKey: string): void;
    /**
     * 让某映射（或全部）的凭证缓存立即失效。
     * 调用时机：OneNat 侧改过实例凭证后、以及需要"派发必取最新值"的场合。
     */
    invalidateCredential(mappingId?: string): void;
    get configured(): boolean;
    get endpoint(): string;
    /** 平台 API Key（提示词 [平台接入] 段用；self-fetch 凭证策略需要） */
    get key(): string;
    private headers;
    /** 拉取实时资源快照（并发去重；force 时丢弃缓存） */
    refresh(force?: boolean): Promise<ResourceSnapshot>;
    private doFetch;
    current(): ResourceSnapshot | undefined;
    /** 解析单个映射为当下公网入口；不可达时返回 online=false 的结果（不抛错，由调用方决定跳过） */
    resolveMapping(mappingId: string): ResolvedEndpoint | undefined;
    /** 按应用 ID 反查绑定它的映射（取第一条可达的） */
    resolveApp(appId: string): ResolvedEndpoint | undefined;
    private buildEndpoint;
    /** DSH 型映射速览（供 UI 下拉与自动发现） */
    listDshEndpoints(): ResolvedEndpoint[];
    /** 全量资源清单（供资源目录页展示） */
    listEndpoints(): ResolvedEndpoint[];
    /** 下载应用技能文件全文（url 已自带 key） */
    /**
     * 读取映射实例的有效凭证（映射覆盖优先，回退应用默认）。
     * ONENAT 侧限速 5 次/分 ⇒ 本地缓存，但**成功值与失败值分开计时**：
     * 成功值 30s（保证刚改完凭证就派发也能取到新值），403/429 等失败 15s；
     * 失败值永远不会被当成可用凭证。
     * 返回值带 resolvedFrom（mapping=实例独立 / app=继承应用默认）与 fetchedAt。
     */
    fetchMappingCredentials(mappingId: string, force?: boolean): Promise<OnenatCredentials>;
    /** 对 DSH 端点探活：GET /system/status */
    static pingDsh(baseUrl: string, apiKey?: string): Promise<{
        ok: boolean;
        name?: string;
        version?: string;
        providers?: string[];
        error?: string;
    }>;
    /** 启动周期刷新（60s 级；派发前另有强刷新） */
    startAutoRefresh(intervalMs: number): void;
    stopAutoRefresh(): void;
}

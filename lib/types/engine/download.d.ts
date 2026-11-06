/**
 * 流式下载。
 *
 * 三个硬要求来自"在 DSH 主进程里下载"这个场景：
 *
 *  1. **不整块读进内存。** 客户端归档 7–15MB，DSH 主进程同时还活着整个
 *     桌面的会话。一次 `arrayBuffer()` 会在用户点"安装"的那一瞬间多出一个
 *     15MB 的常驻 Buffer，而且这正好发生在界面最需要响应的时候。所以全程
 *     流式，边下边算 sha256。
 *  2. **只允许 https，且每一跳重定向都必须是 https。** GitHub 的资产下载
 *     会 302 到 `objects.githubusercontent.com`，仍然是 https；但从 https
 *     跳到 http 意味着后续字节可被中间人替换。所以每一跳都单独判协议，
 *     而不是"开头是 https 就行"。
 *  3. **重试要分清错误种类。** 5xx / 429 / 网络抖动值得重试；404 这类 4xx
 *     重试一万次也是 404，纯粹浪费用户的电和时间。
 *
 * 另外：文件先写 `.part` 临时文件，成功后再 rename。中途失败不会留下一个
 * "看起来下载完了、其实缺了尾巴"的文件被后续步骤当成完整资产。
 */
/** 允许的最大重定向跳数。GitHub 实际是 1 跳；留到 5 跳给镜像站。 */
export declare const MAX_REDIRECTS = 5;
/** 默认重试次数（不含首次尝试）。 */
export declare const DEFAULT_RETRIES = 3;
/** 默认空闲超时：多久没有新数据就判定连接卡死。 */
export declare const DEFAULT_TIMEOUT_MS = 30000;
/** 下载进度。 */
export interface DownloadProgress {
    bytesDone: number;
    bytesTotal: number | null;
}
/** 下载结果。 */
export interface DownloadResult {
    /** 落盘字节数。 */
    bytes: number;
    /** 边下边算出的 sha256（小写 hex）。 */
    sha256: string;
    /** 跟随重定向后的最终 URL。 */
    finalUrl: string;
}
/** 判断异常是不是"用户取消"。 */
export declare function isAbortError(error: unknown): boolean;
/**
 * 下载到本地文件，边下边算 sha256，成功后原子 rename 到 `dest`。
 *
 * 失败时 `dest` 不会被创建或覆盖（临时文件会被清掉），调用方拿到的要么是
 * 一个完整文件，要么是"没有文件"。
 */
export declare function downloadToFile(options: {
    url: string;
    dest: string;
    signal?: AbortSignal;
    onProgress?: (progress: DownloadProgress) => void;
    timeoutMs?: number;
    retries?: number;
}): Promise<DownloadResult>;
/**
 * 拉一小段文本（checksums.txt、GitHub API 响应都用它）。
 *
 * 有大小上限：拿到的东西要是别的东西（比如一个 HTML 错误页），宁可直接失败，
 * 也不要拿它去解析。
 */
export declare function fetchText(url: string, options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    accept?: string;
    retries?: number;
    headers?: Record<string, string>;
}): Promise<string>;
/** 把任意异常变成一句人能看懂的话（供上层拼进作业错误信息）。 */
export declare function describeDownloadError(error: unknown): string;

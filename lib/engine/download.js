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
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { finished } from 'node:stream/promises';
/** 允许的最大重定向跳数。GitHub 实际是 1 跳；留到 5 跳给镜像站。 */
export const MAX_REDIRECTS = 5;
/** 默认重试次数（不含首次尝试）。 */
export const DEFAULT_RETRIES = 3;
/** 默认空闲超时：多久没有新数据就判定连接卡死。 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 重试退避基数（毫秒）：0.5s、1s、2s…… */
const RETRY_BASE_MS = 500;
/** `fetchText` 的响应体上限（checksums.txt 只有几百字节）。 */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const USER_AGENT = 'dsh-onenat-engine';
/** HTTP 状态码错误：带上状态码与 URL，用于区分"该重试"和"该换源"。 */
class HttpError extends Error {
    status;
    constructor(status, statusText, url) {
        super(`HTTP ${status}${statusText.trim() === '' ? '' : ` ${statusText.trim()}`} (${url})`);
        this.name = 'HttpError';
        this.status = status;
    }
}
/** 重试没有意义的错误（协议不对、重定向超限、响应体过大……）。 */
class PermanentError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PermanentError';
    }
}
/** 判断异常是不是"用户取消"。 */
export function isAbortError(error) {
    return error instanceof Error && error.name === 'AbortError';
}
function abortError() {
    const error = new Error('已取消');
    error.name = 'AbortError';
    return error;
}
/**
 * 这个错误值不值得重试。
 *
 * 429（限速）与 5xx（服务端临时故障）值得；其余 4xx 是"这个 URL 不存在"，
 * 重试只是让用户多等。协议类错误（http、跳数超限）重试多少次都一样。
 */
function isRetryable(error) {
    if (error instanceof PermanentError)
        return false;
    if (error instanceof HttpError)
        return error.status === 429 || error.status >= 500;
    return true;
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 可被 AbortSignal 打断的 sleep。 */
function sleep(ms, signal) {
    if (signal?.aborted === true)
        return Promise.reject(abortError());
    return new Promise((resolve_, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve_();
        }, ms);
        function onAbort() {
            clearTimeout(timer);
            reject(abortError());
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
/** 把外部 signal 的中止传导到内部 controller；返回解绑函数。 */
function linkAbort(parent, child) {
    if (parent === undefined)
        return () => { };
    if (parent.aborted) {
        child.abort();
        return () => { };
    }
    const onAbort = () => child.abort();
    parent.addEventListener('abort', onAbort, { once: true });
    return () => parent.removeEventListener('abort', onAbort);
}
/** 只接受 https。其它协议在源头就拒掉。 */
function requireHttps(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new PermanentError(`下载地址不是合法 URL：${url}`);
    }
    if (parsed.protocol !== 'https:') {
        throw new PermanentError(`只允许 https 下载地址，已拒绝 ${parsed.protocol}// (${url})`);
    }
    return parsed.toString();
}
function isRedirect(status) {
    return status >= 300 && status < 400;
}
async function discardBody(response) {
    try {
        await response.body?.cancel();
    }
    catch {
        /* 丢弃失败不影响主流程 */
    }
}
/**
 * 发起请求并手动跟随重定向，返回一个**未读完**的响应。
 *
 * 超时语义是"空闲超时"：只要还在持续收到数据就一直续期。对 15MB 的包来说，
 * "总时长上限"会把慢速但健康的下载误杀，"无数据上限"才真正对应卡死的连接。
 */
async function fetchFollowing(url, options) {
    const controller = new AbortController();
    let timedOut = false;
    let timer = null;
    const touch = () => {
        if (timer !== null)
            clearTimeout(timer);
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, options.timeoutMs);
    };
    const unlink = linkAbort(options.signal, controller);
    const cleanup = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        unlink();
    };
    touch();
    let current = url;
    try {
        for (let hop = 0;; hop += 1) {
            let response;
            try {
                response = await fetch(current, {
                    redirect: 'manual',
                    signal: controller.signal,
                    headers: {
                        'user-agent': USER_AGENT,
                        accept: options.accept,
                        // 认证头只在**首跳**附加：跳到别的 host（GitHub 的资产 CDN）时带上
                        // token 既没用也是一种泄露风险。
                        ...(hop === 0 ? (options.headers ?? {}) : {}),
                    },
                });
            }
            catch (error) {
                if (options.signal?.aborted === true)
                    throw abortError();
                if (timedOut)
                    throw new Error(`请求超时（${options.timeoutMs} 毫秒内没有响应）：${current}`);
                throw error;
            }
            if (isRedirect(response.status)) {
                const location = response.headers.get('location');
                await discardBody(response);
                if (location === null || location.trim() === '') {
                    throw new PermanentError(`HTTP ${response.status} 重定向响应缺少 Location 头 (${current})`);
                }
                if (hop >= MAX_REDIRECTS) {
                    throw new PermanentError(`重定向次数超过上限 ${MAX_REDIRECTS} 次 (${url})`);
                }
                const next = new URL(location, current);
                // 每一跳都必须仍是 https：从 https 降级到 http 意味着后续字节不再有
                // 传输层保护，哪怕后面还有 sha256 兜底，也不该在协议层就先松口。
                if (next.protocol !== 'https:') {
                    throw new PermanentError(`重定向目标不是 https，已拒绝：${next.toString()}`);
                }
                current = next.toString();
                touch();
                continue;
            }
            return { response, finalUrl: current, touch, timedOut: () => timedOut, cleanup };
        }
    }
    catch (error) {
        cleanup();
        throw error;
    }
}
function parseContentLength(value) {
    if (value === null)
        return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
/** 读响应体时的异常翻译：区分"用户取消"、"空闲超时"和真正的传输错误。 */
function translateStreamError(error, handle, signal, timeoutMs) {
    if (signal?.aborted === true)
        return abortError();
    if (handle.timedOut())
        return new Error(`下载超时（${timeoutMs} 毫秒内没有收到新数据）：${handle.finalUrl}`);
    return error;
}
/** 带指数退避的重试包装。 */
async function withRetries(retries, signal, run) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (signal?.aborted === true)
            throw abortError();
        try {
            return await run();
        }
        catch (error) {
            lastError = error;
            if (isAbortError(error) || !isRetryable(error) || attempt === retries)
                break;
            await sleep(RETRY_BASE_MS * 2 ** attempt, signal);
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
/**
 * 下载到本地文件，边下边算 sha256，成功后原子 rename 到 `dest`。
 *
 * 失败时 `dest` 不会被创建或覆盖（临时文件会被清掉），调用方拿到的要么是
 * 一个完整文件，要么是"没有文件"。
 */
export async function downloadToFile(options) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = options.retries ?? DEFAULT_RETRIES;
    const target = requireHttps(options.url);
    return withRetries(retries, options.signal, () => downloadOnce(target, options.dest, options.signal, timeoutMs, options.onProgress));
}
async function downloadOnce(url, dest, signal, timeoutMs, onProgress) {
    const handle = await fetchFollowing(url, { timeoutMs, signal, accept: '*/*' });
    const temp = `${dest}.part`;
    try {
        if (!handle.response.ok) {
            throw new HttpError(handle.response.status, handle.response.statusText, handle.finalUrl);
        }
        const body = handle.response.body;
        if (body === null)
            throw new Error(`响应没有内容 (${handle.finalUrl})`);
        const total = parseContentLength(handle.response.headers.get('content-length'));
        const out = createWriteStream(temp);
        // 写流出错（磁盘满等）是异步事件；不挂监听会变成未捕获异常直接崩进程。
        let writeError = null;
        out.on('error', (error) => {
            writeError = error;
        });
        // 边下边算：sha256 与落盘用同一条字节流，不额外读一遍文件。
        const hash = createHash('sha256');
        let bytesDone = 0;
        onProgress?.({ bytesDone: 0, bytesTotal: total });
        const reader = body.getReader();
        try {
            for (;;) {
                const step = await reader.read();
                if (step.done)
                    break;
                const chunk = step.value;
                if (chunk === undefined || chunk.byteLength === 0)
                    continue;
                bytesDone += chunk.byteLength;
                hash.update(chunk);
                onProgress?.({ bytesDone, bytesTotal: total });
                handle.touch();
                if (!out.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
                    await once(out, 'drain');
                }
                if (writeError !== null)
                    throw writeError;
            }
        }
        catch (error) {
            await reader.cancel().catch(() => { });
            out.destroy();
            rmSync(temp, { force: true });
            throw translateStreamError(error, handle, signal, timeoutMs);
        }
        out.end();
        await finished(out);
        if (writeError !== null) {
            rmSync(temp, { force: true });
            throw writeError;
        }
        renameSync(temp, dest);
        return { bytes: bytesDone, sha256: hash.digest('hex'), finalUrl: handle.finalUrl };
    }
    finally {
        handle.cleanup();
    }
}
/**
 * 拉一小段文本（checksums.txt、GitHub API 响应都用它）。
 *
 * 有大小上限：拿到的东西要是别的东西（比如一个 HTML 错误页），宁可直接失败，
 * 也不要拿它去解析。
 */
export async function fetchText(url, options) {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = options?.retries ?? DEFAULT_RETRIES;
    const target = requireHttps(url);
    return withRetries(retries, options?.signal, () => readTextOnce(target, timeoutMs, options?.signal, options?.accept ?? 'application/json, text/plain, */*', options?.headers));
}
async function readTextOnce(url, timeoutMs, signal, accept, headers) {
    const handle = await fetchFollowing(url, { timeoutMs, signal, accept, headers });
    try {
        if (!handle.response.ok) {
            throw new HttpError(handle.response.status, handle.response.statusText, handle.finalUrl);
        }
        const body = handle.response.body;
        if (body === null)
            return '';
        const reader = body.getReader();
        const chunks = [];
        let received = 0;
        try {
            for (;;) {
                const step = await reader.read();
                if (step.done)
                    break;
                const chunk = step.value;
                if (chunk === undefined || chunk.byteLength === 0)
                    continue;
                received += chunk.byteLength;
                if (received > MAX_TEXT_BYTES) {
                    throw new PermanentError(`响应体超过 ${MAX_TEXT_BYTES} 字节上限，已放弃 (${handle.finalUrl})`);
                }
                chunks.push(chunk);
                handle.touch();
            }
        }
        catch (error) {
            await reader.cancel().catch(() => { });
            throw translateStreamError(error, handle, signal, timeoutMs);
        }
        return new TextDecoder().decode(Buffer.concat(chunks, received));
    }
    finally {
        handle.cleanup();
    }
}
/** 把任意异常变成一句人能看懂的话（供上层拼进作业错误信息）。 */
export function describeDownloadError(error) {
    if (isAbortError(error))
        return '已取消';
    if (error instanceof HttpError)
        return error.message;
    if (error instanceof PermanentError)
        return error.message;
    return describe(error);
}
//# sourceMappingURL=download.js.map
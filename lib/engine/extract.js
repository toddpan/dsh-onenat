/**
 * 归档解包。
 *
 * 解包是整条安装链路上唯一"把外部字节变成可执行文件"的一步，所以安全检查
 * 不是锦上添花，而是必须自己一字节一字节地判：
 *
 *  1. **路径穿越（tar-slip）**：每个条目解出来的绝对路径必须仍在目标目录
 *     之内。绝对路径、盘符（`C:\`）、含 `..` 的条目一律拒绝 —— 上游包一旦
 *     被替换（仓库被接管、镜像被投毒），这几条是唯一的防线。
 *  2. **不落符号链接/硬链接/设备节点**：链接可以把写入重定向到目标目录之外
 *     （先建一个指向 `/etc` 的链接，再往里写文件）。所以非普通文件/目录的
 *     条目一律跳过。
 *  3. **解压炸弹**：单条目与总量都设上限，条目数也设上限。
 *  4. **不信任归档里的权限位**：`chmod: false`，可执行位由我们显式设置成
 *     0755。归档里写 `0777` 的文件不该真的变成 0777。
 *
 * **不支持 .zip。** 上游 Windows 平台只发 `.zip`，而引入 zip 依赖要么带
 * 原生依赖、要么在 Node 上并不可靠（本插件明确不引入 zip 库）。所以遇到
 * zip 资产时**明确报错**，而不是"试试看"或者"悄悄跳过"。
 *
 * 上游归档里的可执行文件叫 `ngrok`（不是 `onenat-client`），所以解包之后
 * 还要认一次"哪个才是那个二进制"，见 `findBinaryFile`。
 */
import { chmod, copyFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as tar from 'tar';
/** 单个条目解压后的大小上限（256MB）。客户端二进制约 15MB。 */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
/** 一次解压的总体积上限（512MB）。 */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/** 条目数上限：纯粹的放大攻击（百万条空文件）也会拖垮磁盘和 inode。 */
const MAX_ENTRIES = 100_000;
/** 解压后的可执行文件权限：rwxr-xr-x。 */
export const EXECUTABLE_MODE = 0o755;
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * 把归档内的相对路径映射成目标目录内的绝对路径；不安全则返回 null。
 *
 * 这是 tar-slip 的唯一防线，所以判得啰嗦：先否掉绝对路径与盘符，再否掉
 * 任何 `..` 段，最后用 resolve 之后的路径前缀做兜底（防 `a/../../b` 这类
 * 只在 resolve 之后才显形的写法）。
 */
function safeTarget(destDir, rawName) {
    const name = rawName.trim();
    if (name === '' || name.includes('\0'))
        return null;
    // 反斜杠在 POSIX 上本是合法文件名字符，但归档里出现它通常意味着 Windows
    // 路径或有人故意构造歧义路径，一律拒绝比"猜他想干什么"安全。
    if (name.includes('\\'))
        return null;
    if (isAbsolute(name))
        return null;
    if (/^[A-Za-z]:/.test(name))
        return null;
    const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0)
        return null;
    if (segments.some((segment) => segment === '..'))
        return null;
    const target = resolve(destDir, ...segments);
    if (target !== destDir && !target.startsWith(`${destDir}${sep}`))
        return null;
    return target;
}
/** 目标目录必须全新：不清空别人的目录，宁可报错让上层换个 staging。 */
async function assertUsableDir(dir) {
    try {
        const entries = await readdir(dir);
        if (entries.length > 0) {
            throw new Error(`解压目标目录非空：${dir}（应当是一个全新的 staging 目录）`);
        }
    }
    catch (error) {
        if (isEnoent(error)) {
            await stat(dir).catch(() => undefined);
            return;
        }
        throw error;
    }
}
function isEnoent(error) {
    return typeof error === 'object' && error !== null && error.code === 'ENOENT';
}
/**
 * 解 .tar.gz。
 *
 * 两遍法：第一遍只读目录（不写盘），把整个包"审"一遍；审过之后第二遍才按
 * 白名单落盘。这样一个被投毒的包不会在目标目录里留下任何半成品。
 */
async function extractTar(archive, destDir, onProgress) {
    const listed = [];
    await tar.t({
        file: archive,
        onwarn: (code, message) => {
            onProgress?.({ entriesDone: 0, entriesTotal: null, message: `tar 警告 ${code}: ${message}` });
        },
        onentry: (entry) => {
            listed.push({ path: entry.path, type: entry.type, size: entry.size, meta: entry.meta });
        },
    });
    if (listed.length > MAX_ENTRIES)
        throw new Error(`归档条目数 ${listed.length} 超过上限 ${MAX_ENTRIES}`);
    const allowed = new Set();
    let declaredTotal = 0;
    for (const item of listed) {
        // PaxHeader/ExtendedHeader 之类的元条目不是文件，tar 自己会消费掉。
        if (item.meta || item.path === '')
            continue;
        const isDirectory = item.type === 'Directory';
        const isFile = item.type === 'File' || item.type === 'OldFile' || item.type === 'ContiguousFile';
        if (!isDirectory && !isFile) {
            onProgress?.({
                entriesDone: 0,
                entriesTotal: listed.length,
                message: `已跳过非普通文件条目（${item.type}）：${item.path}`,
            });
            continue;
        }
        if (safeTarget(destDir, item.path) === null) {
            onProgress?.({ entriesDone: 0, entriesTotal: listed.length, message: `已跳过不安全路径条目：${item.path}` });
            continue;
        }
        if (isFile) {
            if (item.size > MAX_ENTRY_BYTES) {
                throw new Error(`条目 ${item.path} 声明的解压后大小 ${item.size} 超过上限 ${MAX_ENTRY_BYTES}`);
            }
            declaredTotal += item.size;
            if (declaredTotal > MAX_TOTAL_BYTES) {
                throw new Error(`归档声明的解压总量超过上限 ${MAX_TOTAL_BYTES} 字节，已中止`);
            }
        }
        allowed.add(item.path);
    }
    let filesWritten = 0;
    let done = 0;
    await tar.x({
        file: archive,
        cwd: destDir,
        // 路径策略完全由上面的白名单决定：不让 tar 做任何"帮忙"的路径加工，
        // 也不让它按归档里的权限位 chmod（可执行位由 ensureExecutableMode 设置）。
        preservePaths: false,
        strict: false,
        chmod: false,
        filter: (path, entry) => {
            if (!allowed.has(path))
                return false;
            done += 1;
            const isDirectory = 'type' in entry && entry.type === 'Directory';
            if (!isDirectory)
                filesWritten += 1;
            onProgress?.({
                entriesDone: done,
                entriesTotal: allowed.size,
                message: isDirectory ? `正在创建目录 ${path}` : `正在解压 ${path}`,
            });
            return true;
        },
        onwarn: (code, message) => {
            onProgress?.({ entriesDone: done, entriesTotal: allowed.size, message: `tar 警告 ${code}: ${message}` });
        },
    });
    return { filesWritten, binaryPath: null, topLevelEntries: await listTopLevel(destDir) };
}
/** 裸可执行文件资产：直接复制进目标目录。 */
async function extractBinary(archive, destDir, onProgress) {
    const name = basename(archive);
    const target = join(destDir, name);
    await copyFile(archive, target);
    onProgress?.({ entriesDone: 1, entriesTotal: 1, message: `已落位可执行文件 ${name}` });
    return { filesWritten: 1, binaryPath: target, topLevelEntries: [name] };
}
/** 列出目标目录的顶层条目名。 */
async function listTopLevel(dir) {
    try {
        return await readdir(dir);
    }
    catch {
        return [];
    }
}
/**
 * 解包入口。
 *
 * `kind` 由 `platform.ts` 的 `assetKindForFile` 判定，不在这里猜后缀 ——
 * 猜错会拿 tar 去解 zip，然后报一个驴唇不对马嘴的错。
 */
export async function extractArchive(options) {
    const destDir = resolve(options.destDir);
    await assertUsableDir(destDir);
    if (options.kind === 'zip') {
        throw new Error('上游该平台只发布了 .zip 归档，本插件不引入 zip 解包依赖，无法安装。' +
            '请在 macOS / Linux 上使用，或手动放置 onenat-client 可执行文件。');
    }
    if (options.kind === 'tar.gz')
        return extractTar(options.archive, destDir, options.onProgress);
    return extractBinary(options.archive, destDir, options.onProgress);
}
/**
 * 归档里只有一个顶层目录时，把它的内容上移一层。
 *
 * 上游不同版本的打包方式不一致：有的平铺、有的套一层 `ngrok/`。上移之后
 * 两种形态在磁盘上一致，调用方只需在固定位置找二进制。
 *
 * 踩过的坑：顶层目录名可能和它内部的条目同名（`ngrok/ngrok`），直接 rename
 * 会撞到目录自身（EISDIR）。所以先把整个顶层目录改成一个随机临时名，再把
 * 内容搬上来，最后删掉空壳。
 */
export async function flattenSingleTopDir(destDir) {
    const root = resolve(destDir);
    const top = (await listTopLevel(root)).filter((name) => !isMetadataEntry(name));
    if (top.length !== 1)
        return false;
    const only = top[0];
    if (only === undefined)
        return false;
    const nested = join(root, only);
    let info;
    try {
        info = await stat(nested);
    }
    catch {
        return false;
    }
    if (!info.isDirectory())
        return false;
    const holding = join(root, `.flatten-${process.pid}-${Date.now().toString(16)}`);
    await rename(nested, holding);
    try {
        for (const child of await readdir(holding)) {
            await rename(join(holding, child), join(root, child));
        }
    }
    finally {
        await rm(holding, { recursive: true, force: true });
    }
    return true;
}
/** macOS 元数据条目：它们不是包内容，判定布局时必须当它们不存在。 */
function isMetadataEntry(name) {
    return name === '.DS_Store' || name.startsWith('._');
}
/**
 * 找出解包出来的那个"二进制"。
 *
 * 优先认约定的名字（`onenat-client` / `ngrok`），其次认"整棵树里唯一的普通
 * 文件"。都不成立就报错并把候选列出来 —— 让人来猜比让程序瞎选安全。
 */
export async function findBinaryFile(dir, preferred = ['onenat-client', 'onenat-client.exe', 'ngrok', 'ngrok.exe']) {
    const root = resolve(dir);
    const files = await collectRegularFiles(root);
    for (const name of preferred) {
        const direct = join(root, name);
        if (files.includes(direct))
            return direct;
    }
    if (files.length === 1)
        return files[0] ?? null;
    return null;
}
/** 递归列出普通文件（不跟随符号链接：跟着走会跑出目录去读别的文件）。 */
async function collectRegularFiles(dir) {
    const found = [];
    const walk = async (current) => {
        let names;
        try {
            names = await readdir(current);
        }
        catch {
            return;
        }
        for (const name of names) {
            if (isMetadataEntry(name))
                continue;
            const path = join(current, name);
            let info;
            try {
                info = await stat(path);
            }
            catch {
                continue;
            }
            if (info.isDirectory())
                await walk(path);
            else if (info.isFile())
                found.push(path);
        }
    };
    await walk(dir);
    return found;
}
/** 给二进制补上可执行位。Windows 上 chmod 没有意义，失败也只是忽略。 */
export async function ensureExecutableMode(file) {
    try {
        await chmod(file, EXECUTABLE_MODE);
    }
    catch (error) {
        if (process.platform !== 'win32') {
            throw new Error(`设置可执行权限失败：${file}（${describe(error)}）`);
        }
    }
}
/** 删除 staging 目录（失败也不抛：清理是尽力而为）。 */
export async function removeQuietly(dir) {
    try {
        await rm(dir, { recursive: true, force: true });
    }
    catch {
        /* 忽略 */
    }
}
/** 相对路径展示（错误信息里用，避免把绝对路径刷屏）。 */
export function relativeTo(root, target) {
    const rel = relative(resolve(root), resolve(target));
    return rel === '' ? '.' : rel;
}
//# sourceMappingURL=extract.js.map
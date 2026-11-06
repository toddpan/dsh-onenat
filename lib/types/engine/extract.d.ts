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
import type { AssetKind } from './platform.js';
/** 解压后的可执行文件权限：rwxr-xr-x。 */
export declare const EXECUTABLE_MODE = 493;
/** 解包进度。 */
export interface ExtractProgress {
    entriesDone: number;
    entriesTotal: number | null;
    message: string;
}
/** 解包结果。 */
export interface ExtractResult {
    /** 实际写出的文件数。 */
    filesWritten: number;
    /** 解包后二进制所在路径。 */
    binaryPath: string | null;
    /** 顶层条目名（用于诊断）。 */
    topLevelEntries: string[];
}
/**
 * 解包入口。
 *
 * `kind` 由 `platform.ts` 的 `assetKindForFile` 判定，不在这里猜后缀 ——
 * 猜错会拿 tar 去解 zip，然后报一个驴唇不对马嘴的错。
 */
export declare function extractArchive(options: {
    archive: string;
    kind: AssetKind;
    destDir: string;
    onProgress?: (progress: ExtractProgress) => void;
}): Promise<ExtractResult>;
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
export declare function flattenSingleTopDir(destDir: string): Promise<boolean>;
/**
 * 找出解包出来的那个"二进制"。
 *
 * 优先认约定的名字（`onenat-client` / `ngrok`），其次认"整棵树里唯一的普通
 * 文件"。都不成立就报错并把候选列出来 —— 让人来猜比让程序瞎选安全。
 */
export declare function findBinaryFile(dir: string, preferred?: readonly string[]): Promise<string | null>;
/** 给二进制补上可执行位。Windows 上 chmod 没有意义，失败也只是忽略。 */
export declare function ensureExecutableMode(file: string): Promise<void>;
/** 删除 staging 目录（失败也不抛：清理是尽力而为）。 */
export declare function removeQuietly(dir: string): Promise<void>;
/** 相对路径展示（错误信息里用，避免把绝对路径刷屏）。 */
export declare function relativeTo(root: string, target: string): string;

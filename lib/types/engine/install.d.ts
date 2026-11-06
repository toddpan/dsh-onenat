/**
 * 安装编排。
 *
 * 顺序是**不可改**的，每一步都为下一步提供前提：
 *
 *   解析发行版 → 下载 → **先校验 sha256** → 解包/落位 → chmod 0755 →
 *   原子就位到 versions/<version>/ → 写 current 指针
 *
 * "先校验后解包"是硬要求：校验必须在**任何字节变成可执行文件之前**完成。
 * 反过来做（先解包再校验）的话，一个被投毒的包已经躺在磁盘上等着被运行了，
 * 校验只是"事后发现"。
 *
 * 幂等：目标版本已经装好且 current 指针指向它时，直接返回成功（除非 force）。
 * 这不是省事，是**必须**：设置页会轮询状态，用户连点两次"安装"是常态，
 * 两次都重新下载 8MB 纯属浪费。
 */
import { type PlatformTag } from './platform.js';
/** 安装过程的进度。 */
export interface InstallProgress {
    phase: 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'installing';
    message?: string;
    percent?: number | null;
    bytesDone?: number;
    bytesTotal?: number | null;
}
/** 安装结果。 */
export interface InstallResult {
    /** 版本目录名（= release tag 的安全化形式）。 */
    version: string;
    tag: string;
    /** 资产文件名。 */
    assetFile: string;
    /** 发行版来源。 */
    source: 'github' | 'baked';
    /** 落位后的二进制路径。 */
    binaryPath: string;
    /** 实测 sha256。 */
    sha256: string | null;
    /** 是否真的校验过（上游没给校验值时为 false）。 */
    verified: boolean;
    /** true = 什么都没做（已经是这个版本了）。 */
    noop: boolean;
}
/** 安装选项。 */
export interface InstallOptions {
    /** 引擎根目录。 */
    root: string;
    /** GitHub 仓库（默认 `toddpan/onenat`）。 */
    repo?: string;
    /** 指定 release tag；不给就是 latest。 */
    version?: string;
    /** 强制重装（即使版本相同也重新下载）。 */
    force?: boolean;
    /** 是否允许联网解析发行版。 */
    allowNetwork?: boolean;
    /** 取消信号。 */
    signal?: AbortSignal;
    /** 目标平台；默认按当前进程推断。 */
    platform?: PlatformTag | null;
    /** 进度回调。 */
    onProgress?: (progress: InstallProgress) => void;
}
/** 每个版本的安装元信息。 */
export interface InstallMeta {
    version: string;
    tag: string;
    assetFile: string;
    source: 'github' | 'baked';
    url: string;
    sha256: string | null;
    verified: boolean;
    installedAt: number;
}
/** 安装（或重装）oneNat 客户端。 */
export declare function installClient(options: InstallOptions): Promise<InstallResult>;
/** 读取某个版本的安装元信息（没有则 null）。 */
export declare function readInstallMeta(root: string, version: string): InstallMeta | null;
/** 当前指针指向的版本（宿主侧查询用）。 */
export declare function currentVersion(root: string): string | null;
/** 当前指针文件路径（诊断用）。 */
export declare function pointerPath(root: string): string;

/**
 * 校验值计算。
 *
 * 流式算是硬要求，不是风格问题：客户端归档 7–15MB，一次 `readFileSync` 会在
 * DSH 主进程里多出同量级的常驻内存，而且恰好发生在用户点"安装"、桌面最需要
 * 响应的时候。
 *
 * 上游 oneNat 的 `checksums.txt` 用 **sha256**（不是 md5），格式是
 * `<hex>  <文件名>`（两个空格，GNU coreutils 的默认文本模式输出）。
 */
/** 小写 hex 的 sha256（流式）。 */
export declare function sha256File(file: string): Promise<string>;
/** 小写 hex 的 md5（流式）。oneNat 上游用 sha256，md5 只是兜底能力。 */
export declare function md5File(file: string): Promise<string>;
/** 合法 sha256 的形态：64 位小写 hex。 */
export declare function isSha256(value: string): boolean;
/** 两个 sha256 是否一致（大小写不敏感）。 */
export declare function sha256Matches(expected: string, actual: string): boolean;
/**
 * 给人看的一句话说明"这次装包会被怎么校验"。
 *
 * 没有可用校验值时必须说清楚 —— 静默地"没校验就装上"是最危险的默认值。
 */
export declare function describeVerification(expectedSha256: string | null, actualSha256?: string | null): string;

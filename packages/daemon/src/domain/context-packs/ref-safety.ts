// Slice-03 rig-context v1（OPR.0.5.0.3）——强化寻址契约（§2“唯一必须正确的事项”）。
// 从冻结候选中恢复 assertSafePackName（37972eb6）与 isSafePackVersion（b10c1618），
// 并按强制 BEND 调整：ref 是类似路径的多段值，因此单组件名称检查改为在相同字符集上
// 逐段检查。这样既保留全部加固性质（禁止遍历、绝对路径、空段、空白及 YAML/ID 注入），
// 又支持 `packs/compaction-restore` 形式的 ref。版本 token 仍是有界、无分隔符的单 token
//（修复 R2 (a) ENAMETOOLONG 与 (b) 中 store ID 的一半问题）。

// 单个安全路径段：恢复的字符集白名单（首字符为字母或数字，随后允许字母数字/._-；不超过 64 字符）。
// 该白名单本身禁止 '/'、空白、':'、换行与引号，覆盖全部路径遍历及 YAML/ID 注入向量；
// 首字符规则同时拒绝 '.'、'..' 与点文件。
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// 有界、无分隔符的版本 token——逐字恢复自检查点 b10c1618（manifest-parser.ts）。
// 32 字符上限使 `${name}-${version}.md` 远低于操作系统 255 字节文件名限制，
// 且字符集不允许任何可伪造 store ID 的分隔符。
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;

/**
 * 类路径 pack ref 由一个或多个 `/` 分隔的安全路径段组成。空 ref、绝对路径
 *（首段为空）、双斜杠或尾斜杠（产生空段）、'.'/'..' 遍历段，以及段内任何注入字符
 * 都是不安全输入。
 */
export function isSafePackRef(ref: string): boolean {
  if (ref.length === 0) return false;
  for (const segment of ref.split("/")) {
    if (segment.length === 0) return false; // 绝对路径开头、内部 '//' 或尾部 '/'。
    if (segment === "." || segment === "..") return false; // 防御性检查；SAFE_SEGMENT 已会拒绝。
    if (!SAFE_SEGMENT.test(segment)) return false;
  }
  return true;
}

/** 写入/解析站点使用的抛错形式——pack 必须留在上下文存储根目录内。 */
export function assertSafePackRef(ref: string): void {
  if (!isSafePackRef(ref)) {
    throw new Error(
      `不安全的 pack ref '${ref}'——ref 必须由一个或多个 '/' 分隔的路径段组成，每段均匹配 ` +
        `[A-Za-z0-9][A-Za-z0-9._-]{0,63}（不得包含 '.'/'..'、绝对路径、空段、空白或注入字符），` +
        `以确保 pack 始终位于上下文存储根目录内。`,
    );
  }
}

/** pack 版本必须是单个有界 token，不得含分隔符、空白、'@' 或 ':'。 */
export function isSafePackVersion(version: string): boolean {
  return SAFE_VERSION.test(version);
}

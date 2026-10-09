/** 使用单引号为字符串添加 shell 引号（POSIX 安全）。 */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

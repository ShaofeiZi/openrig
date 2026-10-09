/**
 * 返回 ID 的末尾 N 个字符，便于快速辨认。
 * ULID 的尾部比头部更具区分度（时间戳会让头部彼此相似）。
 */
export function shortId(id: string, length = 6): string {
  if (id.length <= length) return id;
  return id.slice(-length);
}

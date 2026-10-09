// V1 打磨切片 Phase 5.1 之 P5.1-3：修复 pod 名称截断缺陷。
// 此前 pod 名称被渲染成 "covery" / "anning"——开头 2~3 个字符被切掉。
// 根因：displayPodName 误调用 shortId(podId, 6)，而该函数返回任意字符串的
// 最后 6 个字符。对 26 位 ULID 这样做没问题（随机尾部比时间戳头部更易区分），
// 但对人类可读的 pod 命名空间（"discovery" / "planning" / "kernel" 等）就错了。
// OpenRig 中的 pod ID 是命名空间字符串而非 ULID，本不该走 shortId 分支。
// 这里改为原样返回 podId。
//
// shortId 在其他真正用于 ULID 展示的地方（rig ID、队列项尾部等）仍被导入使用，
// 本修复只影响 pod 这条路径。

export function inferPodName(logicalId: string | null | undefined): string | null {
  if (!logicalId) return null;
  const parts = logicalId.split(".");
  if (parts.length <= 1) return logicalId;
  return parts[0] ?? logicalId;
}

export function displayPodName(podId: string | null | undefined): string {
  // pod ID 是人类可读的命名空间字符串而非 ULID——原样返回，
  // 让 "discovery" 保持为 "discovery"（而不是被截成 "covery"）；空值显示为“未分组”。
  return podId && podId.length > 0 ? podId : "未分组";
}

export function displayAgentName(logicalId: string | null | undefined): string {
  if (!logicalId) return "未知";
  const parts = logicalId.split(".");
  if (parts.length <= 1) return logicalId;
  return parts.at(-1) ?? logicalId;
}

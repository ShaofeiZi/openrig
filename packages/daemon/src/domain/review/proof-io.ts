// VM-006（progress-review-done-coherence）——slice proof artifact 读取的唯一归属点
//（架构 Cell A 裁定 A1，2026-07-11）。本函数从 `gather.readProofArtifacts` 原样抽出：
// gather 委托给它，slice-detail projector 也导入同一个 reader。因此 pm-lead 的精确镜像语义
// 从构造上成立：使用相同的 `.md` 过滤、相同的 `.sort()`、相同的 `mtime → ISO` droppedAt，
// 以及相同的逐文件 try/catch-skip。一份实现不可能与自身漂移；若两个页签读取不同的 artifact
// 集合，就会再次分叉，而这正是本 slice 要消除的问题。compose.ts 必须保持纯函数；有副作用的
// proof I/O 只能放在这里。

import * as fs from "node:fs";
import * as path from "node:path";
import { parseC1Header } from "./compose.js";

export function readProofArtifacts(sliceDir: string) {
  const proofDir = path.join(sliceDir, "proof");
  let entries: string[] = [];
  try {
    // 本地化 companion 只供人阅读，不能作为第二份机器裁决参与 evidence join。
    entries = fs.readdirSync(proofDir).filter((f) => f.endsWith(".md") && !f.endsWith(".zh-CN.md"));
  } catch {
    return [];
  }
  return entries
    .sort()
    .map((f) => {
      const full = path.join(proofDir, f);
      try {
        const content = fs.readFileSync(full, "utf8");
        const mtime = fs.statSync(full).mtime.toISOString();
        return parseC1Header(content, `proof/${f}`, mtime);
      } catch {
        return null;
      }
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);
}

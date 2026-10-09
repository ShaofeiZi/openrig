import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { EventBus } from "../event-bus.js";
import { readProjectReadiness } from "./judgments.js";

export interface ProofSourceWatch {
  close(): void;
  observation(): { state: "watching" | "unavailable"; revision: string };
}
export function proofSourceObservation(c: { get: (key: never) => unknown }) {
  return (c.get("proofSourceWatch" as never) as ProofSourceWatch | undefined)?.observation() ?? { state: "unavailable", revision: "unverified" };
}

/** 通过现有 bus 推送失效通知；现有客户端静默刷新负责修复漏失 event。 */
export function watchProofSources(missionsRoot: string, invalidate: () => void, bus: EventBus): ProofSourceWatch {
  const workspace = path.dirname(missionsRoot);
  // ponytail：有界本地 workspace 在文件突发后执行一次完整语义读取。持续测量此工作量；只有超过
  // 该边界时才值得做 subtree indexing。
  const basis = () => createHash("sha256").update(JSON.stringify(readProjectReadiness(missionsRoot).missions.map(m => [m.name, m.revision]))).digest("hex");
  let state: "watching" | "unavailable" = "unavailable";
  let revision = "unavailable", timer: NodeJS.Timeout | undefined;
  try { revision = basis(); state = "watching"; } catch { /* 直接读取会点明不可用输入；watching 可能恢复它们。 */ }
  const notify = (next: string) => { try { bus.emit({ type: "proof.sources_changed", scope: missionsRoot, revision: next }); } catch { /* 静默刷新仍是修复路径。 */ } };
  let watcher: fs.FSWatcher;
  try { watcher = fs.watch(workspace, { recursive: true, persistent: false }, () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      try {
        const next = basis();
        if (next === revision) return;
        revision = next; state = "watching";
        invalidate();
        notify(revision);
      } catch {
        state = "unavailable"; revision = "unavailable";
        invalidate();
        notify("unavailable");
      }
    }, 40);
    timer.unref();
  });
  } catch { invalidate(); notify("unavailable"); return { close() {}, observation: () => ({ state: "unavailable", revision }) }; }
  watcher.on("error", () => { state = "unavailable"; revision = "unavailable"; invalidate(); notify("unavailable"); });
  return { observation: () => ({ state, revision }), close: () => { state = "unavailable"; if (timer) clearTimeout(timer); watcher.close(); } };
}

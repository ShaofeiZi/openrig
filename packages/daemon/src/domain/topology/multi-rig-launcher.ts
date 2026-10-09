// OPR.0.4.4.11——MultiRigLauncher：轻量遍历器（FR-3/FR-4/FR-5）。
//
// 它调用既有的单工作组叶子能力，绝不重新实现阶段、锁、来源或结果形状。本地条目经过
// routes/up.ts 使用的同一个公开 bootstrap() 入口与 tryAcquire/release 锁对
//（guard G-2：逐 sourceRef 锁目前位于路由侧，bootstrap() 自身不取锁；launcher 显式加入
// 同一锁集合，在调用叶子前获取，并在成功或失败的 finally 中释放）。放置到主机的条目通过
// 已发布的远端 POST /api/up 叶子。两个叶子都通过注入提供，使本模块可测试；
// 唯一生产调用方 routes/up.ts 的接线绑定真实接缝。
//
// 聚合契约（架构裁定 5，逐字）：status 是封闭枚举 {ok | failed | skipped}；失败条目之后的
// 条目必须显式报告 `skipped`（绝不缺失，防遗漏）；每个条目都统一包含 `host`
//（本地条目使用字面量 "local"）；整体成功表示所有条目均为 ok。遇错停止是 v0 唯一行为
//（FR-5）：失败后不再启动新条目；已启动工作组如实报告（混合状态，不执行回滚仪式）。

import type { TopologyManifest } from "./topology-manifest.js";
import type { HostEntry, HostRegistryLoadResult } from "../hosts/hosts-registry-reader.js";
import { resolvePlacementHost } from "../hosts/hosts-registry-reader.js";

export type TopologyEntryStatus = "ok" | "failed" | "skipped";

export interface TopologyEntryResult {
  rigRef: string;
  /** 每个条目统一包含：放置主机 ID，或字面量 "local"。 */
  host: string;
  status: TopologyEntryStatus;
  error?: string;
}

export interface TopologyLaunchResult {
  /** 仅当每个条目都为 ok 时才为 true（FR-5——禁止假绿色）。 */
  ok: boolean;
  entries: TopologyEntryResult[];
}

export interface MultiRigLauncherDeps {
  /** 与 up 路由相同的公开锁对（bootstrap-orchestrator）。 */
  tryAcquire: (sourceRef: string) => boolean;
  release: (sourceRef: string) => void;
  /** 既有本地单工作组叶子（通过 routes/up.ts 接线的公开 bootstrap()）。
   *  失败时以叶子自身错误解析为 ok:false；launcher 不发明失败分类。 */
  launchLocal: (source: string) => Promise<{ ok: boolean; error?: string }>;
  /** 用于已放置条目的已发布远端 POST /api/up 叶子。 */
  launchRemote: (source: string, host: HostEntry) => Promise<{ ok: boolean; error?: string }>;
  /** hosts-registry 惰性读取（共享读取器）；只有清单确实把条目放到主机时才查询。 */
  loadRegistry: () => HostRegistryLoadResult;
  /** 将本地条目的清单来源字符串解析为锁和叶子共同使用的完全相同 ref（guard 修复 F1）。
   *  编排器用 path.resolve 规范化锁键；若锁定原始相对字符串，锁键会相对于后台服务 cwd，
   *  而叶子启动的是相对于清单目录解析的文件，从而同时产生假阴性（真实路径的独立 up 不冲突）
   *  与假阳性（两个清单的 './a.yaml' 指向不同文件却发生冲突）。省略时为恒等映射。 */
  resolveLocalRef?: (source: string) => string;
}

/** 镜像路由对拓扑条目的 409 锁冲突语义。 */
const LOCK_CONFLICT_ERROR = "此来源已有操作正在进行（冲突）：并发 up 持有该工作组的启动锁";

export class MultiRigLauncher {
  private deps: MultiRigLauncherDeps;

  constructor(deps: MultiRigLauncherDeps) {
    this.deps = deps;
  }

  async launch(manifest: TopologyManifest): Promise<TopologyLaunchResult> {
    const entries = manifest.rigs;
    // 每个条目初始都显式标为 skipped；遍历未到达的条目仍会报告而非缺失，
    // 从而让聚合结果防遗漏。
    const results: TopologyEntryResult[] = entries.map((e) => ({
      rigRef: e.source,
      host: e.host ?? "local",
      status: "skipped" as TopologyEntryStatus,
    }));

    // ── 启动前放置校验（FR-1/FR-4：在任何启动尝试前给出逐条目结构化错误）。
    // 仅当存在主机放置条目时读取一次注册表。任一放置失败都会在首次叶子调用前中止整次运行：
    // 错误条目报告 failed，其余条目保持 skipped。
    const placed = new Map<number, HostEntry>();
    if (entries.some((e) => e.host !== undefined)) {
      const reg = this.deps.loadRegistry();
      let placementFailed = false;
      for (let i = 0; i < entries.length; i++) {
        const hostId = entries[i]!.host;
        if (hostId === undefined) continue;
        if (!reg.ok) {
          results[i]! = { ...results[i]!, status: "failed", error: reg.error };
          placementFailed = true;
          continue;
        }
        const res = resolvePlacementHost(reg.registry, hostId);
        if (!res.ok) {
          results[i]! = { ...results[i]!, status: "failed", error: res.error };
          placementFailed = true;
        } else {
          placed.set(i, res.host);
        }
      }
      if (placementFailed) return { ok: false, entries: results };
    }

    // ── 分阶段遍历：条目在固定并发上限下按清单顺序启动（默认 1，即严格串行）；
    // 失败会阻止后续启动，已在途条目则完成并如实报告。
    let nextIndex = 0;
    let stopped = false;

    const runEntry = async (i: number): Promise<void> => {
      const entry = entries[i]!;
      const hostEntry = placed.get(i);
      try {
        if (hostEntry) {
          const res = await this.deps.launchRemote(entry.source, hostEntry);
          results[i] = {
            rigRef: entry.source,
            host: hostEntry.id,
            status: res.ok ? "ok" : "failed",
            ...(res.ok ? {} : { error: res.error ?? "远端 up 失败" }),
          };
          return;
        }
        // 本地：显式遵守路由侧锁纪律（guard G-2）。锁键与启动 ref 使用同一个解析后字符串
        //（guard F1）；聚合结果中的 rigRef 仍保留原始清单字符串用于展示。
        const launchRef = this.deps.resolveLocalRef ? this.deps.resolveLocalRef(entry.source) : entry.source;
        if (!this.deps.tryAcquire(launchRef)) {
          results[i] = { rigRef: entry.source, host: "local", status: "failed", error: LOCK_CONFLICT_ERROR };
          return;
        }
        try {
          const res = await this.deps.launchLocal(launchRef);
          results[i] = {
            rigRef: entry.source,
            host: "local",
            status: res.ok ? "ok" : "failed",
            ...(res.ok ? {} : { error: res.error ?? "引导失败" }),
          };
        } finally {
          this.deps.release(launchRef);
        }
      } catch (err) {
        results[i] = {
          rigRef: entry.source,
          host: hostEntry ? hostEntry.id : "local",
          status: "failed",
          error: (err as Error).message,
        };
      }
    };

    const cap = Math.max(1, manifest.concurrency);
    const workers = Array.from({ length: Math.min(cap, entries.length) }, async () => {
      while (!stopped) {
        const i = nextIndex;
        if (i >= entries.length) return;
        nextIndex += 1;
        await runEntry(i);
        if (results[i]!.status === "failed") stopped = true; // FR-5：在失败条目处停止。
      }
    });
    await Promise.all(workers);

    return { ok: results.every((r) => r.status === "ok"), entries: results };
  }
}

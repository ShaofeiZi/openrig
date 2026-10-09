// 故障诊断座舱视图 MODEL（5.2 Wave B，计划 c015d9ed §C3）。后台服务停止时的
// 恢复前视图：裸 `rig` 且后台服务已停止。视图本地数据模型 + 构建器（镜像 pulse-model.ts）——
// 渲染器（render-crash-cart.ts）将其转为行。实时数据来自 C2 后台服务停止直接读取
// （readCrashCartDiscovery）；此构建器将该发现适配到视图模型，保持渲染器纯逻辑 + 可测试。
//
// PM 裁决（有约束力）：头部停止原因 + 先前运行时间是显式诚实未知——槽位显示
// 不可用 + 原因（未持久化关闭记录），绝不留空，绝不推断。结构和顺序按批准的 mock（3d3c90a0）。

/** 两个不可恢复头部槽位的诚实未知文本（PM 裁决）。 */
export const NO_SHUTDOWN_RECORD = "不可用 — 无关闭记录";

export interface CrashCartHeaderVM {
  /** 从最新持久化写入派生的最后活动时间（HH:MM）；若无则为 "unknown"。 */
  lastSeen: string;
  /** 始终为诚实未知文本——先前运行时间未持久化。 */
  uptimeText: string;
  /** 始终为诚实未知文本——停止原因未持久化。 */
  reasonText: string;
}

export interface CrashCartRigVM {
  name: string;
  seatCount: number;
  lastActive: string; // HH:MM 或 "unknown"
  resumableCount: number;
}

export interface CrashCartStoppedVM {
  session: string;
  summary: string;
  time: string; // HH:MM 或 "unknown"
}

export interface CrashCartModel {
  /** recovery = 先前生命的证据（工作组和/或最后活动）→ 故障座舱。
   *  first-run = 停止 + 无数据库（无工作组、无先前活动）→ 引导框架，绝非故障故事。 */
  mode: "recovery" | "first-run";
  header: CrashCartHeaderVM;
  foundOnHost: CrashCartRigVM[];
  /** 故障时进行中的工作；空 ⇒ 渲染器仅显示空闲清理行。 */
  whereWorkStopped: CrashCartStoppedVM[];
}

/** 视图消费的 C2 发现子集（结构上是后台服务的 CrashCartDiscovery；
 *  本地保存使纯视图无跨包导入——集成传入真实的）。 */
export interface CrashCartDiscoveryInput {
  header: { lastActivityAt: string | null };
  foundOnHost: Array<{
    rigName: string;
    seatCount: number;
    resumableCount: number;
    lastActiveAt: string | null;
  }>;
  whereWorkStopped: Array<{
    destinationSession: string;
    summary: string | null;
    tsUpdated: string;
  }>;
}

/** 从 ISO-Z 或 SQLite `datetime('now')` 时间戳提取 HH:MM（与格式无关，无时区
 *  计算——故障诊断按记录显示墙上时间）；null/不可解析 ⇒ "未知"。 */
export function hhmm(ts: string | null): string {
  if (!ts) return "未知";
  const m = /[T ](\d{2}:\d{2})/.exec(ts);
  return m ? m[1]! : "未知";
}

/** 将 C2 后台服务停止发现适配到故障诊断视图模型。 */
export function buildCrashCartModel(discovery: CrashCartDiscoveryInput): CrashCartModel {
  // 故障语言需要先前生命的证据：无工作组 AND 无最后活动 ⇒ 全新主机，而非
  // 故障——渲染引导框架（PM 裁决），绝非故障故事。
  const mode: CrashCartModel["mode"] =
    discovery.foundOnHost.length === 0 && !discovery.header.lastActivityAt ? "first-run" : "recovery";
  return {
    mode,
    header: {
      lastSeen: hhmm(discovery.header.lastActivityAt),
      uptimeText: NO_SHUTDOWN_RECORD,
      reasonText: NO_SHUTDOWN_RECORD,
    },
    foundOnHost: discovery.foundOnHost.map((r) => ({
      name: r.rigName,
      seatCount: r.seatCount,
      lastActive: hhmm(r.lastActiveAt),
      resumableCount: r.resumableCount,
    })),
    whereWorkStopped: discovery.whereWorkStopped.map((w) => ({
      session: w.destinationSession,
      summary: w.summary ?? "(无摘要)",
      time: hhmm(w.tsUpdated),
    })),
  };
}

/** 复现批准 mock 数据的静态夹具（带 PM 诚实未知头部）。由
 *  demo 屏幕 + 条带不变测试使用。 */
export function demoCrashCartModel(): CrashCartModel {
  return {
    mode: "recovery",
    header: { lastSeen: "08:12", uptimeText: NO_SHUTDOWN_RECORD, reasonText: NO_SHUTDOWN_RECORD },
    foundOnHost: [
      { name: "openrig-pm", seatCount: 13, lastActive: "08:11", resumableCount: 7 },
      { name: "kernel", seatCount: 4, lastActive: "08:12", resumableCount: 4 },
      { name: "oversight", seatCount: 3, lastActive: "07:58", resumableCount: 3 },
    ],
    whereWorkStopped: [{ session: "pm-openrig", summary: "cut packet assembly", time: "08:09" }],
  };
}

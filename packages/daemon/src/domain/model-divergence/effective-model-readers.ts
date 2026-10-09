// B8 / slice-07 A3——按运行时读取实际生效模型（承重信号）。
//
// 检测器比较 effective 与 pinned；这些读取器负责“effective”。两个样本都证明 REQUESTED
// 回显并不可靠（Codex 横幅仍显示固定模型，但页脚实际运行 fallback），因此每次读取都来自
// 运行时自身记录的实际应答模型：
//   - claude-code：provider 转录中最新、确定、非合成且包含模型的 assistant 记录；API 响应会
//     标出生成它的模型。在席位产生第一条此类记录前，该信号不存在。
//   - codex：rollout 中最新 `world_state` 事件的 `collaboration_mode.model`。
//
// 契约要求有界读取：活跃席位的 provider 记录可达数百 MB（整文件 readFileSync 在约 0.5GB
// 后会抛出 ERR_STRING_TOO_LONG，并且更早就会阻塞循环——B12 的教训）。Claude 信号每个
// assistant 轮次都会出现，因此单个 512KB 尾部窗口足以覆盖活跃席位。Codex world_state
// 较稀疏（r1 实测一个 65.9MB rollout 的最新记录距 EOF 0.80MB，超出单个尾部窗口），所以
// Codex 读取器以尾部窗口大小的分块向后扫描，最多 MAX_SCAN_BYTES。早于扫描上限的信号返回
// null（如实 UNKNOWN；检测器将其报告为可观察的 pending），绝不猜测。

import { openSync, readSync, closeSync, fstatSync } from "node:fs";

const TAIL_BYTES = 512 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** 最多读取文件末尾 TAIL_BYTES 字节并按 utf-8 拆成完整行；丢弃第一条可能被截断的行。
 * 缺失或不可读时返回 []。 */
export function readTailLines(path: string, tailBytes = TAIL_BYTES): string[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf-8").split("\n");
    if (start > 0) lines.shift(); // 第一行可能从记录中间开始。
    return lines;
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

/** 返回席位最新、确定、非合成且包含模型的 assistant 记录中的模型。尾部窗口中没有此类
 * 记录时返回 null（刚启动或仅有合成记录的席位不会有该记录；检测器将 null 视为 PENDING，
 * 而不是匹配）。 */
export function readClaudeEffectiveModel(transcriptPath: string): string | null {
  const lines = readTailLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"assistant"') || !line.includes('"model"')) continue;
    try {
      const obj = JSON.parse(line) as { type?: unknown; message?: { role?: unknown; model?: unknown } };
      if (obj.message?.role === "assistant" && typeof obj.message.model === "string" && obj.message.model.length > 0 && obj.message.model !== "<synthetic>") {
        return obj.message.model;
      }
    } catch {
      /* 损坏行——继续扫描。 */
    }
  }
  return null;
}

function newestCodexModel(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // 主信号：turn_context.payload.model——因密度高而优先，并非因为另一信号不存在。
    // “旧七月记录没有 collaboration_mode”的判断是错误的：r1 在同一七月文件中实测 72 个
    // world_state 有 14 个携带该字段。实际情况是 collaboration_mode 在 world_state 中稀疏，
    // 而 turn_context.model 每轮都会出现（该文件共 232 次），所以活跃席位的文件末尾通常
    // 能找到它。world_state 后备信号不能删除；两个信号都真实，只是 turn_context 更密集。
    if (line.includes('"turn_context"')) {
      try {
        const obj = JSON.parse(line) as { type?: unknown; payload?: { model?: unknown } };
        if (obj.type === "turn_context") {
          const model = obj.payload?.model;
          if (typeof model === "string" && model.length > 0) return model;
        }
      } catch {
        /* 损坏行——继续扫描。 */
      }
    }
    // 后备信号：world_state.collaboration_mode.model（新格式状态快照）。
    if (line.includes('"world_state"')) {
      try {
        const obj = JSON.parse(line) as {
          type?: unknown;
          payload?: { state?: { collaboration_mode?: { model?: unknown } } };
        };
        if (obj.type === "world_state") {
          const model = obj.payload?.state?.collaboration_mode?.model;
          if (typeof model === "string" && model.length > 0) return model;
        }
      } catch {
        /* 损坏行——继续扫描。 */
      }
    }
  }
  return null;
}

/** 根据最新 turn_context（主信号，兼容两种 rollout 格式）或 world_state
 * collaboration_mode（后备信号）读取 Codex 运行时自身的当前模型。从 EOF 开始按尾部窗口
 * 向后扫描，最多 MAX_SCAN_BYTES。与大量事件行相比该信号较稀疏（r1 对大 rollout 的实时
 * 统计显示记录距 EOF 0.4–0.8MB），单个尾部窗口未必足够；8MB 上限让读取远低于循环阻塞量级。 */
export function readCodexEffectiveModel(rolloutPath: string, maxScanBytes = MAX_SCAN_BYTES): string | null {
  let fd: number;
  try {
    fd = openSync(rolloutPath, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const scanFloor = Math.max(0, size - maxScanBytes);
    let end = size;
    while (end > scanFloor) {
      const start = Math.max(scanFloor, end - TAIL_BYTES);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf-8").split("\n");
      // 第一行可能是被窗口边界截断的记录尾部。此处丢弃它，并让下一窗口结束于该片段之后，
      // 使跨界记录能从自身行首被完整重读。固定的小重叠会丢失任何比重叠更长的跨界记录
      //（r1 证明 20KB 记录会越过 4KB 重叠而消失；丢失跨界记录通常会造成过期模型读取，
      // 正是此检测器要消除的静默；真实 world_state 记录可达约 22KB）。依据被丢片段定尺寸，
      // 可以从结构上得到精确重叠。
      let droppedBytes = 0;
      if (start > 0 && lines.length > 0) {
        droppedBytes = Buffer.byteLength(lines[0]!, "utf-8");
        lines.shift();
      }
      const model = newestCodexModel(lines);
      if (model !== null) return model;
      if (start === scanFloor) break;
      // 按片段大小后退，但若片段填满整个窗口则例外。单行超过 512KB 是真实情况：r1 在本机
      // 测得 44 行，最长 8.2MB。此时 `start + droppedBytes + 1` 会大于等于 end，旧的
      // `min(end - 1, …)` 防护会退化成每次只后退一个字节、反复读取 512KB；r1 在本应受
      // 扫描上限保护的深度扫描文件上测得 6MB 文件耗时超过 30 秒（外推读取量约 1.4TB）。
      // 若按片段定尺寸无法前进，则改为后退完整窗口：无论如何都无法完整恢复超大行
      //（这是接受的权衡），但扫描能够终止。
      const next = start + droppedBytes + 1;
      end = next < end ? next : start;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

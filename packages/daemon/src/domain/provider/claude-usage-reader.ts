// Slice-04（OPR.0.5.0.4）接缝 C3——Claude statusline provider_usage 缓存通道。
// statusline sidecar 使用原子 tmp+rename 写入逐席位 provider_usage 缓存，使后台服务并发读取时
// 绝不会看到残缺文件；后台服务在此读取，并通过现有 claudeStatuslineSignals 归一化为
// provider_statusline 信号行。缓存不存在（首次响应前）以及空/畸形读取，都会成为带
// unknownReason 的明确 unknown 行，绝不缺行，也绝不伪造零值；本模块绝不抛错。
//
// 范围：本原子只包含缓存生产/读取与 collectSignals 接线，不涉及 C4 reactive tap、
// C2 Codex app-server、活动准确性预检、D switch 执行或 BR-1。

import fs from "node:fs";
import nodePath from "node:path";
import { claudeStatuslineSignals, type ClaudeStatuslineReading } from "./provider-signals.js";
import type { ProviderSignal } from "./provider-types.js";
import { telemetrySidecarFilename } from "../telemetry-state-paths.js";

export interface ProviderUsageCacheFs {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  rename(from: string, to: string): void;
  exists(path: string): boolean;
}

/** 磁盘上的 provider_usage 缓存结构（由 Claude statusline sidecar 写入）。 */
export interface ProviderUsageCache {
  seatSession: string;
  /** 仅当 statusline 携带有效 Pro/Max rate_limits 时存在。 */
  accountKind?: "subscription";
  asOf: string;
  /** 仅当 statusline 携带 rate_limits 对象时存在。 */
  rateLimits?: ClaudeStatuslineReading;
  staleAfter?: string;
}

/**
 * 原子写入：先序列化到同级 tmp 文件，再 rename 覆盖目标。rename(2) 在同一文件系统内是原子的，
 * 因此并发读取方只会看到旧文件或完整写入的新文件，绝不会读到半写入的残缺内容。
 * sidecar 使用此方式，避免后台服务解析不完整缓存。
 */
export function writeProviderUsageCacheAtomic(
  fs: ProviderUsageCacheFs,
  path: string,
  cache: ProviderUsageCache,
): void {
  const tmp = `${path}.tmp-${cache.asOf.replace(/[^0-9]/g, "")}`;
  fs.writeFile(tmp, JSON.stringify(cache));
  fs.rename(tmp, path);
}

export interface ClaudeSeatRef {
  seatSession: string;
}

export interface ClaudeUsageReaderDeps {
  /** 要读取 provider_usage 的活跃 Claude 席位。 */
  listClaudeSeats: () => ClaudeSeatRef[];
  /** 席位的原始缓存 JSON；缓存文件不存在（首次响应前）时为 null；绝不抛错。 */
  readCacheRaw: (seatSession: string) => string | null;
  now: () => string;
}

/**
 * 读取每个 Claude 席位的 provider_usage 缓存，通过 claudeStatuslineSignals 转为
 * provider_statusline 行。缓存缺失（no_statusline_cache_yet）以及缓存存在但窗口缺失/畸形
 *（empty_reading）时都生成明确的 unknown 行。绝不抛错；畸形缓存按“存在但无窗口”处理，
 * 不视为崩溃。
 */
export function collectClaudeStatuslineSignals(deps: ClaudeUsageReaderDeps): ProviderSignal[] {
  const now = deps.now();
  const out: ProviderSignal[] = [];
  for (const seat of deps.listClaudeSeats()) {
    let cachePresent = false;
    let reading: ClaudeStatuslineReading | undefined;
    let staleAfter: string | undefined;
    let capturedAsOf: string | undefined;
    const raw = deps.readCacheRaw(seat.seatSession);
    if (raw !== null) {
      cachePresent = true;
      try {
        const parsed = JSON.parse(raw) as Partial<ProviderUsageCache>;
        if (parsed.seatSession === seat.seatSession && parsed.accountKind === "subscription") {
          reading = validRateLimits(parsed.rateLimits);
        }
        staleAfter = parsed.staleAfter;
        capturedAsOf = typeof parsed.asOf === "string" ? parsed.asOf : undefined;
      } catch {
        // 畸形缓存 → 存在但无窗口（empty_reading unknown），绝不抛错。
        reading = undefined;
      }
    }
    out.push(
      ...claudeStatuslineSignals({
        seatSession: seat.seatSession,
        cachePresent,
        reading,
        // 缓存存在且有效时，信号 asOf 取读取捕获时间（缓存的 asOf）；否则取当前时间。
        asOf: cachePresent && capturedAsOf ? capturedAsOf : now,
        staleAfter,
      }),
    );
  }
  return out;
}

/** 使用后台服务启动流程消费的同一路径，读取按席位索引的缓存目录。 */
export function collectClaudeSignalsFromProviderUsageDirectory(
  directory: string,
  now: () => string = () => new Date().toISOString(),
  legacyDirectory?: string,
): ProviderSignal[] {
  const seats = new Map<string, ClaudeSeatRef>();
  for (const candidateDirectory of [directory, legacyDirectory]) {
    if (!candidateDirectory) continue;
    try {
      for (const file of fs.readdirSync(candidateDirectory)) {
        if (!file.endsWith(".json")) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(nodePath.join(candidateDirectory, file), "utf-8")) as { seatSession?: unknown };
          if (typeof parsed.seatSession === "string") {
            seats.set(parsed.seatSession, { seatSession: parsed.seatSession });
          }
        } catch { /* malformed cache cannot create a usable cache signal */ }
      }
    } catch { /* absent cache directory */ }
  }

  const readFrom = (candidateDirectory: string, seatSession: string): string | null => {
    try {
      return fs.readFileSync(nodePath.join(candidateDirectory, telemetrySidecarFilename(seatSession)), "utf-8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "";
    }
  };

  return collectClaudeStatuslineSignals({
    listClaudeSeats: () => [...seats.values()],
    readCacheRaw: (seatSession) => {
      const canonical = readFrom(directory, seatSession);
      if (canonical !== null) return canonical;
      return legacyDirectory ? readFrom(legacyDirectory, seatSession) : null;
    },
    now,
  });
}

function validRateLimits(value: unknown): ClaudeStatuslineReading | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const reading: ClaudeStatuslineReading = {};
  for (const key of ["five_hour", "seven_day"] as const) {
    const raw = source[key];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const window = raw as Record<string, unknown>;
    if (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
      && typeof window.resetsAt === "string") {
      reading[key] = { usedPercent: window.usedPercent, resetsAt: window.resetsAt };
    }
  }
  return reading.five_hour || reading.seven_day ? reading : undefined;
}

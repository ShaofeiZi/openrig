/**
 * Slice 51-02（L2 测试系统）——仅追加的运行记录台账。
 *
 * 每次场景运行写入一行 JSONL（“结果台账结构”），使不同时间的运行可比较。只追加：新增行
 * 永不改写之前的字节。证明条目 3 将 FAIL 判决与新增运行记录配对，后者携带失败步骤和
 * 预期值与观察值之间的差异。
 */

import { appendFileSync, readFileSync } from "node:fs";

export interface RunRecord {
  /** 场景名称，即其缺陷类别。 */
  scenario: string;
  verdict: "PASS" | "FAIL";
  /** 失败步骤的零基索引，仅 FAIL 时存在。 */
  failedStep?: number;
  /** 预期值与最后观察值之间的差异，仅 FAIL 时存在。 */
  diff?: string;
  /** 调用方提供的时间戳，可注入；runner 会传入时钟值。 */
  at?: string;
  /** 与墙上时钟无关的运行时长，单位毫秒；仅在调用方完成测量时存在。 */
  durationMs?: number;
  /**
   * 51-04 容器模式：本次运行所针对的 testbed 镜像 manifest 身份（manifest 摘要），使不同
   * 镜像版本的运行可比较。在主机模式下缺失；记录与 51-04 之前的台账逐字节一致。
   */
  imageId?: string;
}

/** 将一条运行记录追加为 JSON 行。只追加；文件缺失时创建。 */
export function appendRunRecord(ledgerPath: string, record: RunRecord): void {
  appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, "utf8");
}

/** 读取全部运行记录。台账缺失时返回空列表，不抛错。 */
export function readRunRecords(ledgerPath: string): RunRecord[] {
  let raw: string;
  try {
    raw = readFileSync(ledgerPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RunRecord);
}

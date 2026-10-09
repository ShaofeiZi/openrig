import fs from "node:fs";
import path from "node:path";

import type { AuditFinding } from "./scope-audit.js";
import { splitFrontmatter } from "./scope-fs.js";

const CAPABILITY_DELTA_FILE = /^CAPABILITY-DELTA-v.+\.md$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function documentHeader(content: string): string {
  const firstSection = content.search(/^##\s+/m);
  return firstSection === -1 ? content : content.slice(0, firstSection);
}

/**
 * 在任务目标根目录为带版本的能力增量派生过期建议。
 * 该事件刻意采用合取条件：canon 必须在其头部明确命名该增量，
 * 且必须存在一个独立的后继文件。缺失或不可读的输入保持未知/存活状态，
 * 绝不把建议变成门禁。
 */
export function capabilityDeltaExpiryFindings(missionDir: string): AuditFinding[] {
  let filenames: string[];
  try {
    filenames = fs.readdirSync(missionDir)
      .filter((filename) => CAPABILITY_DELTA_FILE.test(filename))
      .sort();
  } catch {
    return [];
  }

  const findings: AuditFinding[] = [];
  for (const filename of filenames) {
    const deltaPath = path.join(missionDir, filename);
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = splitFrontmatter(fs.readFileSync(deltaPath, "utf8")).frontmatter;
    } catch {
      continue;
    }

    const identity = typeof frontmatter.capability_delta === "string"
      ? frontmatter.capability_delta.trim()
      : "";
    const expiry = asRecord(frontmatter.expiry);
    const canonRef = typeof expiry?.canon_path === "string" ? expiry.canon_path.trim() : "";
    const successorRef = typeof expiry?.successor_path === "string" ? expiry.successor_path.trim() : "";
    if (!identity || !canonRef || !successorRef) continue;

    const canonPath = path.resolve(path.dirname(deltaPath), canonRef);
    const successorPath = path.resolve(path.dirname(deltaPath), successorRef);
    if (successorPath === deltaPath || !fs.existsSync(canonPath) || !fs.existsSync(successorPath)) continue;

    let canonNamesDelta = false;
    try {
      canonNamesDelta = documentHeader(fs.readFileSync(canonPath, "utf8"))
        .split(/[^A-Za-z0-9._-]+/)
        .includes(identity);
    } catch {
      continue;
    }
    if (!canonNamesDelta) continue;

    findings.push({
      kind: "expired_capability_delta",
      severity: "medium",
      path: deltaPath,
      message: `能力增量 ${identity} 已到达过期事件：canon 头部 ${canonRef} 命名了它，且后继文件 ${successorRef} 已存在；不再可被引用。`,
      remediation: `停止引用 ${filename}；使用后继增量，并在发布流程要求时归档此发布专属产物。`,
    });
  }
  return findings;
}

// Slice-04（OPR.0.5.0.4）接缝 C1——后台服务本地、机密安全的 codex-auth 磁盘契约读取器。
// 后台服务不能导入 packages/cli（无 @openrig/cli 依赖），因此在此按同一文档格式重新读取：
// $CODEX_HOME||~/.codex 下的 auth-profiles/*.json（仅档案名称）及 auth-seat-registry.tsv
//（6 个制表符分隔列：seat/rig/runtime/cwd/auth_profile/updated_ts，不含 token 列）。
// 这里只读取档案名称和 TSV，绝不读取包含 token 类材料的档案 *.json 内容
//（BR-6：任何机密都不得暴露）。

import fs from "node:fs";
import path from "node:path";

export interface CodexSeatRow {
  seat: string;
  rig: string;
  runtime: string;
  cwd: string;
  /** 此席位登记到的 codex-auth 档案名（不透明、非机密）。 */
  authProfile: string;
  updatedTs: string;
}

export interface CodexAuthMetadata {
  /** 档案名称（不透明、非机密引用）——绝不包含文件内容。 */
  profiles: string[];
  seats: CodexSeatRow[];
}

const SEAT_COLUMN_COUNT = 6;

function resolveCodexHome(env: NodeJS.ProcessEnv): { profileDir: string; registryPath: string } {
  const codexHome =
    typeof env.CODEX_HOME === "string" && env.CODEX_HOME.length > 0
      ? env.CODEX_HOME
      : path.join(env.HOME ?? "", ".codex");
  return {
    profileDir: path.join(codexHome, "auth-profiles"),
    registryPath: path.join(codexHome, "auth-seat-registry.tsv"),
  };
}

// 只读取档案名称——绝不打开包含 token 类材料的 *.json 文件内容。
function listProfiles(profileDir: string): string[] {
  try {
    return fs
      .readdirSync(profileDir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

function readSeats(registryPath: string): CodexSeatRow[] {
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, "utf8");
  } catch {
    return [];
  }
  const rows: CodexSeatRow[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const cols = line.split("\t");
    if (cols.length !== SEAT_COLUMN_COUNT) continue; // 跳过畸形行——绝不臆造字段
    // 上方已确认长度恰为 6，因此元组解构是完备的，满足 noUncheckedIndexedAccess。
    const [seat, rig, runtime, cwd, authProfile, updatedTs] = cols as [string, string, string, string, string, string];
    if (seat === "seat") continue; // 表头行
    rows.push({ seat, rig, runtime, cwd, authProfile, updatedTs });
  }
  return rows;
}

/** 读取 codex-auth 磁盘元数据（档案名 + 席位注册表）。绝不抛错，也绝不暴露
 *  token 类内容；home 或文件缺失时返回空数组。 */
export function readCodexAuthMetadata(env: NodeJS.ProcessEnv = process.env): CodexAuthMetadata {
  const { profileDir, registryPath } = resolveCodexHome(env);
  return {
    profiles: listProfiles(profileDir),
    seats: readSeats(registryPath),
  };
}

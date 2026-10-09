// HTTP reader 与显式本地 TUI reader 共用相同的路径范围和字节内容。
import * as fs from "node:fs";
import * as path from "node:path";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { resolveAllowedFile, type AllowlistRoot } from "./path-safety.js";

export const FILE_READ_TRUNCATION_BYTES = 1_048_576;

export function readAllowedFile(allowlist: AllowlistRoot[], root: string, relativePath: string) {
  const resolved = resolveAllowedFile(allowlist, root, relativePath);
  const stat = fs.statSync(resolved);
  const fullContent = fs.readFileSync(resolved);
  const truncated = fullContent.length > FILE_READ_TRUNCATION_BYTES;
  const returned = fullContent.subarray(0, FILE_READ_TRUNCATION_BYTES);
  return {
    root, path: relativePath, absolutePath: resolved,
    resolvedPath: path.relative(allowlist.find((entry) => entry.name === root)!.canonicalPath, resolved),
    content: returned.toString("utf8"),
    binary: fullContent.includes(0) || !isUtf8(fullContent),
    mtime: stat.mtime.toISOString(), contentHash: createHash("sha256").update(fullContent).digest("hex"),
    size: stat.size, truncated, truncatedAtBytes: truncated ? FILE_READ_TRUNCATION_BYTES : null,
    totalBytes: fullContent.length,
  };
}

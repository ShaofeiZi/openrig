import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SOURCE_DIR = resolve(REPO_ROOT, "packages/daemon/specs/agents/shared/skills");
const TARGET_DIR = resolve(REPO_ROOT, "skills/_canonical");

export type MirrorDriftSafeResult =
  | { ok: true; stale: boolean; changes: string[] }
  | { ok: false; reason: string };

export async function checkMirrorDriftSafe(): Promise<MirrorDriftSafeResult> {
  if (!existsSync(SOURCE_DIR)) {
    return { ok: false, reason: `未找到镜像源目录：${SOURCE_DIR}` };
  }
  if (!existsSync(TARGET_DIR)) {
    return { ok: false, reason: `未找到镜像目标目录：${TARGET_DIR}` };
  }

  try {
    const scriptUrl = new URL("../../../../scripts/mirror-skills.mjs", import.meta.url);
    const mod = await import(scriptUrl.href) as {
      checkModeAbsolute: (source: string, target: string) => { stale: boolean; changes: string[] };
    };
    const result = mod.checkModeAbsolute(SOURCE_DIR, TARGET_DIR);
    return { ok: true, stale: result.stale, changes: result.changes };
  } catch (err) {
    return { ok: false, reason: `镜像漂移检查失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

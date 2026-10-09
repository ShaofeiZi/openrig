// 51-04 testbed 镜像——从源码树推导 manifest 的 `stubAssetsHash`（计划 §1）。
//
// 构建命令（scripts/build-testbed-image.sh 那一族）向 manifest 喂入四个由源码树推导出的输入
// （git sha、node 版本、openrig sha、stub 资产哈希），外加宿主机侧 `docker pull` 得到的 base digest。
// 其中 stub 资产哈希是唯一需要真正推导的：它是“究竟哪些 stub 资产被烤进镜像”的清点收据——
// 一个字节可复现的身份，让 runner / 51-05 矩阵能跨镜像版本比较各次运行。
//
// 范围纪律（census-scope-match-code-path）：调用方传入 Dockerfile COPY 的精确文件列表——绝不递归遍历，
// 否则会悄悄把未跟踪/生成的兄弟文件也算进来，使收据不再确定。摘要取在规范化内容之上：每个文件单独哈希，
// 再对排序后的 {path,sha256} 映射做哈希——因此路径里嵌入的分隔符或引号永远不可能伪造出另一组合法资产的摘要
// （hash-join-delimiter-forgery）。文件缺失 / 集合为空 / 路径逃逸资产根，都响亮失败——绝不静默产出
// 一份看似构建正常、却漏掉（或多算）某个已烤入文件的半成品收据。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { canonicalJson } from "./testbed-manifest.mjs";

/** 响亮、带类型的失败——缺失/非法的资产输入必须失败，绝不能静默产出一份漏掉（或多算）
 *  某个已烤入文件的半成品收据。 */
export class TestbedBuildInputsError extends Error {
  constructor(message) {
    super(message);
    this.name = "TestbedBuildInputsError";
  }
}

/** stub 资产收据的 schema id——仅在收据形态发生破坏性变更时才升级。 */
export const STUB_ASSETS_SCHEMA = "openrig-testbed-stub-assets/v1";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 把调用方给定的相对资产路径解析到 rootDir 内部，拒绝绝对路径与任何 `..` 逃逸（包含性）。
 *  输入列表由作者掌控，所以这里的威胁是意外越界 / 收据延伸到资产树之外——对解析后的路径做前缀检查即可。 */
function resolveContained(rootDir, rel) {
  if (typeof rel !== "string" || rel.trim().length === 0) {
    throw new TestbedBuildInputsError("stub asset path must be a non-empty string");
  }
  const rootResolved = resolve(rootDir);
  const abs = resolve(rootResolved, rel);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new TestbedBuildInputsError(`stub asset path '${rel}' escapes the asset root`);
  }
  return abs;
}

/** 把相对路径规范化为收据所用的稳定 POSIX 形态（使身份跨平台一致：反斜杠绝不进入被哈希的载荷）。 */
function posixPath(rel) {
  return rel.split(sep).join("/");
}

/**
 * 在 rootDir 下、对一份显式文件列表计算 stub 资产清点哈希。
 * @returns {{ hash: string, receipt: { schema: string, files: Array<{path: string, sha256: string}> } }}
 */
export function deriveStubAssetsHash(rootDir, relativePaths) {
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw new TestbedBuildInputsError("stub assets root dir must be a non-empty string");
  }
  let rootStat;
  try {
    rootStat = statSync(resolve(rootDir));
  } catch {
    throw new TestbedBuildInputsError(`stub assets root '${rootDir}' does not exist`);
  }
  if (!rootStat.isDirectory()) {
    throw new TestbedBuildInputsError(`stub assets root '${rootDir}' is not a directory`);
  }
  if (!Array.isArray(relativePaths) || relativePaths.length === 0) {
    throw new TestbedBuildInputsError("stub asset file list must be a non-empty array");
  }

  const files = [];
  const seen = new Set();
  for (const rel of relativePaths) {
    const abs = resolveContained(rootDir, rel);
    const path = posixPath(rel);
    if (seen.has(path)) {
      throw new TestbedBuildInputsError(`stub asset path '${path}' listed more than once`);
    }
    seen.add(path);
    let bytes;
    try {
      bytes = readFileSync(abs);
    } catch {
      throw new TestbedBuildInputsError(`stub asset '${rel}' does not exist under the asset root`);
    }
    if (!statSync(abs).isFile()) {
      throw new TestbedBuildInputsError(`stub asset '${rel}' is not a regular file`);
    }
    files.push({ path, sha256: sha256(bytes) });
  }

  // 按 POSIX 路径排序，使收据与摘要与顺序无关。摘要取在 manifest 所用的同一份规范化排序键 JSON 之上
  // （绝不朴素 join）：两个字段要么做 JSON 转义（path）、要么是定宽十六进制（sha256），因此路径里的
  // 分隔符伪造不出另一组；即便收据形态增长，规范化序列化器也使摘要与键顺序无关。
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const receipt = { schema: STUB_ASSETS_SCHEMA, files };
  const hash = sha256(canonicalJson(receipt));
  return { hash, receipt };
}

/**
 * 解析并强制校验一个 digest 钉死的基础镜像引用（计划 §1 栅栏：“digest 钉死，而非浮动 tag”）。
 * 浮动 tag 的 base 会在两次构建间悄悄漂移，破坏字节可复现；只接受 `name[:tag]@sha256:<64 位十六进制>`
 * 这种引用。返回的 digest 成为 manifest 的 baseDigest。其他任何情况——只有 tag 的引用、畸形/非 sha256
 * 的 digest、为空——都响亮失败。
 * @returns {{ ref: string, name: string, digest: string }}
 */
export function parseDigestPinnedBase(ref) {
  if (typeof ref !== "string" || ref.trim().length === 0) {
    throw new TestbedBuildInputsError("base image reference must be a non-empty string");
  }
  const trimmed = ref.trim();
  const at = trimmed.indexOf("@");
  if (at === -1) {
    throw new TestbedBuildInputsError(
      `base image '${trimmed}' is tag-floating — it must be digest-pinned (name@sha256:<64-hex>)`,
    );
  }
  const name = trimmed.slice(0, at);
  const digest = trimmed.slice(at + 1);
  if (name.trim().length === 0) {
    throw new TestbedBuildInputsError(`base image '${trimmed}' is missing a name before the digest`);
  }
  // 只接受 sha256，恰好 64 位小写十六进制——与 docker 记录钉死 digest 的方式一致。
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new TestbedBuildInputsError(
      `base image digest '${digest}' is not a valid sha256:<64 lowercase hex> pin`,
    );
  }
  return { ref: trimmed, name, digest };
}

/**
 * 读取已提交的基础镜像槽位（docker/testbed/base-image）——由 L0 runbook 在宿主机侧解析、为字节可复现性
 * 记录下来的 digest。注释（`#`）与空行忽略；必须恰好剩下一条引用。未解析的槽位（全注释）、含糊的槽位
 * （多条引用）、或文件缺失，都响亮失败——源码树永远不能对着未钉死的 base 构建。
 * @returns {{ ref: string, name: string, digest: string }}
 */
export function readBaseImage(filePath) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new TestbedBuildInputsError("base-image file path must be a non-empty string");
  }
  if (!existsSync(filePath)) {
    throw new TestbedBuildInputsError(`base-image file '${filePath}' does not exist`);
  }
  const refs = readFileSync(filePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (refs.length === 0) {
    throw new TestbedBuildInputsError(
      `base-image slot '${filePath}' is unresolved — resolve the digest host-side (L0 runbook)`,
    );
  }
  if (refs.length > 1) {
    throw new TestbedBuildInputsError(
      `base-image slot '${filePath}' names ${refs.length} refs — exactly one digest-pinned base is required`,
    );
  }
  return parseDigestPinnedBase(refs[0]);
}

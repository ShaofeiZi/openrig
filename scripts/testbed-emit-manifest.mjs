// 51-04 testbed 镜像——构建命令的 manifest 发出编排器（计划 §1）。
//
// `scripts/build-testbed-image.sh` 在宿主机侧跑依赖 docker 的步骤（npm pack、docker build、
// docker tag——loci 裁决），再调用这个纯的、不依赖 docker 的编排器，从源码树收集 manifest 身份，
// 把可复现 manifest + 清点收据写进构建产物目录。把逻辑放在这里（config-wrapper-code 信条：
// 薄 shell、可测的 node），让整套身份故事在 VM 里可单测。
//
// 身份来源：baseDigest = 宿主机解析出的 docker/testbed/base-image 摘要（锁定栅栏）；
// stubAssetsHash = 对“精确暂存的 stub 资产集”的清点；gitSha/openrigSha/nodeVersion 由 shell 提供
// （git rev-parse / 源码树 / Dockerfile 锁定）。重建契约：相同输入 => 字节一致的 manifest.json + 收据。
// 任何输入缺失都响亮失败。

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeTestbedManifest } from "./testbed-manifest.mjs";
import { deriveStubAssetsHash, readBaseImage, TestbedBuildInputsError } from "./testbed-build-inputs.mjs";

/** 确定性的 2 空格缩进 JSON，末尾带换行——字节稳定的产物形式。 */
function stableJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * 收集 testbed 镜像 manifest 身份，把 manifest.json + stub 资产清点收据写进 outDir。
 * @returns {{ manifest: object, receipt: object, manifestPath: string, receiptPath: string }}
 */
export function emitTestbedManifest(opts) {
  if (opts === null || typeof opts !== "object") {
    throw new TestbedBuildInputsError("emitTestbedManifest 需要一个 options 对象");
  }
  const { gitSha, openrigSha, nodeVersion, baseImagePath, stubAssetsRoot, stubAssetFiles, outDir } = opts;

  for (const [name, val] of Object.entries({ baseImagePath, stubAssetsRoot, outDir })) {
    if (typeof val !== "string" || val.trim().length === 0) {
      throw new TestbedBuildInputsError(`emitTestbedManifest 需要非空的 '${name}'`);
    }
  }

  // 基础 digest——来自宿主机解析出的锁定槽位（readBaseImage 强制 digest 栅栏）。
  const base = readBaseImage(baseImagePath);
  // 对精确暂存集做 stub 资产清点。
  const { hash: stubAssetsHash, receipt } = deriveStubAssetsHash(stubAssetsRoot, stubAssetFiles);

  // computeTestbedManifest 会校验其余每个身份字段（空/缺失时响亮失败）。
  const manifest = computeTestbedManifest({
    baseDigest: base.digest,
    nodeVersion,
    openrigSha,
    stubAssetsHash,
    gitSha,
  });

  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, "manifest.json");
  const receiptPath = join(outDir, "stub-assets-receipt.json");
  writeFileSync(manifestPath, stableJson(manifest));
  writeFileSync(receiptPath, stableJson(receipt));

  return { manifest, receipt, manifestPath, receiptPath };
}

/** 当本模块是进程入口（作为 CLI 调用，而非被 import）时返回 true。 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// CLI 垫片——shell 构建命令的 manifest 发出步骤：
//   node scripts/testbed-emit-manifest.mjs <inputs.json> <outDir>
// inputs.json 携带 shell 组装好的身份（gitSha、openrigSha、nodeVersion、
// baseImagePath、stubAssetsRoot、stubAssetFiles）。任何失败都以非 0 退出并打印一行响亮的 stderr
// ——绝不静默产出半成品 manifest。
if (isMainModule()) {
  const [inputsPath, outDir] = process.argv.slice(2);
  if (!inputsPath || !outDir) {
    console.error("用法：testbed-emit-manifest.mjs <inputs.json> <outDir>");
    process.exit(2);
  }
  try {
    const inputs = JSON.parse(readFileSync(inputsPath, "utf8"));
    const { manifestPath, receiptPath, manifest } = emitTestbedManifest({ ...inputs, outDir });
    console.error(`[testbed] 已写入 ${manifestPath}（${manifest.image}）+ ${receiptPath}`);
  } catch (err) {
    console.error(`[testbed] manifest 发出失败：${err.message}`);
    process.exit(1);
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitTestbedManifest } from "./testbed-emit-manifest.mjs";
import { TestbedBuildInputsError, deriveStubAssetsHash } from "./testbed-build-inputs.mjs";
import { TestbedManifestError } from "./testbed-manifest.mjs";

// 51-04 testbed 镜像——构建命令里可在 VM 内测试的核心。`docker build` 在宿主机侧运行（locus 裁决）；
// 本编排器从源码树收集 manifest 身份——宿主机解析的 base digest（docker/testbed/base-image）、
// stub 资产清点、git/openrig sha、node 版本——并把可复现的 manifest + 清点收据写进构建产物目录。
// 重建契约：相同输入 => 字节一致的 manifest.json + 收据。缺失/未解析的输入响亮失败。

const DIGEST = "sha256:" + "c".repeat(64);
const STUB_FILES = Object.freeze({
  "stub-runner.js": "// compiled stub runner\n",
  "hooks/bridge.cjs": "module.exports={};\n",
});

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "testbed-emit-"));
  writeFileSync(join(root, "base-image"), `# resolved host-side\ndebian:bookworm-slim@${DIGEST}\n`);
  const stubRoot = join(root, "stub-assets");
  for (const [rel, content] of Object.entries(STUB_FILES)) {
    const abs = join(stubRoot, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return { root, stubRoot };
}

function baseArgs(root, stubRoot, outDir) {
  return {
    gitSha: "9cf781060000000000000000000000000000000",
    openrigSha: "9cf781060000000000000000000000000000000",
    nodeVersion: "22.22.1",
    baseImagePath: join(root, "base-image"),
    stubAssetsRoot: stubRoot,
    stubAssetFiles: Object.keys(STUB_FILES),
    outDir,
  };
}

test("emits a manifest.json wiring the host-resolved base digest + stub census + identity", () => {
  const { root, stubRoot } = makeRepo();
  const outDir = join(root, "out");
  try {
    const { manifest, manifestPath } = emitTestbedManifest(baseArgs(root, stubRoot, outDir));
    const onDisk = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(onDisk, manifest);
    assert.equal(manifest.image, "openrig-testbed:9cf781060000000000000000000000000000000");
    assert.equal(manifest.baseDigest, DIGEST); // from the base-image slot, not fabricated
    assert.equal(manifest.nodeVersion, "22.22.1");
    assert.equal(manifest.openrigSha, "9cf781060000000000000000000000000000000");
    // stubAssetsHash 与对同一已暂存集合做的独立清点一致。
    assert.equal(manifest.stubAssetsHash, deriveStubAssetsHash(stubRoot, Object.keys(STUB_FILES)).hash);
    assert.match(manifest.manifestDigest, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("also writes the stub-assets census receipt alongside the manifest", () => {
  const { root, stubRoot } = makeRepo();
  const outDir = join(root, "out");
  try {
    const { receipt, receiptPath } = emitTestbedManifest(baseArgs(root, stubRoot, outDir));
    const onDisk = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.deepEqual(onDisk, receipt);
    assert.deepEqual(receipt.files.map((f) => f.path), ["hooks/bridge.cjs", "stub-runner.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("REBUILD CONTRACT: same inputs => byte-identical manifest.json + receipt on disk", () => {
  const { root, stubRoot } = makeRepo();
  try {
    const a = emitTestbedManifest(baseArgs(root, stubRoot, join(root, "outA")));
    const b = emitTestbedManifest(baseArgs(root, stubRoot, join(root, "outB")));
    assert.equal(readFileSync(a.manifestPath, "utf8"), readFileSync(b.manifestPath, "utf8"));
    assert.equal(readFileSync(a.receiptPath, "utf8"), readFileSync(b.receiptPath, "utf8"));
    assert.equal(a.manifest.manifestDigest, b.manifest.manifestDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loud-fail propagates when the base-image slot is unresolved (never a partial manifest)", () => {
  const { root, stubRoot } = makeRepo();
  try {
    writeFileSync(join(root, "base-image"), "# not resolved yet\n");
    assert.throws(() => emitTestbedManifest(baseArgs(root, stubRoot, join(root, "out"))), TestbedBuildInputsError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loud-fail on a missing required identity input (delegated to the manifest validator)", () => {
  const { root, stubRoot } = makeRepo();
  try {
    const args = baseArgs(root, stubRoot, join(root, "out"));
    delete args.gitSha;
    // gitSha/openrigSha/nodeVersion 由 computeTestbedManifest 校验（单一来源）——
    // 缺一个会响亮抛 TestbedManifestError，而不是静默产出半成品 manifest。
    assert.throws(() => emitTestbedManifest(args), TestbedManifestError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- CLI 垫片：shell 构建命令以 `node testbed-emit-manifest.mjs <inputs.json> <outDir>` 调用 ---
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const SHIM = fileURLToPath(new URL("./testbed-emit-manifest.mjs", import.meta.url));

test("CLI shim emits the manifest from an inputs.json + outDir (exit 0)", () => {
  const { root, stubRoot } = makeRepo();
  const outDir = join(root, "out");
  try {
    const inputs = {
      gitSha: "9cf781060000000000000000000000000000000",
      openrigSha: "9cf781060000000000000000000000000000000",
      nodeVersion: "22.22.1",
      baseImagePath: join(root, "base-image"),
      stubAssetsRoot: stubRoot,
      stubAssetFiles: Object.keys(STUB_FILES),
    };
    const inputsPath = join(root, "inputs.json");
    writeFileSync(inputsPath, JSON.stringify(inputs));
    const res = spawnSync(process.execPath, [SHIM, inputsPath, outDir], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.image, "openrig-testbed:9cf781060000000000000000000000000000000");
    assert.equal(manifest.baseDigest, DIGEST);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI shim fails LOUDLY (non-zero + stderr) on an unresolved base-image slot", () => {
  const { root, stubRoot } = makeRepo();
  try {
    writeFileSync(join(root, "base-image"), "# unresolved\n");
    const inputs = {
      gitSha: "a".repeat(40), openrigSha: "a".repeat(40), nodeVersion: "22.22.1",
      baseImagePath: join(root, "base-image"), stubAssetsRoot: stubRoot,
      stubAssetFiles: Object.keys(STUB_FILES),
    };
    const inputsPath = join(root, "inputs.json");
    writeFileSync(inputsPath, JSON.stringify(inputs));
    const res = spawnSync(process.execPath, [SHIM, inputsPath, join(root, "out")], { encoding: "utf8" });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /unresolved|base-image/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

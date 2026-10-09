import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveStubAssetsHash,
  parseDigestPinnedBase,
  readBaseImage,
  TestbedBuildInputsError,
} from "./testbed-build-inputs.mjs";

// 51-04 testbed 镜像——构建命令通过对 Dockerfile COPY 进镜像的那份“精确 stub 资产文件集合”做哈希，
// 推导出 manifest 的 `stubAssetsHash`（计划 §1）。这就是清点收据：一份字节可复现的“究竟发了什么”的身份，
// 范围钉死在该代码路径的精确文件列表上（census-scope-match-code-path——作者提供的列表，绝不递归遍历，
// 那会把未跟踪/生成的兄弟文件多算进来）。摘要取在规范化内容之上（每个文件哈希，再对排序后的
// {path,sha256} 映射哈希）——绝不朴素地拼接 path/内容，否则一个分隔符就能伪造（hash-join-delimiter-forgery）。
// 缺文件 / 空集合 / 路径逃逸资产根，都响亮失败（绝不静默产出半成品收据）。

/** Build a temp asset tree from a {relpath: content} map; returns its root dir. */
function makeAssetTree(entries) {
  const root = mkdtempSync(join(tmpdir(), "testbed-assets-"));
  for (const [rel, content] of Object.entries(entries)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const ASSETS = Object.freeze({
  "stub-runner.js": "// compiled stub runner\nexport const x = 1;\n",
  "stub-runner.protocol.md": "the stub protocol\n",
  "hooks/compaction-restore-bridge.cjs": "module.exports = {};\n",
});

test("produces a 64-hex digest + a sorted per-file census receipt over the asset set", () => {
  const root = makeAssetTree(ASSETS);
  try {
    const { hash, receipt } = deriveStubAssetsHash(root, Object.keys(ASSETS));
    assert.match(hash, /^[0-9a-f]{64}$/);
    // 收据列出每个具名资产，各自带它的 64 位十六进制内容 digest，按路径排序。
    assert.equal(receipt.files.length, 3);
    assert.deepEqual(
      receipt.files.map((f) => f.path),
      ["hooks/compaction-restore-bridge.cjs", "stub-runner.js", "stub-runner.protocol.md"],
    );
    for (const f of receipt.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("REBUILD CONTRACT: identical files => identical digest, INDEPENDENT of input list order", () => {
  const a = makeAssetTree(ASSETS);
  const b = makeAssetTree(ASSETS);
  try {
    const forward = deriveStubAssetsHash(a, Object.keys(ASSETS));
    const reversed = deriveStubAssetsHash(b, [...Object.keys(ASSETS)].reverse());
    assert.equal(forward.hash, reversed.hash);
    assert.equal(JSON.stringify(forward.receipt), JSON.stringify(reversed.receipt));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("content sensitivity: changing ANY file's bytes changes the digest", () => {
  const base = makeAssetTree(ASSETS);
  const mutated = makeAssetTree({ ...ASSETS, "stub-runner.js": "// DIFFERENT bytes\n" });
  try {
    assert.notEqual(
      deriveStubAssetsHash(base, Object.keys(ASSETS)).hash,
      deriveStubAssetsHash(mutated, Object.keys(ASSETS)).hash,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(mutated, { recursive: true, force: true });
  }
});

test("path sensitivity: same content at a different path changes the digest (path is identity)", () => {
  const a = makeAssetTree({ "a.js": "same", "b.js": "other" });
  const b = makeAssetTree({ "renamed.js": "same", "b.js": "other" });
  try {
    assert.notEqual(
      deriveStubAssetsHash(a, ["a.js", "b.js"]).hash,
      deriveStubAssetsHash(b, ["renamed.js", "b.js"]).hash,
    );
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("set sensitivity: adding or dropping a file changes the digest", () => {
  const full = makeAssetTree(ASSETS);
  try {
    const all = deriveStubAssetsHash(full, Object.keys(ASSETS)).hash;
    const fewer = deriveStubAssetsHash(full, ["stub-runner.js", "stub-runner.protocol.md"]).hash;
    assert.notEqual(all, fewer);
  } finally {
    rmSync(full, { recursive: true, force: true });
  }
});

test("forgery-resistance: a delimiter/quote in a path cannot forge another honest set's digest", () => {
  // 朴素的 `${path}:${contentHash}` 拼接，会让一个精心构造的路径嵌入兄弟字段的边界，
  // 与另一组合法资产相撞。规范化 JSON 转义使它们保持可区分。
  const honest = makeAssetTree({ "a.js": "x", "b.js": "y" });
  const forged = makeAssetTree({ 'a.js","sha256":"forged': "x", "b.js": "y" });
  try {
    assert.notEqual(
      deriveStubAssetsHash(honest, ["a.js", "b.js"]).hash,
      deriveStubAssetsHash(forged, ['a.js","sha256":"forged', "b.js"]).hash,
    );
  } finally {
    rmSync(honest, { recursive: true, force: true });
    rmSync(forged, { recursive: true, force: true });
  }
});

test("loud-fail: empty asset set (never a silent empty receipt)", () => {
  const root = makeAssetTree(ASSETS);
  try {
    assert.throws(() => deriveStubAssetsHash(root, []), TestbedBuildInputsError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loud-fail: a named asset that does not exist on disk", () => {
  const root = makeAssetTree(ASSETS);
  try {
    assert.throws(
      () => deriveStubAssetsHash(root, ["stub-runner.js", "does-not-exist.js"]),
      TestbedBuildInputsError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loud-fail: a path escaping the asset root (containment guard)", () => {
  const root = makeAssetTree(ASSETS);
  try {
    assert.throws(() => deriveStubAssetsHash(root, ["../escape.js"]), TestbedBuildInputsError);
    assert.throws(() => deriveStubAssetsHash(root, ["/etc/passwd"]), TestbedBuildInputsError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- 基础镜像：digest 钉死栅栏（计划 §1：“digest 钉死，而非浮动 tag”）---
// 基础的 LTS-slim Linux 必须按 @sha256 digest 钉死，使镜像字节可复现；浮动 tag 的 base
// （`debian:bookworm-slim`）会在两次构建间悄悄漂移。解析出的 digest 成为 manifest 的 baseDigest。
// 构建命令拒绝 digest 钉死以外的任何引用；digest 在宿主机侧解析（locus 裁决）并记录在
// docker/testbed/base-image。

const GOOD_DIGEST = "sha256:" + "a".repeat(64);

test("parseDigestPinnedBase accepts a digest-pinned ref and returns its name + sha256 digest", () => {
  const { ref, name, digest } = parseDigestPinnedBase(`debian:bookworm-slim@${GOOD_DIGEST}`);
  assert.equal(ref, `debian:bookworm-slim@${GOOD_DIGEST}`);
  assert.equal(name, "debian:bookworm-slim");
  assert.equal(digest, GOOD_DIGEST);
  // 完整限定的 registry 路径也可以。
  assert.equal(parseDigestPinnedBase(`docker.io/library/debian@${GOOD_DIGEST}`).digest, GOOD_DIGEST);
});

test("parseDigestPinnedBase REFUSES a tag-floating (non-@sha256) base — the fence", () => {
  assert.throws(() => parseDigestPinnedBase("debian:bookworm-slim"), TestbedBuildInputsError);
  assert.throws(() => parseDigestPinnedBase("node:22.22.1-bookworm-slim"), TestbedBuildInputsError);
});

test("parseDigestPinnedBase REFUSES a malformed digest (short hex / non-hex / wrong algo)", () => {
  assert.throws(() => parseDigestPinnedBase("debian@sha256:" + "a".repeat(63)), TestbedBuildInputsError);
  assert.throws(() => parseDigestPinnedBase("debian@sha256:" + "g".repeat(64)), TestbedBuildInputsError);
  assert.throws(() => parseDigestPinnedBase("debian@sha256:" + "A".repeat(64)), TestbedBuildInputsError);
  assert.throws(() => parseDigestPinnedBase("debian@sha512:" + "a".repeat(128)), TestbedBuildInputsError);
});

test("parseDigestPinnedBase REFUSES empty / non-string input", () => {
  assert.throws(() => parseDigestPinnedBase(""), TestbedBuildInputsError);
  assert.throws(() => parseDigestPinnedBase("   "), TestbedBuildInputsError);
  assert.throws(() => parseDigestPinnedBase(null), TestbedBuildInputsError);
});

test("readBaseImage reads a comment-tolerant single digest-pinned ref from a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "testbed-base-"));
  try {
    const p = join(dir, "base-image");
    writeFileSync(p, `# resolved host-side per the L0 runbook\n\ndebian:bookworm-slim@${GOOD_DIGEST}\n`);
    const { digest, name } = readBaseImage(p);
    assert.equal(digest, GOOD_DIGEST);
    assert.equal(name, "debian:bookworm-slim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBaseImage loud-fails on an UNRESOLVED slot (comment-only — no ref yet)", () => {
  const dir = mkdtempSync(join(tmpdir(), "testbed-base-"));
  try {
    const p = join(dir, "base-image");
    writeFileSync(p, "# not yet resolved — run the host-side base-image resolve step\n");
    assert.throws(() => readBaseImage(p), TestbedBuildInputsError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBaseImage loud-fails on multiple refs (ambiguous) and on a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "testbed-base-"));
  try {
    const p = join(dir, "base-image");
    writeFileSync(p, `debian@${GOOD_DIGEST}\nubuntu@${GOOD_DIGEST}\n`);
    assert.throws(() => readBaseImage(p), TestbedBuildInputsError);
    assert.throws(() => readBaseImage(join(dir, "nope")), TestbedBuildInputsError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

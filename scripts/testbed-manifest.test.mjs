import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTestbedManifest, TestbedManifestError } from "./testbed-manifest.mjs";

// 51-04 testbed 镜像——可复现 manifest 是 runner / 51-05 矩阵每次运行所引用的持久身份
// （清点收据纪律，计划 §1 + §3）。重建契约：相同输入 => 字节一致的 manifest + digest。
// 摘要取在规范化的排序键 JSON 之上，绝不朴素拼接字段——一个值内嵌的分隔符绝不能伪造出另一组输入的 digest
// （hash-join-delimiter-forgery）。缺失/非法输入响亮失败（绝不静默产出一份看似构建正常的半成品 manifest）。
// 纯函数、零依赖：只用 node:test。

const BASE = Object.freeze({
  baseDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  nodeVersion: "22.22.1",
  openrigSha: "9cf781060000000000000000000000000000000",
  stubAssetsHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  gitSha: "9cf781060000000000000000000000000000000",
});

test("produces the four identity fields + image tag + a sha256 manifest digest", () => {
  const m = computeTestbedManifest(BASE);
  assert.equal(m.baseDigest, BASE.baseDigest);
  assert.equal(m.nodeVersion, BASE.nodeVersion);
  assert.equal(m.openrigSha, BASE.openrigSha);
  assert.equal(m.stubAssetsHash, BASE.stubAssetsHash);
  // 镜像身份按 git sha 打标签（计划 §1：openrig-testbed:<git-sha>）。
  assert.equal(m.image, `openrig-testbed:${BASE.gitSha}`);
  // manifest 自带其内容 digest（64 位十六进制 sha256）。
  assert.match(m.manifestDigest, /^[0-9a-f]{64}$/);
});

test("REBUILD CONTRACT: same inputs => byte-identical manifest JSON + identical digest", () => {
  const a = computeTestbedManifest(BASE);
  const b = computeTestbedManifest({ ...BASE });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b)); // byte-stable serialization
  assert.equal(a.manifestDigest, b.manifestDigest);
});

test("per-field sensitivity: changing ANY identity field changes the digest (no collision)", () => {
  const base = computeTestbedManifest(BASE);
  for (const field of ["baseDigest", "nodeVersion", "openrigSha", "stubAssetsHash", "gitSha"]) {
    const mutated = computeTestbedManifest({ ...BASE, [field]: `${BASE[field]}-x` });
    assert.notEqual(mutated.manifestDigest, base.manifestDigest, `${field} must affect the digest`);
  }
});

test("forgery-resistance: a delimiter/quote inside a value cannot forge another input set's digest", () => {
  // 朴素的 `fields.join(":")`（或不转义的拼接）会让一个精心构造、内嵌分隔符+兄弟字段内容的值，
  // 与另一组合法输入相撞。规范化 JSON 会转义，因此这两组不同输入必须产出不同 digest。
  const honest = computeTestbedManifest({ ...BASE, nodeVersion: "22", openrigSha: "abc" });
  const forged = computeTestbedManifest({ ...BASE, nodeVersion: '22","openrigSha":"abc', openrigSha: "z" });
  assert.notEqual(honest.manifestDigest, forged.manifestDigest);
});

test("loud-fail on a missing or empty required identity field (never a silent partial manifest)", () => {
  for (const field of ["baseDigest", "nodeVersion", "openrigSha", "stubAssetsHash", "gitSha"]) {
    assert.throws(() => computeTestbedManifest({ ...BASE, [field]: "" }), TestbedManifestError, `empty ${field}`);
    const { [field]: _omit, ...missing } = BASE;
    assert.throws(() => computeTestbedManifest(missing), TestbedManifestError, `missing ${field}`);
  }
  assert.throws(() => computeTestbedManifest(null), TestbedManifestError);
});

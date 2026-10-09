import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveStubAssetsHash } from "./testbed-build-inputs.mjs";

// 51-04 stub 资产增量——把 L0.2 清点检查做成一条持久约束。构建命令
// （scripts/build-testbed-image.sh）恰好按 docker/testbed/stub-assets.list 里列的路径暂存，
// 并把同一份清单喂给 manifest 清点（census-scope-match-code-path）。空清点是 L0.2 失败——
// deriveStubAssetsHash 响亮失败，构建命令拒绝执行。本测试套件钉死：发货清单点名的是那个具体的
// 零 token stub 三件套（一个 runtime:stub rig.yaml + 它的 agent 夹具 + culture.md），且收据形态正确，
// 使清单永远不能默默漂回为空、或引用一个不存在的文件。

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIST = join(REPO_ROOT, "docker/testbed/stub-assets.list");

// 与构建命令喂给清点的完全相同的、容忍注释的解析（剥掉 #.*、trim、去掉空行——
// build-testbed-image.sh 的 node -e / while-read），使测试的清点 == 构建的清点，逐字节一致。
function parseCensus(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((s) => s.replace(/#.*/, "").trim())
    .filter(Boolean);
}

// 具体的 stub 三件套（已排序——deriveStubAssetsHash 按 POSIX 路径排序收据）。
const EXPECTED = [
  "docker/testbed/stub-assets/agents/worker/agent.yaml",
  "docker/testbed/stub-assets/culture.md",
  "docker/testbed/stub-assets/rig.yaml",
];

test("stub-assets.list census is populated (empty census = L0.2 FAIL, build verb refuses)", () => {
  const files = parseCensus(LIST);
  assert.ok(files.length > 0, "stub-assets.list must be populated (an empty census fails L0.2)");
});

test("census names EXACTLY the stub trio and every listed file exists", () => {
  const files = parseCensus(LIST);
  assert.deepEqual(
    [...files].sort(),
    EXPECTED,
    "census must name exactly the stub trio (rig.yaml + culture.md + agent fixture)",
  );
  for (const rel of files) {
    assert.ok(existsSync(join(REPO_ROOT, rel)), `listed stub asset must exist: ${rel}`);
  }
});

test("L0.2 receipt: deriveStubAssetsHash lists exactly the trio, each with a 64-hex sha256", () => {
  const files = parseCensus(LIST);
  const { hash, receipt } = deriveStubAssetsHash(REPO_ROOT, files);
  assert.match(hash, /^[0-9a-f]{64}$/, "census hash is a 64-hex sha256");
  assert.deepEqual(
    receipt.files.map((f) => f.path).sort(),
    EXPECTED,
    "receipt names exactly the trio",
  );
  for (const f of receipt.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/, `each receipt entry carries a 64-hex digest: ${f.path}`);
  }
});

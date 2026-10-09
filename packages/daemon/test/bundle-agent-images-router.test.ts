import { describe, it, expect } from "vitest";
import { routeAgentImages, type AgentImagesRouterFsOps, type RouteAgentImagesInput } from "../src/domain/bundle-agent-images-router.js";

// 第 6 项 / slice-05 Checkpoint 7.3g 第 2 步：bundle-agent-images-router 纯函数测试。PRD 第 197
// 行规定声明路径是 agent-image 目录（不是 manifest 路径，与 context_packs 不同）。按照预存纪律，
// 首次提交即包含 4 个预存路由层捕获：文件存在性、manifest 的 isDirectory 检查、声明路径必须为
// 目录，以及 basename 冲突。

function mockFs(initial: { dirs?: string[]; files?: string[] } = {}): AgentImagesRouterFsOps & {
  _copyCalls: Array<{ src: string; dest: string }>;
  _mkdirpCalls: string[];
  _dirs: Set<string>;
  _files: Set<string>;
} {
  const dirs = new Set<string>(initial.dirs ?? []);
  const files = new Set<string>(initial.files ?? []);
  const copyCalls: Array<{ src: string; dest: string }> = [];
  const mkdirpCalls: string[] = [];
  return {
    _copyCalls: copyCalls,
    _mkdirpCalls: mkdirpCalls,
    _dirs: dirs,
    _files: files,
    exists: (p: string) => dirs.has(p) || files.has(p),
    isDirectory: (p: string) => dirs.has(p),
    mkdirp: (p: string) => { mkdirpCalls.push(p); dirs.add(p); },
    copyDir: (src: string, dest: string) => { copyCalls.push({ src, dest }); dirs.add(dest); },
  };
}

/** 便捷函数：构建完整 agent-image fixture（image 目录及其中的 manifest.yaml 文件）。 */
function imageFixture(imageDir: string): { dirs: string[]; files: string[] } {
  return { dirs: [imageDir], files: [`${imageDir}/manifest.yaml`] };
}

const BUNDLE_ROOT = "/bundle/root";
const TARGET = "/operator/.openrig/agent-images";

function makeInput(overrides?: Partial<RouteAgentImagesInput>): RouteAgentImagesInput {
  return {
    bundleRoot: BUNDLE_ROOT,
    declaredAgentImages: [],
    targetAgentImagesDir: TARGET,
    ...overrides,
  };
}

describe("routeAgentImages", () => {
  // A1：空 list 产生空 records，并创建目标目录。
  it("空 declaredAgentImages 产生空 records，但仍创建目标目录", () => {
    const fs = mockFs();
    const result = routeAgentImages(makeInput(), fs);
    expect(result.records).toEqual([]);
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
    expect(fs._mkdirpCalls).toContain(TARGET);
  });

  // A2：路由一个 image：copyDir 从 sourceAbs（声明目录）复制到 target/<basename>。
  it("路由一个 agent_image：把声明目录复制到 target/<basename>", () => {
    const fs = mockFs(imageFixture(`${BUNDLE_ROOT}/agent-images/seat-a`));
    const result = routeAgentImages(
      makeInput({ declaredAgentImages: ["agent-images/seat-a"] }),
      fs,
    );
    expect(result.routedCount).toBe(1);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/seat-a`);
    expect(fs._copyCalls).toHaveLength(1);
    expect(fs._copyCalls[0]).toEqual({
      src: `${BUNDLE_ROOT}/agent-images/seat-a`,
      dest: `${TARGET}/seat-a`,
    });
  });

  // A3：正确路由多个不同 image。
  it("把多个不同 agent_image 分别路由到 target/<basename>", () => {
    const fs = mockFs({
      dirs: [`${BUNDLE_ROOT}/agent-images/seat-a`, `${BUNDLE_ROOT}/agent-images/seat-b`],
      files: [
        `${BUNDLE_ROOT}/agent-images/seat-a/manifest.yaml`,
        `${BUNDLE_ROOT}/agent-images/seat-b/manifest.yaml`,
      ],
    });
    const result = routeAgentImages(
      makeInput({
        declaredAgentImages: [
          "agent-images/seat-a",
          "agent-images/seat-b",
        ],
      }),
      fs,
    );
    expect(result.routedCount).toBe(2);
    expect(fs._copyCalls).toHaveLength(2);
  });

  // A4：声明的源目录缺失时 status=missing。
  it("声明的 image 目录缺失时 status=missing（真实作用域）", () => {
    const fs = mockFs();
    const result = routeAgentImages(
      makeInput({ declaredAgentImages: ["agent-images/absent"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.records[0]!.status).toBe("missing");
    expect(result.records[0]!.detail).toContain("not present");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // A5：拒绝逃逸 bundle workspace 的不安全源路径。
  it("逃逸 bundle workspace 的不安全源路径产生 status=unsafe", () => {
    const fs = mockFs();
    const result = routeAgentImages(
      makeInput({ declaredAgentImages: ["../escape"] }),
      fs,
    );
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("escapes bundle workspace");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // A6（符合 PRD 的判别）：声明路径存在但为文件而非目录。PRD 第 197 行规定声明路径是
  // agent-image 目录；操作员声明的路径为文件时拒绝。
  it("声明路径存在但为文件（非目录）时 status=not_directory", () => {
    const fs = mockFs({ files: [`${BUNDLE_ROOT}/agent-images/seat-as-file`] });
    const result = routeAgentImages(
      makeInput({ declaredAgentImages: ["agent-images/seat-as-file"] }),
      fs,
    );
    expect(result.records[0]!.status).toBe("not_directory");
    expect(result.records[0]!.detail).toContain("not a directory");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // A7（预存 d491eca9 教训）：image 目录存在但其中缺少 manifest.yaml。消费者跳过该 image，
  // 属于 routedCount 假阳性类别。
  it("image 目录存在但其中缺少 manifest.yaml 时 status=not_manifest", () => {
    const fs = mockFs({
      dirs: [`${BUNDLE_ROOT}/agent-images/halfimage`],
      // 没有 manifest.yaml 文件。
    });
    const result = routeAgentImages(
      makeInput({ declaredAgentImages: ["agent-images/halfimage"] }),
      fs,
    );
    expect(result.records[0]!.status).toBe("not_manifest");
    expect(result.records[0]!.detail).toContain("missing manifest.yaml");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // A8（预存 3cd581e3 教训）：image 目录存在，但其中 manifest.yaml 本身是目录而非文件。
  // 消费者的 readFileSync 会抛错，属于假阳性类别，因此拒绝。
  it("image 目录存在但其中 manifest.yaml 本身是目录时 status=not_manifest", () => {
    const fs = mockFs({
      dirs: [
        `${BUNDLE_ROOT}/agent-images/dirmanifest`,
        `${BUNDLE_ROOT}/agent-images/dirmanifest/manifest.yaml`,
      ],
    });
    const result = routeAgentImages(
      makeInput({ declaredAgentImages: ["agent-images/dirmanifest"] }),
      fs,
    );
    expect(result.records[0]!.status).toBe("not_manifest");
    expect(result.records[0]!.detail).toContain("directory");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // A9（预存 16ebb8af 教训）：两个声明 image 共享 basename 时，第一个胜出（status=routed），
  // 第二个标为 status=conflict。
  it("两个声明 image 共享 basename 时第一个 routed、第二个 conflict（真实 routedCount）", () => {
    const fs = mockFs({
      dirs: [
        `${BUNDLE_ROOT}/a/seat-a`,
        `${BUNDLE_ROOT}/b/seat-a`,
      ],
      files: [
        `${BUNDLE_ROOT}/a/seat-a/manifest.yaml`,
        `${BUNDLE_ROOT}/b/seat-a/manifest.yaml`,
      ],
    });
    const result = routeAgentImages(
      makeInput({
        declaredAgentImages: ["a/seat-a", "b/seat-a"],
      }),
      fs,
    );
    expect(result.records).toHaveLength(2);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/seat-a`);
    expect(result.records[1]!.status).toBe("conflict");
    expect(result.records[1]!.detail).toContain("seat-a");
    expect(result.records[1]!.detail).toContain("collides");
    expect(fs._copyCalls).toHaveLength(1);
    expect(fs._copyCalls[0]!.src).toBe(`${BUNDLE_ROOT}/a/seat-a`);
  });

  // A10：混合列表，汇总 routed + missing + unsafe + not_directory + not_manifest + conflict。
  it("混合声明列表正确汇总所有拒绝类别", () => {
    const fs = mockFs({
      dirs: [
        `${BUNDLE_ROOT}/agent-images/ok`,
        `${BUNDLE_ROOT}/agent-images/halfimage`, // no manifest.yaml inside
        `${BUNDLE_ROOT}/agent-images/dup`,
        `${BUNDLE_ROOT}/elsewhere/dup`,
      ],
      files: [
        `${BUNDLE_ROOT}/agent-images/ok/manifest.yaml`,
        `${BUNDLE_ROOT}/agent-images/seat-as-file`, // file at declared location
        `${BUNDLE_ROOT}/agent-images/dup/manifest.yaml`,
        `${BUNDLE_ROOT}/elsewhere/dup/manifest.yaml`,
      ],
    });
    const result = routeAgentImages(
      makeInput({
        declaredAgentImages: [
          "agent-images/ok",                  // routed
          "agent-images/absent",              // missing
          "../escape",                         // unsafe
          "agent-images/seat-as-file",        // not_directory
          "agent-images/halfimage",           // not_manifest (no manifest.yaml inside)
          "agent-images/dup",                 // routed (1st dup)
          "elsewhere/dup",                    // conflict (basename dup)
        ],
      }),
      fs,
    );
    expect(result.records).toHaveLength(7);
    expect(result.routedCount).toBe(2);
    expect(result.rejectedCount).toBe(5);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[1]!.status).toBe("missing");
    expect(result.records[2]!.status).toBe("unsafe");
    expect(result.records[3]!.status).toBe("not_directory");
    expect(result.records[4]!.status).toBe("not_manifest");
    expect(result.records[5]!.status).toBe("routed");
    expect(result.records[6]!.status).toBe("conflict");
  });
});

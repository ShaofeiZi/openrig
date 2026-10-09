import { describe, it, expect } from "vitest";
import nodePath from "node:path";
import { routeWorkflowSpecs, type WorkflowSpecsRouterFsOps, type RouteWorkflowSpecsInput } from "../src/domain/bundle-workflow-specs-router.js";

// 第 6 项 / slice-05 Checkpoint 7.3e 第 2 步：bundle-workflow-specs-router 纯函数测试。
// 镜像 bundle-skills-router 测试模式，使用 "workflows/" prefix 与 YAML file content shape。

function mockFs(initialFiles: Record<string, string> = {}): WorkflowSpecsRouterFsOps & { _written: Map<string, string>; _mkdirpCalls: string[] } {
  const written = new Map<string, string>(Object.entries(initialFiles));
  const mkdirpCalls: string[] = [];
  return {
    _written: written,
    _mkdirpCalls: mkdirpCalls,
    exists: (p: string) => written.has(p),
    readFile: (p: string) => {
      const v = written.get(p);
      if (v === undefined) throw new Error(`File not found in mock: ${p}`);
      return v;
    },
    writeFile: (p: string, c: string) => { written.set(p, c); },
    mkdirp: (p: string) => { mkdirpCalls.push(p); },
  };
}

const BUNDLE_ROOT = "/bundle/root";
// TARGET 是任意 fixture path——router 由 targetWorkflowSpecsDir 参数化，unit test 不依赖任何特定
// operator-host layout。以下位置记录的 CALLER CONTRACT：
// bundle-workflow-specs-router.ts RouteWorkflowSpecsInput.targetWorkflowSpecsDir
// 要求第 3 步 integration 通过以下方式解析：
// `nodePath.join(ContextPackSettingsStore.resolveConfig().workspaceSpecsRoot,
// "workflows")`——SettingsStore 是唯一 authority。若在此硬编码 scanner-default path，
// SettingsStore 默认值变化时会产生 drift 风险；integration-level dogfood 证明接线。
const TARGET = "/test/workflow-specs-target";

function makeInput(overrides?: Partial<RouteWorkflowSpecsInput>): RouteWorkflowSpecsInput {
  return {
    bundleRoot: BUNDLE_ROOT,
    declaredWorkflowSpecs: [],
    targetWorkflowSpecsDir: TARGET,
    ...overrides,
  };
}

describe("routeWorkflowSpecs", () => {
  // W1：空 list → 空 record + 仍 mkdirp target dir
  it("空 declaredWorkflowSpecs 生成空 record，但仍 mkdirp target", () => {
    const fs = mockFs();
    const result = routeWorkflowSpecs(makeInput(), fs);
    expect(result.records).toEqual([]);
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
    expect(fs._mkdirpCalls).toContain(TARGET);
  });

  // W2：以 top-level basename 端到端路由一个 spec
  it("路由一个 workflow_spec：将 source YAML 复制到 target/<basename> 并填充 installedAt", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/workflows/onboarding.yaml`]: "name: onboarding\nversion: 1.0",
    });
    const result = routeWorkflowSpecs(makeInput({ declaredWorkflowSpecs: ["workflows/onboarding.yaml"] }), fs);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(0);
    expect(result.records[0]!.status).toBe("routed");
    // 仅 basename：声明 "workflows/onboarding.yaml" → target/onboarding.yaml
    //（scanner-reachability contract：spec-library-workflow-scanner 只读取 top-level YAML；
    // nested path 不可见）。
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/onboarding.yaml`);
    expect(fs._written.get(`${TARGET}/onboarding.yaml`)).toBe("name: onboarding\nversion: 1.0");
  });

  // W3：将多个 spec 全部平铺路由到顶层（basename 折叠 layout）
  it("将多个 workflow_spec 全部平铺路由到顶层（basename 折叠 directory layout）", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/workflows/onboarding.yaml`]: "yaml-1",
      [`${BUNDLE_ROOT}/workflows/release.yaml`]: "yaml-2",
      [`${BUNDLE_ROOT}/workflows/sub/maintenance.yaml`]: "yaml-3",
    });
    const result = routeWorkflowSpecs(
      makeInput({
        declaredWorkflowSpecs: ["workflows/onboarding.yaml", "workflows/release.yaml", "workflows/sub/maintenance.yaml"],
      }),
      fs,
    );
    expect(result.routedCount).toBe(3);
    // 全部落到 top-level basename——第 3 个 entry 的 "sub/" prefix 被 basename() 移除。
    // 这符合 scanner-reachability（只使用 readdirSync + isFile）。
    expect(fs._written.get(`${TARGET}/onboarding.yaml`)).toBe("yaml-1");
    expect(fs._written.get(`${TARGET}/release.yaml`)).toBe("yaml-2");
    expect(fs._written.get(`${TARGET}/maintenance.yaml`)).toBe("yaml-3");
    // 确认未创建原本可能 nested 的 path（basename 已将其平铺）。
    expect(fs._written.has(`${TARGET}/sub/maintenance.yaml`)).toBe(false);
  });

  // W4：source 文件缺失 → "missing" record（跳过，而非 error）
  it("缺失 source 文件以 status=missing 跳过（honest-scoping）", () => {
    const fs = mockFs();
    const result = routeWorkflowSpecs(
      makeInput({ declaredWorkflowSpecs: ["workflows/absent.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("missing");
    expect(result.records[0]!.detail).toContain("不存在");
  });

  // W5：拒绝逃逸 bundle workspace 的 unsafe source path
  it("拒绝逃逸 bundle workspace 的 unsafe declared path（../traversal）", () => {
    const fs = mockFs();
    const result = routeWorkflowSpecs(
      makeInput({ declaredWorkflowSpecs: ["../escape/spec.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("越出 bundle 工作区");
  });

  // W6：mixed list——一次调用包含 routed + missing + unsafe
  it("mixed declared list 正确聚合 routed/missing/unsafe", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/workflows/ok.yaml`]: "ok",
    });
    const result = routeWorkflowSpecs(
      makeInput({
        declaredWorkflowSpecs: ["workflows/ok.yaml", "workflows/absent.yaml", "../escape/spec.yaml"],
      }),
      fs,
    );
    expect(result.records).toHaveLength(3);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(2);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[1]!.status).toBe("missing");
    expect(result.records[2]!.status).toBe("unsafe");
  });

  // W7：target-side escape attempt 安全落在 basename（通过 basename 结构性 containment——替代
  // skills router 旧 prefix-strip target-escape hazard；basename 保证不会 traversal）。
  it("通过 traversal 的 target-escape attempt 仍安全落在 basename（结构性 containment）", () => {
    const fs = mockFs({
      // source 可通过 "workflows/../outside/spec.yaml" 从 bundleRoot 到达；它解析为
      // "<bundleRoot>/outside/spec.yaml"——通过 source check。
      [`${BUNDLE_ROOT}/outside/spec.yaml`]: "would-have-escaped-target",
    });
    const result = routeWorkflowSpecs(
      makeInput({ declaredWorkflowSpecs: ["workflows/../outside/spec.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(0);
    expect(result.records[0]!.status).toBe("routed");
    // basename("workflows/../outside/spec.yaml") = "spec.yaml" → 安全落盘。
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/spec.yaml`);
    expect(fs._written.get(`${TARGET}/spec.yaml`)).toBe("would-have-escaped-target");
    // 确认：不写入 target dir 之外。
    expect(fs._written.has(`${TARGET}/../outside/spec.yaml`)).toBe(false);
    expect(fs._written.has(nodePath.resolve(`${TARGET}/../outside/spec.yaml`))).toBe(false);
  });

  // W8：无 prefix 的 declared path 落在其 basename（basename 取代 prefix-strip——规则统一）。
  it("没有任何前导 prefix 的 declared path 路由到 target/<basename>", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/custom/path/spec.yaml`]: "custom",
    });
    const result = routeWorkflowSpecs(
      makeInput({ declaredWorkflowSpecs: ["custom/path/spec.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(1);
    // basename("custom/path/spec.yaml") = "spec.yaml" → target 下的 top-level。
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/spec.yaml`);
    expect(fs._written.has(`${TARGET}/custom/path/spec.yaml`)).toBe(false);
  });

  // W9：basename 重复——第一个胜出（status=routed），后续标记 status=conflict，使 routedCount 在
  // scanner-visible boundary 保持真实（banked B1 guard catch d81456dc → 本 commit）。
  it("basename 重复：第一个路由，后续标记 status=conflict（真实 routedCount）", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/a/onboarding.yaml`]: "a-content",
      [`${BUNDLE_ROOT}/b/onboarding.yaml`]: "b-content",
    });
    const result = routeWorkflowSpecs(
      makeInput({ declaredWorkflowSpecs: ["a/onboarding.yaml", "b/onboarding.yaml"] }),
      fs,
    );
    expect(result.records).toHaveLength(2);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/onboarding.yaml`);
    expect(result.records[1]!.status).toBe("conflict");
    expect(result.records[1]!.detail).toContain("basename");
    expect(result.records[1]!.detail).toContain("冲突");
    // 关键：首份 content 保留（无静默覆盖）。
    expect(fs._written.get(`${TARGET}/onboarding.yaml`)).toBe("a-content");
  });

  // W10：非 YAML suffix——scanner 仅处理 YAML，因此该 route 不可见。写入前拒绝，使 routedCount
  // 保持真实（banked B2 guard catch d81456dc → 本 commit）。
  it("非 YAML suffix 的 declared path 以 status=unsafe 拒绝（scanner-invisible 类）", () => {
    const fs = mockFs({
      [`${BUNDLE_ROOT}/workflows/readme.txt`]: "not a workflow spec",
      [`${BUNDLE_ROOT}/workflows/good.yaml`]: "yaml-good",
    });
    const result = routeWorkflowSpecs(
      makeInput({ declaredWorkflowSpecs: ["workflows/readme.txt", "workflows/good.yaml"] }),
      fs,
    );
    expect(result.records).toHaveLength(2);
    expect(result.routedCount).toBe(1);
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("不是 .yaml/.yml");
    expect(result.records[1]!.status).toBe("routed");
    expect(result.records[1]!.installedAt).toBe(`${TARGET}/good.yaml`);
    // 即使 source 存在于 bundle，也绝不写入 .txt 文件
    expect(fs._written.has(`${TARGET}/readme.txt`)).toBe(false);
    // 同时覆盖 .yml 作为可接受 suffix
    const fs2 = mockFs({ [`${BUNDLE_ROOT}/workflows/short.yml`]: "yml-too" });
    const r2 = routeWorkflowSpecs(makeInput({ declaredWorkflowSpecs: ["workflows/short.yml"] }), fs2);
    expect(r2.routedCount).toBe(1);
    expect(r2.records[0]!.status).toBe("routed");
  });
});

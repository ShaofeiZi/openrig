import { describe, it, expect } from "vitest";
import { routePlugins, type PluginsRouterFsOps, type RoutePluginsInput } from "../src/domain/bundle-plugins-router.js";

// 第 6 项 / slice-05 Checkpoint 7.3c：bundle-plugins-router 纯函数测试。
// 应用已沉淀的双侧信任边界经验：同时约束来源和目标。

function mockFs(initial: { dirs?: string[]; files?: Record<string, string> } = {}): PluginsRouterFsOps & { _copyCalls: Array<{ src: string; dest: string }>; _mkdirpCalls: string[]; _dirs: Set<string> } {
  const dirs = new Set<string>(initial.dirs ?? []);
  const files = new Map<string, string>(Object.entries(initial.files ?? {}));
  const copyCalls: Array<{ src: string; dest: string }> = [];
  const mkdirpCalls: string[] = [];
  return {
    _copyCalls: copyCalls,
    _mkdirpCalls: mkdirpCalls,
    _dirs: dirs,
    exists: (p: string) => dirs.has(p) || files.has(p),
    isDirectory: (p: string) => dirs.has(p),
    mkdirp: (p: string) => { mkdirpCalls.push(p); dirs.add(p); },
    copyDir: (src: string, dest: string) => { copyCalls.push({ src, dest }); dirs.add(dest); },
  };
}

const BUNDLE_ROOT = "/bundle/root";
const TARGET = "/operator/.openrig/plugins";

function makeInput(overrides?: Partial<RoutePluginsInput>): RoutePluginsInput {
  return {
    bundleRoot: BUNDLE_ROOT,
    declaredPlugins: [],
    targetPluginsDir: TARGET,
    ...overrides,
  };
}

describe("routePlugins", () => {
  // P1：空 plugin 列表
  it("declaredPlugins 为空时生成空记录，但仍创建目标目录", () => {
    const fs = mockFs();
    const result = routePlugins(makeInput(), fs);
    expect(result.records).toEqual([]);
    expect(result.routedCount).toBe(0);
    expect(fs._mkdirpCalls).toContain(TARGET);
  });

  // P2：单个 plugin 端到端路由
  it("路由单个 plugin：调用 copyDir 从来源复制到目标/<id>", () => {
    const fs = mockFs({ dirs: [`${BUNDLE_ROOT}/plugins/gstack`] });
    const result = routePlugins(
      makeInput({
        declaredPlugins: [{ id: "gstack", source: { kind: "local", path: "plugins/gstack" } }],
      }),
      fs,
    );
    expect(result.routedCount).toBe(1);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/gstack`);
    expect(fs._copyCalls).toHaveLength(1);
    expect(fs._copyCalls[0]).toEqual({
      src: `${BUNDLE_ROOT}/plugins/gstack`,
      dest: `${TARGET}/gstack`,
    });
  });

  // P3：多个 plugin
  it("路由多个 plugin，每个都落到目标/<id>", () => {
    const fs = mockFs({ dirs: [`${BUNDLE_ROOT}/plugins/a`, `${BUNDLE_ROOT}/plugins/b`] });
    const result = routePlugins(
      makeInput({
        declaredPlugins: [
          { id: "a", source: { kind: "local", path: "plugins/a" } },
          { id: "b", source: { kind: "local", path: "plugins/b" } },
        ],
      }),
      fs,
    );
    expect(result.routedCount).toBe(2);
    expect(fs._copyCalls).toHaveLength(2);
  });

  // P4：如实跳过缺失来源
  it("来源 plugin 缺失时跳过，并返回 status=missing", () => {
    const fs = mockFs(); // no dirs
    const result = routePlugins(
      makeInput({
        declaredPlugins: [{ id: "absent", source: { kind: "local", path: "plugins/absent" } }],
      }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.records[0]!.status).toBe("missing");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // P5：拒绝文件形式的来源路径（而非目录）
  it("来源路径是文件而非目录时返回 status=not_directory", () => {
    const fs = mockFs({ files: { [`${BUNDLE_ROOT}/plugins/notadir.txt`]: "content" } });
    const result = routePlugins(
      makeInput({
        declaredPlugins: [{ id: "x", source: { kind: "local", path: "plugins/notadir.txt" } }],
      }),
      fs,
    );
    expect(result.records[0]!.status).toBe("not_directory");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // P6：拒绝从来源侧逃逸 bundle 工作区的路径
  it("来源路径逃逸 bundle 工作区时返回 status=unsafe（来源边界）", () => {
    const fs = mockFs();
    const result = routePlugins(
      makeInput({
        declaredPlugins: [{ id: "x", source: { kind: "local", path: "../escape" } }],
      }),
      fs,
    );
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("越出 bundle 工作区");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // P7：目标侧边界——拒绝解析到目标外的 plugin id
  //（应用已沉淀的双侧信任边界经验）
  it("含遍历段的 plugin id 逃逸目标 plugin 库时返回 status=unsafe（目标边界）", () => {
    const fs = mockFs({ dirs: [`${BUNDLE_ROOT}/plugins/legitsource`] });
    const result = routePlugins(
      makeInput({
        declaredPlugins: [{ id: "../escape-id", source: { kind: "local", path: "plugins/legitsource" } }],
      }),
      fs,
    );
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("解析到目标插件库外部");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // P8：拒绝非法 plugin 条目（缺少 id 或 source.kind 错误）
  it("拒绝 source.kind 非 local 的 plugin 引用", () => {
    const fs = mockFs({ dirs: [`${BUNDLE_ROOT}/plugins/x`] });
    const result = routePlugins(
      makeInput({
        declaredPlugins: [{ id: "x", source: { kind: "remote" as "local", path: "plugins/x" } }],
      }),
      fs,
    );
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("source.kind 必须为 'local'");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // P9：混合列表——汇总 routed、missing、unsafe 和 not_directory
  it("混合 plugin 列表能按状态正确汇总", () => {
    const fs = mockFs({
      dirs: [`${BUNDLE_ROOT}/plugins/ok`],
      files: { [`${BUNDLE_ROOT}/plugins/file.txt`]: "x" },
    });
    const result = routePlugins(
      makeInput({
        declaredPlugins: [
          { id: "good", source: { kind: "local", path: "plugins/ok" } },
          { id: "absent", source: { kind: "local", path: "plugins/missing" } },
          { id: "escapes", source: { kind: "local", path: "../escape" } },
          { id: "filething", source: { kind: "local", path: "plugins/file.txt" } },
        ],
      }),
      fs,
    );
    expect(result.records).toHaveLength(4);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(3);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[1]!.status).toBe("missing");
    expect(result.records[2]!.status).toBe("unsafe");
    expect(result.records[3]!.status).toBe("not_directory");
  });
});

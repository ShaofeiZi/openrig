import { describe, it, expect } from "vitest";
import { routeContextPacks, type ContextPacksRouterFsOps, type RouteContextPacksInput } from "../src/domain/bundle-context-packs-router.js";

// 第 6 项 / slice-05 检查点 7.3f 第 2 步：bundle-context-packs-router
// 纯函数测试。仿照基于目录的插件路由器，并依据消费者约定处理上下文包特有的退化输入
//（context-pack-library-service.scan 遍历直接子项为 manifest.yaml 的包目录）。

function mockFs(initial: { dirs?: string[]; files?: string[]; contents?: Record<string, string> } = {}): ContextPacksRouterFsOps & {
  _copyCalls: Array<{ src: string; dest: string }>;
  _mkdirpCalls: string[];
  _dirs: Set<string>;
  _files: Set<string>;
  readFile(path: string): string;
  listFiles(path: string): string[];
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
    // exists() 同时识别目录与文件（符合 node:fs.existsSync 语义）
    exists: (p: string) => dirs.has(p) || files.has(p),
    isDirectory: (p: string) => dirs.has(p),
    mkdirp: (p: string) => { mkdirpCalls.push(p); dirs.add(p); },
    copyDir: (src: string, dest: string) => { copyCalls.push({ src, dest }); dirs.add(dest); },
    readFile: (p: string) => initial.contents?.[p] ?? "",
    listFiles: (p: string) => [...files]
      .filter((file) => file.startsWith(`${p}/`))
      .map((file) => file.slice(p.length + 1))
      .sort(),
  };
}

/** 便捷函数：构建完整包夹具（父目录与 manifest.yaml 文件）。 */
function packFixture(packParentDir: string): { dirs: string[]; files: string[] } {
  return { dirs: [packParentDir], files: [`${packParentDir}/manifest.yaml`] };
}

const BUNDLE_ROOT = "/bundle/root";
const TARGET = "/operator/.openrig/context";

function makeInput(overrides?: Partial<RouteContextPacksInput>): RouteContextPacksInput {
  return {
    bundleRoot: BUNDLE_ROOT,
    declaredContextPacks: [],
    targetContextPacksDir: TARGET,
    ...overrides,
  };
}

describe("routeContextPacks 上下文包路由", () => {
  // C1：空列表 → 空记录，并仍创建目标目录
  it("declaredContextPacks 为空时生成空记录，但仍创建目标目录", () => {
    const fs = mockFs();
    const result = routeContextPacks(makeInput(), fs);
    expect(result.records).toEqual([]);
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(0);
    expect(fs._mkdirpCalls).toContain(TARGET);
  });

  // C2：路由一个包：通过 copyDir 从 sourceParentDir 复制到 target/<dirname>
  it("路由一个 context_pack：将父目录复制到 target/<dirname>", () => {
    const fs = mockFs(packFixture(`${BUNDLE_ROOT}/context-packs/intent`));
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["context-packs/intent/manifest.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(1);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/intent`);
    expect(fs._copyCalls).toHaveLength(1);
    expect(fs._copyCalls[0]).toEqual({
      src: `${BUNDLE_ROOT}/context-packs/intent`,
      dest: `${TARGET}/intent`,
    });
  });

  it("复制前拒绝 lore 类包，并提示迁移到公开位置", () => {
    const parent = `${BUNDLE_ROOT}/context-packs/lore`;
    const manifest = `${parent}/manifest.yaml`;
    const fs = mockFs({
      ...packFixture(parent),
      contents: {
        [manifest]: [
          "name: private-lore",
          'version: "1"',
          "taxonomy: lore",
          "files: []",
        ].join("\n"),
      },
    });
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["context-packs/lore/manifest.yaml"] }),
      fs,
    );

    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("lore_refused");
    expect(result.records[0]!.detail).toMatch(/lore-class|taxonomy:\s*lore/i);
    expect(result.records[0]!.detail).toMatch(/通用化|公开来源|内部内容包/);
    expect(fs._copyCalls).toHaveLength(0);
  });

  it("安装侧复制前拒绝包中任意位置的内部内容", () => {
    const parent = `${BUNDLE_ROOT}/context-packs/private`;
    const manifest = `${parent}/manifest.yaml`;
    const notes = `${parent}/notes.md`;
    const fs = mockFs({
      dirs: [parent],
      files: [manifest, notes],
      contents: {
        [manifest]: "name: private\nversion: '1'\ntaxonomy: world\nfiles: []\n",
        [notes]: "Continue at substrate/shared-docs/rigs/private.\n",
      },
    });
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["context-packs/private/manifest.yaml"] }),
      fs,
    );

    expect(result.routedCount).toBe(0);
    expect(result.records[0]!.status).toBe("substance_refused");
    expect(result.records[0]!.detail).toMatch(/internal-path/i);
    expect(result.records[0]!.detail).toMatch(/通用化|公开来源|内部内容包/);
    expect(fs._copyCalls).toHaveLength(0);
  });

  // C3：正确路由多个不同的包
  it("将多个不同的 context_pack 分别路由到 target/<dirname>", () => {
    const fs = mockFs({
      dirs: [`${BUNDLE_ROOT}/context-packs/intent`, `${BUNDLE_ROOT}/context-packs/persona`],
      files: [`${BUNDLE_ROOT}/context-packs/intent/manifest.yaml`, `${BUNDLE_ROOT}/context-packs/persona/manifest.yaml`],
    });
    const result = routeContextPacks(
      makeInput({
        declaredContextPacks: [
          "context-packs/intent/manifest.yaml",
          "context-packs/persona/manifest.yaml",
        ],
      }),
      fs,
    );
    expect(result.routedCount).toBe(2);
    expect(fs._copyCalls).toHaveLength(2);
  });

  // C4：缺少源包目录 → status=missing（父目录也不存在，因此 manifest.yaml 文件本身缺失）
  it("缺少源包目录 → status=missing（如实限定范围）", () => {
    const fs = mockFs();
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["context-packs/absent/manifest.yaml"] }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.records[0]!.status).toBe("missing");
    expect(result.records[0]!.detail).toContain("不存在");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // C5：拒绝逃逸 bundle 工作区的不安全源路径
  it("源路径逃逸 bundle 工作区 → status=unsafe", () => {
    const fs = mockFs();
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["../escape/manifest.yaml"] }),
      fs,
    );
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("逃逸 bundle 工作区");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // C6（退化输入）：basename 不是 manifest.yaml——消费者不可见类别。遵循已固化的
  // 交接前退化输入自测纪律。
  it("声明路径的 basename 不是 manifest.yaml → status=not_manifest", () => {
    const fs = mockFs({
      dirs: [`${BUNDLE_ROOT}/context-packs/oddpack`],
      files: [`${BUNDLE_ROOT}/context-packs/oddpack/pack.yaml`, `${BUNDLE_ROOT}/context-packs/oddpack/manifest.txt`],
    });
    const result = routeContextPacks(
      makeInput({
        declaredContextPacks: [
          "context-packs/oddpack/pack.yaml",
          "context-packs/oddpack/manifest.txt",
        ],
      }),
      fs,
    );
    expect(result.records).toHaveLength(2);
    expect(result.routedCount).toBe(0);
    expect(result.records[0]!.status).toBe("not_manifest");
    expect(result.records[0]!.detail).toContain("manifest.yaml");
    expect(result.records[1]!.status).toBe("not_manifest");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // C7（退化输入）：父目录 basename 冲突——先到者胜出，第二项标记冲突。
  // 应用已固化的 workflow_specs B1 经验。
  it("两个声明包共享父目录 basename → 第一个路由，第二个冲突", () => {
    const fs = mockFs({
      dirs: [`${BUNDLE_ROOT}/a/intent`, `${BUNDLE_ROOT}/b/intent`],
      files: [`${BUNDLE_ROOT}/a/intent/manifest.yaml`, `${BUNDLE_ROOT}/b/intent/manifest.yaml`],
    });
    const result = routeContextPacks(
      makeInput({
        declaredContextPacks: [
          "a/intent/manifest.yaml",
          "b/intent/manifest.yaml",
        ],
      }),
      fs,
    );
    expect(result.records).toHaveLength(2);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/intent`);
    expect(result.records[1]!.status).toBe("conflict");
    expect(result.records[1]!.detail).toContain("intent");
    expect(result.records[1]!.detail).toContain("冲突");
    // 仅触发第一次 copyDir。
    expect(fs._copyCalls).toHaveLength(1);
    expect(fs._copyCalls[0]!.src).toBe(`${BUNDLE_ROOT}/a/intent`);
  });

  // C8：包源路径存在但它是文件而非目录——边界情况（不常见；manifest.yaml 的
  // dirname 被解析为文件）。如实跳过。
  it("源父项存在但它是文件而非目录 → status=not_directory", () => {
    // 让清单文件存在（通过文件存在性检查），但将父项注册为文件而非目录。
    const fs = mockFs({ files: [`${BUNDLE_ROOT}/oddpath`, `${BUNDLE_ROOT}/oddpath/manifest.yaml`] });
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["oddpath/manifest.yaml"] }),
      fs,
    );
    expect(result.records[0]!.status).toBe("not_directory");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // C9：混合列表——正确汇总 routed、missing、unsafe、not_manifest 与 conflict
  it("混合声明列表可正确汇总所有拒绝类别", () => {
    const fs = mockFs({
      dirs: [
        `${BUNDLE_ROOT}/context-packs/ok`,
        `${BUNDLE_ROOT}/context-packs/dup`,
        `${BUNDLE_ROOT}/elsewhere/dup`,
      ],
      files: [
        `${BUNDLE_ROOT}/context-packs/ok/manifest.yaml`,
        `${BUNDLE_ROOT}/context-packs/dup/manifest.yaml`,
        `${BUNDLE_ROOT}/elsewhere/dup/manifest.yaml`,
      ],
    });
    const result = routeContextPacks(
      makeInput({
        declaredContextPacks: [
          "context-packs/ok/manifest.yaml",         // 已路由
          "context-packs/absent/manifest.yaml",      // 缺失
          "../escape/manifest.yaml",                  // 不安全
          "context-packs/odd/pack.yaml",              // 不是清单
          "context-packs/dup/manifest.yaml",         // 已路由（第一个重复项）
          "elsewhere/dup/manifest.yaml",             // 冲突（basename 与上项重复）
        ],
      }),
      fs,
    );
    expect(result.records).toHaveLength(6);
    expect(result.routedCount).toBe(2);
    expect(result.rejectedCount).toBe(4);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[1]!.status).toBe("missing");
    expect(result.records[2]!.status).toBe("unsafe");
    expect(result.records[3]!.status).toBe("not_manifest");
    expect(result.records[4]!.status).toBe("routed");
    expect(result.records[5]!.status).toBe("conflict");
  });

  // C11（退化输入 / d491eca9 中固化的护栏捕获）：声明路径存在 manifest.yaml，
  // 但它是目录而非文件。fs.exists 对两种形态都返回 true；实时消费者
  //（context-pack-library-service.ts:135 readFileSync）对目录路径会抛错，scan()
  // 只记录错误诊断而不索引包。路由器必须在写入前拒绝，以保持 routedCount 如实。
  it("manifest.yaml 存在但为目录 → status=not_manifest（无路由假阳性）", () => {
    const fs = mockFs({
      // 父项是目录，manifest.yaml 也是目录（不是文件）。仅 exists 检查会通过；
      // isDirectory 检查会捕获此情况。
      dirs: [
        `${BUNDLE_ROOT}/context-packs/dirpack`,
        `${BUNDLE_ROOT}/context-packs/dirpack/manifest.yaml`,
      ],
    });
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["context-packs/dirpack/manifest.yaml"] }),
      fs,
    );
    expect(result.records).toHaveLength(1);
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("not_manifest");
    expect(result.records[0]!.detail).toContain("目录");
    // 关键：不触发 copyDir（不得路由消费者不可见的包）
    expect(fs._copyCalls).toHaveLength(0);
  });

  // C10（退化输入 / a0e7e0e1 中固化的护栏捕获）：父目录存在，但 manifest.yaml
  // 文件本身缺失。ContextPackLibraryService.scan 会跳过缺少 manifest.yaml 的包
  //（context-pack-library-service.ts:76）。路由器必须检查清单文件本身是否存在，
  // 而不只是父目录，否则 routedCount 会声称路由了消费者不可见的包。
  it("父目录存在但 manifest.yaml 文件缺失 → status=missing（无路由假阳性）", () => {
    const fs = mockFs({
      // 父目录存在且 isDirectory 为真，但 files 中没有 manifest.yaml
      //（消费者要求文件本身存在）。
      dirs: [`${BUNDLE_ROOT}/context-packs/halfpack`],
    });
    const result = routeContextPacks(
      makeInput({ declaredContextPacks: ["context-packs/halfpack/manifest.yaml"] }),
      fs,
    );
    expect(result.records).toHaveLength(1);
    expect(result.routedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.records[0]!.status).toBe("missing");
    expect(result.records[0]!.detail).toContain("不存在");
    // 关键：不触发 copyDir（不得路由操作员不可见的包）
    expect(fs._copyCalls).toHaveLength(0);
  });
});

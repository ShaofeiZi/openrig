// OPR.0.5.3.6——rig-up 时安装已发布的拓扑默认值（证明项 3）。关键固定点：四个层级
// 落在 topology.root 下，实例文件位于根目录顶层；仅在缺失时复制，绝不覆盖积累的上下文；
// 不含 topology/ 的规范属于正常空操作；失败会明确记录，绝不抛出（rig 启动不得因复制
// 默认值而终止）。
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { installTopologyDefaults, type TopologyDefaultsFsOps } from "../src/domain/topology-defaults-installer.js";

const SPEC = "/specs/product-team";
const ROOT = "/inst/topology";

function memFs(initial: Record<string, string>): { ops: TopologyDefaultsFsOps; files: Record<string, string>; dirs: Set<string> } {
  const files = { ...initial };
  const dirs = new Set<string>();
  const isDir = (p: string) => dirs.has(p) || Object.keys(files).some((f) => f.startsWith(p + "/"));
  return {
    files,
    dirs,
    ops: {
      exists: (p) => p in files,
      isDirectory: isDir,
      listFiles: (d) => Object.keys(files)
        .filter((f) => f.startsWith(d + "/") && !f.slice(d.length + 1).includes("/"))
        .map((f) => f.slice(d.length + 1)),
      listDirs: (d) => [...new Set(Object.keys(files)
        .filter((f) => f.startsWith(d + "/") && f.slice(d.length + 1).includes("/"))
        .map((f) => f.slice(d.length + 1).split("/")[0]!))],
      read: (p) => {
        const v = files[p];
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      write: (p, c) => { files[p] = c; },
      mkdirp: (p) => { dirs.add(p); },
    },
  };
}

describe("installTopologyDefaults", () => {
  it("在 topology.root 下安装 instance、rig、pod 和 seat 默认值——instance 文件位于根目录顶层", () => {
    const { ops, files } = memFs({
      [join(SPEC, "topology", "instance", "CRAFT.md")]: "instance 方法",
      [join(SPEC, "topology", "rig", "CRAFT.md")]: "rig 方法",
      [join(SPEC, "topology", "rig", "ORCHESTRATION-CRAFT.md")]: "编排方法",
      [join(SPEC, "topology", "pods", "delivery", "CRAFT.md")]: "pod 方法",
      [join(SPEC, "topology", "seats", "orch1-lead", "CRAFT.md")]: "负责人方法",
    });
    const res = installTopologyDefaults({ specDir: SPEC, rigName: "product-team", podIds: ["delivery"], topologyRoot: ROOT, fsOps: ops });
    expect(res.none).toBe(false);
    expect(res.failed).toEqual([]);
    expect(files[join(ROOT, "CRAFT.md")]).toBe("instance 方法");
    expect(files[join(ROOT, "rigs", "product-team", "CRAFT.md")]).toBe("rig 方法");
    expect(files[join(ROOT, "rigs", "product-team", "ORCHESTRATION-CRAFT.md")]).toBe("编排方法");
    expect(files[join(ROOT, "rigs", "product-team", "pods", "delivery", "CRAFT.md")]).toBe("pod 方法");
    expect(files[join(ROOT, "rigs", "product-team", "seats", "orch1-lead", "CRAFT.md")]).toBe("负责人方法");
    expect(res.installed).toHaveLength(5);
  });

  it("仅在缺失时复制：保留现有目标，后续 rig-up 绝不覆盖", () => {
    const earned = "占用团队追加的积累上下文";
    const { ops, files } = memFs({
      [join(SPEC, "topology", "rig", "CRAFT.md")]: "已发布默认值 v2",
      [join(ROOT, "rigs", "product-team", "CRAFT.md")]: earned,
    });
    const res = installTopologyDefaults({ specDir: SPEC, rigName: "product-team", topologyRoot: ROOT, fsOps: ops });
    expect(files[join(ROOT, "rigs", "product-team", "CRAFT.md")]).toBe(earned);
    expect(res.preserved).toEqual([join(ROOT, "rigs", "product-team", "CRAFT.md")]);
    expect(res.installed).toEqual([]);
  });

  it("不含 topology/ 的规范仍会获得引擎管理的 instance、rig 和 pod 目录", () => {
    const { ops, dirs } = memFs({ [join(SPEC, "rig.yaml")]: "..." });
    const res = installTopologyDefaults({ specDir: SPEC, rigName: "x", podIds: ["ops"], topologyRoot: ROOT, fsOps: ops });
    expect(res).toMatchObject({ none: true, installed: [], preserved: [], failed: [] });
    expect(dirs).toEqual(new Set([
      ROOT,
      join(ROOT, "rigs", "x"),
      join(ROOT, "rigs", "x", "pods", "ops"),
    ]));
  });

  it("r2-B2：枚举失败（listFiles 抛错）会被明确记录而不会抛出；其他 section 仍会安装", () => {
    // r2 判别项：listFiles/listDirs 位于 catch 之外，因此某个 section 目录上的 EACCES
    // 会逸出尽力而为契约，把已提交的 materialize 变成 materialize_error。该契约是完全的：
    // 任何形式的文件系统故障都不得从安装器抛出。
    const { ops, files } = memFs({
      [join(SPEC, "topology", "rig", "GOOD.md")]: "正常",
      [join(SPEC, "topology", "seats", "s1", "SEAT.md")]: "seat 正常",
    });
    const failingOps: TopologyDefaultsFsOps = {
      ...ops,
      listFiles: (d) => {
        if (d === join(SPEC, "topology", "rig")) throw new Error("EACCES 枚举失败");
        return ops.listFiles(d);
      },
    };
    const res = installTopologyDefaults({ specDir: SPEC, rigName: "product-team", topologyRoot: ROOT, fsOps: failingOps });
    expect(res.failed).toEqual([{ path: join(SPEC, "topology", "rig"), error: "EACCES 枚举失败" }]);
    // seats section 仍已安装——一个 section 被拒绝绝不会阻碍其余 section。
    expect(files[join(ROOT, "rigs", "product-team", "seats", "s1", "SEAT.md")]).toBe("seat 正常");
  });

  it("r2 残留：初始 topology/ 根探针抛错会被明确记录而不外抛（完整契约没有首行例外）", () => {
    const { ops } = memFs({ [join(SPEC, "topology", "rig", "X.md")]: "x" });
    const failingOps: TopologyDefaultsFsOps = {
      ...ops,
      isDirectory: (p) => {
        if (p === join(SPEC, "topology")) throw new Error("EACCES 根探针失败");
        return ops.isDirectory(p);
      },
    };
    const res = installTopologyDefaults({ specDir: SPEC, rigName: "r", topologyRoot: ROOT, fsOps: failingOps });
    expect(res.failed).toEqual([{ path: join(SPEC, "topology"), error: "EACCES 根探针失败" }]);
    expect(res.none).toBe(false);
  });

  it("r2-B2：seats/ 上的 listDirs 故障会被明确记录，而不抛出", () => {
    const { ops } = memFs({ [join(SPEC, "topology", "seats", "s1", "SEAT.md")]: "x" });
    const failingOps: TopologyDefaultsFsOps = {
      ...ops,
      listDirs: () => { throw new Error("EIO seats 失败"); },
    };
    const res = installTopologyDefaults({ specDir: SPEC, rigName: "r", topologyRoot: ROOT, fsOps: failingOps });
    expect(res.failed).toEqual([{ path: join(SPEC, "topology", "seats"), error: "EIO seats 失败" }]);
  });

  it("逐文件故障会被明确记录而不抛出；其余文件仍会安装", () => {
    const { ops, files } = memFs({
      [join(SPEC, "topology", "rig", "BROKEN.md")]: "x",
      [join(SPEC, "topology", "rig", "GOOD.md")]: "正常",
    });
    const failingOps: TopologyDefaultsFsOps = {
      ...ops,
      write: (p, c) => {
        if (p.endsWith("BROKEN.md")) throw new Error("EACCES：拒绝访问");
        files[p] = c;
      },
    };
    const res = installTopologyDefaults({ specDir: SPEC, rigName: "product-team", topologyRoot: ROOT, fsOps: failingOps });
    expect(res.failed).toEqual([{ path: join(ROOT, "rigs", "product-team", "BROKEN.md"), error: "EACCES：拒绝访问" }]);
    expect(files[join(ROOT, "rigs", "product-team", "GOOD.md")]).toBe("正常");
  });
});

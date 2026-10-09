// OPR.0.4.4.11——MultiRigLauncher（FR-3/4/5 + guard G-2 lock 回归）。
//
// launcher 是一个轻量 walker：这些测试断言注入 leaf 的调用（绝不重新实现）、默认上限下的严格
// 顺序、上限约束、显式包含 `skipped` 的如实部分结果、每个本地 entry 的路由侧 lock 纪律
//（acquire → leaf → finally 中 release，成功与失败均适用），以及通过共享 hosts-registry reader
// 进行的启动前 placement 校验。

import { describe, it, expect } from "vitest";
import { MultiRigLauncher } from "../src/domain/topology/multi-rig-launcher.js";
import type { MultiRigLauncherDeps } from "../src/domain/topology/multi-rig-launcher.js";
import type { TopologyManifest } from "../src/domain/topology/topology-manifest.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "T" },
    { id: "ssh-only", transport: "ssh", target: "x.local" },
  ],
};

function manifest(rigs: TopologyManifest["rigs"], concurrency = 1): TopologyManifest {
  return { rigs, concurrency };
}

interface Trace {
  calls: string[];
  locks: string[];
}

function deps(overrides: Partial<MultiRigLauncherDeps> = {}, trace?: Trace): MultiRigLauncherDeps {
  return {
    tryAcquire: (ref) => {
      trace?.locks.push(`acquire:${ref}`);
      return true;
    },
    release: (ref) => {
      trace?.locks.push(`release:${ref}`);
    },
    launchLocal: async (source) => {
      trace?.calls.push(`local:${source}`);
      return { ok: true };
    },
    launchRemote: async (source, host) => {
      trace?.calls.push(`remote:${source}@${host.id}`);
      return { ok: true };
    },
    loadRegistry: () => ({ ok: true, registry: REGISTRY }),
    ...overrides,
  };
}

describe("MultiRigLauncher——分阶段遍历（FR-3）", () => {
  it("concurrency 1：严格串行——entry 1 的 leaf 返回前，entry 2 不会启动", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const launcher = new MultiRigLauncher(
      deps({
        launchLocal: async (source) => {
          events.push(`start:${source}`);
          if (source === "a") await gate;
          events.push(`end:${source}`);
          return { ok: true };
        },
      }),
    );
    const run = launcher.launch(manifest([{ source: "a" }, { source: "b" }]));
    await Promise.resolve();
    expect(events).toEqual(["start:a"]); // b 尚未启动。
    releaseFirst();
    const result = await run;
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(result.ok).toBe(true);
  });

  it("concurrency 2：任意时刻最多有 2 个 leaf 正在执行；启动遵循 manifest 顺序", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: string[] = [];
    const launcher = new MultiRigLauncher(
      deps({
        launchLocal: async (source) => {
          starts.push(source);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return { ok: true };
        },
      }),
    );
    const result = await launcher.launch(
      manifest([{ source: "a" }, { source: "b" }, { source: "c" }, { source: "d" }], 2),
    );
    expect(result.ok).toBe(true);
    expect(maxInFlight).toBe(2); // 遵循上限，且确实并行。
    expect(starts).toEqual(["a", "b", "c", "d"]); // manifest 启动顺序。
  });

  it("调用 leaf——原样传递 source ref，并逐字包装 leaf 自身错误", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(
      deps(
        {
          launchLocal: async (source) => {
            trace.calls.push(`local:${source}`);
            return source === "bad.yaml" ? { ok: false, error: "Stage RESOLVE_SPEC failed: no such spec" } : { ok: true };
          },
        },
        trace,
      ),
    );
    const result = await launcher.launch(manifest([{ source: "specs/one.yaml" }, { source: "bad.yaml" }]));
    expect(trace.calls).toEqual(["local:specs/one.yaml", "local:bad.yaml"]);
    expect(result.entries[1]).toEqual({
      rigRef: "bad.yaml",
      host: "local",
      status: "failed",
      error: "Stage RESOLVE_SPEC failed: no such spec", // leaf 自身错误——不虚构 taxonomy。
    });
  });
});

describe("MultiRigLauncher——如实部分结果 + 失败即停止（FR-5，架构裁定 5）", () => {
  it("失败会停止遍历：此前 entry 成功、失败 entry 具名、后续 entry 显式 skipped、整体 ok=false", async () => {
    const launcher = new MultiRigLauncher(
      deps({
        launchLocal: async (source) =>
          source === "b" ? { ok: false, error: "boom" } : { ok: true },
      }),
    );
    const result = await launcher.launch(manifest([{ source: "a" }, { source: "b" }, { source: "c" }]));
    expect(result.ok).toBe(false);
    expect(result.entries).toEqual([
      { rigRef: "a", host: "local", status: "ok" },
      { rigRef: "b", host: "local", status: "failed", error: "boom" },
      { rigRef: "c", host: "local", status: "skipped" }, // 必须存在，绝不能缺失。
    ]);
  });

  it("抛错的 leaf 以所抛 message 报告 failed，并仍然停止遍历", async () => {
    const launcher = new MultiRigLauncher(
      deps({
        launchLocal: async () => {
          throw new Error("leaf exploded");
        },
      }),
    );
    const result = await launcher.launch(manifest([{ source: "a" }, { source: "b" }]));
    expect(result.entries[0]).toMatchObject({ status: "failed", error: "leaf exploded" });
    expect(result.entries[1]!.status).toBe("skipped");
  });

  it("每个 entry 的 host 字段格式一致：字面量 'local' 或 placement host id", async () => {
    const launcher = new MultiRigLauncher(deps());
    const result = await launcher.launch(manifest([{ source: "a" }, { source: "b", host: "vps-b" }]));
    expect(result.entries.map((e) => e.host)).toEqual(["local", "vps-b"]);
    expect(result.ok).toBe(true);
  });
});

describe("MultiRigLauncher——每个本地 entry 的路由侧 lock 纪律（guard G-2）", () => {
  it("leaf 前 acquire、finally 中 release——成功与失败均适用（无 lock 泄漏）", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(
      deps(
        {
          launchLocal: async (source) => {
            trace.calls.push(`local:${source}`);
            return source === "b" ? { ok: false, error: "x" } : { ok: true };
          },
        },
        trace,
      ),
    );
    await launcher.launch(manifest([{ source: "a" }, { source: "b" }]));
    expect(trace.locks).toEqual(["acquire:a", "release:a", "acquire:b", "release:b"]);
  });

  it("即使 leaf 抛错也会执行 release", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(
      deps(
        {
          launchLocal: async () => {
            throw new Error("mid-leaf crash");
          },
        },
        trace,
      ),
    );
    await launcher.launch(manifest([{ source: "a" }]));
    expect(trace.locks).toEqual(["acquire:a", "release:a"]);
  });

  it("lock 冲突（独立 up 占用 rig）→ entry 按路由冲突语义失败、遍历停止，且不 release 从未持有的 lock", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(
      deps(
        {
          tryAcquire: (ref) => {
            trace.locks.push(`acquire:${ref}`);
            return ref !== "contested";
          },
        },
        trace,
      ),
    );
    const result = await launcher.launch(manifest([{ source: "contested" }, { source: "b" }]));
    expect(result.ok).toBe(false);
    expect(result.entries[0]!.status).toBe("failed");
    expect(result.entries[0]!.error).toMatch(/此来源已有操作正在进行/);
    expect(result.entries[1]!.status).toBe("skipped");
    expect(trace.locks).toEqual(["acquire:contested"]); // 未取得 lock，因而不 release，也不存在泄漏。
    expect(trace.calls).toEqual([]); // 从未调用 leaf。
  });

  it("F1：lock key === launch ref——resolveLocalRef 输出同时传入 tryAcquire/release 与 leaf；rigRef 保留原始 manifest 字符串", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(
      deps({ resolveLocalRef: (s) => `/manifest/dir/${s.replace(/^\.\//, "")}` }, trace),
    );
    const result = await launcher.launch(manifest([{ source: "./a.yaml" }]));
    expect(trace.locks).toEqual(["acquire:/manifest/dir/a.yaml", "release:/manifest/dir/a.yaml"]);
    expect(trace.calls).toEqual(["local:/manifest/dir/a.yaml"]); // 字符串相同，无 drift。
    expect(result.entries[0]!.rigRef).toBe("./a.yaml"); // 展示保留可移植的 manifest 形式。
  });

  it("F1：并发时，同一文件的 alias entry 会冲突——解析后的 key 是 lock domain", async () => {
    const held = new Set<string>();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const launcher = new MultiRigLauncher({
      resolveLocalRef: (s) => `/mdir/${s.replace(/^\.\//, "")}`,
      tryAcquire: (ref) => {
        if (held.has(ref)) return false;
        held.add(ref);
        return true;
      },
      release: (ref) => held.delete(ref),
      launchLocal: async (ref) => {
        if (ref === "/mdir/a.yaml" && held.size === 1) await gate; // 让 entry 1 保持执行中。
        return { ok: true };
      },
      launchRemote: async () => ({ ok: true }),
      loadRegistry: () => ({ ok: true, registry: REGISTRY }),
    });
    // './a.yaml' 与 'a.yaml' 解析到同一个文件；上限为 2 时，第二项会在第一项执行期间启动，并且
    // 必须遇到 lock 冲突。
    const run = launcher.launch(manifest([{ source: "./a.yaml" }, { source: "a.yaml" }], 2));
    await new Promise((r) => setTimeout(r, 5)); // 让两个 worker 都启动。
    releaseFirst();
    const result = await run;
    expect(result.ok).toBe(false);
    expect(result.entries[1]!.status).toBe("failed");
    expect(result.entries[1]!.error).toMatch(/此来源已有操作正在进行/);
    expect(held.size).toBe(0); // 两种路径均无 lock 泄漏。
  });

  it("远程 entry 不取得本地 lock（远程 daemon 的路由拥有自己的 lock）", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(deps({}, trace));
    await launcher.launch(manifest([{ source: "r", host: "vps-b" }]));
    expect(trace.locks).toEqual([]);
    expect(trace.calls).toEqual(["remote:r@vps-b"]);
  });
});

describe("MultiRigLauncher——启动前 placement 校验（FR-1/FR-4）", () => {
  it("未知 host id 会在任何启动之前令对应 entry 失败：不调用任何 leaf，其余 entry 均 skipped", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(deps({}, trace));
    const result = await launcher.launch(
      manifest([{ source: "a" }, { source: "b", host: "nope" }, { source: "c" }]),
    );
    expect(result.ok).toBe(false);
    expect(trace.calls).toEqual([]); // 未启动任何内容——校验先于遍历。
    expect(result.entries[1]!.status).toBe("failed");
    expect(result.entries[1]!.error).toContain("未知主机 ID 'nope'");
    expect(result.entries[0]!.status).toBe("skipped");
    expect(result.entries[2]!.status).toBe("skipped");
  });

  it("ssh 传输放置在启动前失败，并给出 cannot-carry-remote-up 修复消息", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(deps({}, trace));
    const result = await launcher.launch(manifest([{ source: "a", host: "ssh-only" }]));
    expect(result.entries[0]!.status).toBe("failed");
    expect(result.entries[0]!.error).toContain("主机 'ssh-only' 使用传输方式 'ssh'，无法承载远程工作组启动");
    expect(trace.calls).toEqual([]);
  });

  it("registry 加载失败时，已 placement entry 以 reader 错误失败；不启动任何内容", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(
      deps({ loadRegistry: () => ({ ok: false, error: "host registry not found at /x/hosts.yaml. Create it..." }) }, trace),
    );
    const result = await launcher.launch(manifest([{ source: "a", host: "vps-b" }, { source: "b" }]));
    expect(result.entries[0]!.status).toBe("failed");
    expect(result.entries[0]!.error).toContain("host registry not found");
    expect(result.entries[1]!.status).toBe("skipped");
    expect(trace.calls).toEqual([]);
  });

  it("全本地 manifest 绝不读取 hosts registry", async () => {
    const launcher = new MultiRigLauncher(
      deps({
        loadRegistry: () => {
          throw new Error("registry must not be read for an all-local topology");
        },
      }),
    );
    const result = await launcher.launch(manifest([{ source: "a" }, { source: "b" }]));
    expect(result.ok).toBe(true);
  });
});

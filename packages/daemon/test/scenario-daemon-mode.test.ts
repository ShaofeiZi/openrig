import { describe, it, expect, vi, beforeEach } from "vitest";

// 51-04 第 3 步——runScenarioFile 上选择启用后台服务启动的接缝。容器模式是纯增量的
// 选择启用：调用方未提供 `daemon` spawner 时，主机模式路径与 51-04 前字节完全一致
//（以 { rigBin } 调用 spawnScenarioDaemon）；提供时则使用该覆盖。本套件固定契约的两面——
// 这是保持 51-02 主机模式契约字节不变的防护（无 PM 门禁）。
//
// 单独放在此文件中，避免下方 scenario-daemon 模块 mock 污染其他 scenario-* 套件。

const { spawnScenarioDaemon } = vi.hoisted(() => ({ spawnScenarioDaemon: vi.fn() }));
vi.mock("./helpers/scenario-daemon.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./helpers/scenario-daemon.js")>();
  return { ...actual, spawnScenarioDaemon };
});

import {
  defaultHostDaemon,
  resolveScenarioDaemonSpawner,
  withImageId,
  type ScenarioDaemonSpawner,
  type RunScenarioFileOptions,
} from "./helpers/scenario-pipeline.js";
import type { HermeticScaffold } from "./helpers/hermetic-env.js";
import type { ScenarioDaemon } from "./helpers/scenario-daemon.js";
import type { RunRecord } from "./helpers/scenario-run-record.js";

const FAKE_DAEMON = { port: 1 } as unknown as ScenarioDaemon;
const scaffold = { root: "/scratch", env: {} } as unknown as HermeticScaffold;

beforeEach(() => {
  spawnScenarioDaemon.mockReset();
  spawnScenarioDaemon.mockResolvedValue(FAKE_DAEMON);
});

describe("defaultHostDaemon——保持不变的主机模式启动", () => {
  it("恰好以 { rigBin } 转发到 spawnScenarioDaemon（与第 195 行字节完全一致）", async () => {
    const opts: RunScenarioFileOptions = { rigBin: "/path/to/rig" };
    const daemon = await defaultHostDaemon(scaffold, opts);
    expect(spawnScenarioDaemon).toHaveBeenCalledTimes(1);
    expect(spawnScenarioDaemon).toHaveBeenCalledWith(scaffold, { rigBin: "/path/to/rig" });
    expect(daemon).toBe(FAKE_DAEMON);
  });
});

describe("resolveScenarioDaemonSpawner——增量选择启用", () => {
  it("未提供 `daemon` 覆盖时返回主机模式默认值（防护）", () => {
    expect(resolveScenarioDaemonSpawner({ rigBin: "x" })).toBe(defaultHostDaemon);
  });

  it("提供覆盖时返回调用方的覆盖（选择启用容器模式）", () => {
    const override: ScenarioDaemonSpawner = async () => FAKE_DAEMON;
    expect(resolveScenarioDaemonSpawner({ rigBin: "x", daemon: override })).toBe(override);
  });

  it("仅解析覆盖时不调用主机模式 spawner", () => {
    const override: ScenarioDaemonSpawner = async () => FAKE_DAEMON;
    resolveScenarioDaemonSpawner({ rigBin: "x", daemon: override });
    expect(spawnScenarioDaemon).not.toHaveBeenCalled();
  });
});

describe("withImageId——容器模式结果台账标记（计划 §4）", () => {
  const baseRec: RunRecord = { scenario: "collision", verdict: "PASS" };

  it("容器模式提供 image manifest id 时，为每条追加记录标记该 id", () => {
    const sink = vi.fn();
    const wrapped = withImageId(sink, "sha256:abc");
    wrapped!({ ...baseRec });
    expect(sink).toHaveBeenCalledWith({ scenario: "collision", verdict: "PASS", imageId: "sha256:abc" });
  });

  it("未提供 image id 时原样返回 appendRecord（主机模式字节不变）", () => {
    const sink = vi.fn();
    // 身份：主机模式取回完全相同的 sink 引用——台账行与 51-04 前逐字节一致
    //（不添加 imageId 键）。
    expect(withImageId(sink, undefined)).toBe(sink);
    expect(withImageId(undefined, undefined)).toBeUndefined();
  });

  it("提供 id 但没有 sink 时返回 undefined（无处记录）", () => {
    expect(withImageId(undefined, "sha256:abc")).toBeUndefined();
  });

  it("不修改调用方的记录对象（标记副本）", () => {
    const sink = vi.fn();
    const rec: RunRecord = { scenario: "collision", verdict: "PASS" };
    withImageId(sink, "sha256:abc")!(rec);
    expect(rec).toEqual({ scenario: "collision", verdict: "PASS" });
    expect("imageId" in rec).toBe(false);
  });
});

// OPR.0.4.4.11 FR-6/7——daemon 侧 deploy-identity。
//
// 仓库中提交的模块是诚实的开发 stub：无 stamp 时，stampFields 不向 /healthz 添加任何字段，
// 既不虚构身份，也保留旧版响应体。带 stamp 的形态由 build-package.sh 在打包时写入，且只携带
// 四个精确字段。真正的端到端 stamp 由 VM gate 证明：build:package 后 /healthz 会显示 SHA。

import { describe, it, expect } from "vitest";
import { BUILD_INFO, stampFields } from "../src/build-info.js";

describe("build-info（daemon）", () => {
  it("仓库中提交的模块是诚实的开发 stub：所有身份字段均为 null", () => {
    expect(BUILD_INFO).toEqual({ semver: null, commit: null, dirty: null, builtAt: null });
  });

  it("开发 stub 不向 /healthz 添加任何字段（负向验收：不虚构身份并保留精确旧版响应体）", () => {
    expect(stampFields(BUILD_INFO)).toEqual({});
    expect({ status: "ok", ...stampFields(BUILD_INFO) }).toEqual({ status: "ok" });
  });

  it("带 stamp 的构建只添加 {semver, commit, dirty, builtAt}", () => {
    const stamped = { semver: "0.4.3", commit: "a".repeat(40), dirty: false, builtAt: "2026-07-04T23:00:00Z" };
    expect(stampFields(stamped)).toEqual(stamped);
  });
});

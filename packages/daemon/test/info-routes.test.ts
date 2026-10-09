import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { infoRoutes } from "../src/routes/info.js";
import { getOpenRigInstallRoot } from "../src/domain/cwd-resolution.js";

// OPR.0.3.2.22 缺陷 3——让战术 CLI 感知路径的 daemon-info surface。CLI 使用
// /api/info 判断路径形式的 `zrig up <spec>` 是否落入 zrig 安装目录；若未提供 --cwd，
// 这种情况会在 preflight 阶段触发 getOpenRigInstallCwdError。
describe("GET /api/info", () => {
  it("返回由 cwd-resolution 计算的 daemon installRoot", async () => {
    const app = new Hono();
    app.route("/api/info", infoRoutes());

    const res = await app.request("/api/info");
    expect(res.status).toBe(200);
    const body = await res.json() as { installRoot: string };
    expect(body.installRoot).toBe(getOpenRigInstallRoot());
    expect(typeof body.installRoot).toBe("string");
    expect(body.installRoot.length).toBeGreaterThan(0);
  });
});

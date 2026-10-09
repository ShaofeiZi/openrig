import { Hono } from "hono";
import { getOpenRigInstallRoot } from "../domain/cwd-resolution.js";

// GET /api/info —— 面向 CLI 战术感知路径的 daemon-info 表面
// （OPR.0.3.2.22 Bug 3 的首个消费方：CLI 在路径形态 `zrig up <install-internal-spec>`
// 不带 --cwd 时的默认 cwd 扩展）。
//
// installRoot 是后台服务磁盘上的安装根（其后台服务 package 目录的父目录）。
// CLI 用它来检测一个 spec 路径是否落在 OpenRig 安装内部——也就是在预检时没有
// --cwd 覆盖就会命中 getOpenRigInstallCwdError 的那种情况。
export function infoRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    return c.json({
      installRoot: getOpenRigInstallRoot(),
    });
  });

  return app;
}

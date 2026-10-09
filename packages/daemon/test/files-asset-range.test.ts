// OPR.0.4.4.20 FR-5 + FR-11——/api/files/asset 支持 Range 及 .html ?render=1。
//
// FR-5：iOS Safari 播放媒体需要字节范围支持（206 + Accept-Ranges）；curl 探针的
// 验收条件是“请求 100 字节范围时返回 100 字节，而不是整个文件”。Range 仅在此路由落地。
// FR-11：只有显式选择 ?render=1 时，.html 才以 text/html 提供。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesRoutes } from "../src/routes/files.js";

describe("GET /api/files/asset——Range 与 render 选择加入", () => {
  let root: string;
  let app: Hono;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "asset-range-"));
    mkdirSync(join(root, "media"), { recursive: true });
    // 用 1000 个确定性字节代替视频文件。
    writeFileSync(join(root, "media", "clip.mp4"), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251)));
    writeFileSync(join(root, "media", "mock.html"), "<h1>mock</h1>");
    const allowlist = [{ name: "ws", canonicalPath: realpathSync(root) }];
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("filesAllowlist" as never, allowlist);
      c.set("fileWriteService" as never, null);
      await next();
    });
    app.route("/api/files", filesRoutes());
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const url = (p: string, extra = "") => `/api/files/asset?root=ws&path=${encodeURIComponent(p)}${extra}`;

  it("返回 206、Accept-Ranges 及恰好请求的 100 字节（curl 探针验收条件）", async () => {
    const res = await app.request(url("media/clip.mp4"), { headers: { Range: "bytes=0-99" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Range")).toBe("bytes 0-99/1000");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(100); // 100 字节，而不是整个文件
    expect(body[0]).toBe(0);
    expect(body[99]).toBe(99);
  });

  it("以正确字节切片提供内部范围与开放结束范围", async () => {
    const mid = await app.request(url("media/clip.mp4"), { headers: { Range: "bytes=500-509" } });
    expect(mid.headers.get("Content-Range")).toBe("bytes 500-509/1000");
    const midBody = new Uint8Array(await mid.arrayBuffer());
    expect(midBody[0]).toBe(500 % 251);

    const tail = await app.request(url("media/clip.mp4"), { headers: { Range: "bytes=990-" } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("Content-Range")).toBe("bytes 990-999/1000");
    expect((await tail.arrayBuffer()).byteLength).toBe(10);

    const suffix = await app.request(url("media/clip.mp4"), { headers: { Range: "bytes=-50" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("Content-Range")).toBe("bytes 950-999/1000");
  });

  it("截断过长的结束位置，并以 416 拒绝无法满足的范围", async () => {
    const clamped = await app.request(url("media/clip.mp4"), { headers: { Range: "bytes=900-5000" } });
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get("Content-Range")).toBe("bytes 900-999/1000");

    const past = await app.request(url("media/clip.mp4"), { headers: { Range: "bytes=1000-" } });
    expect(past.status).toBe(416);
    expect(past.headers.get("Content-Range")).toBe("bytes */1000");

    const garbage = await app.request(url("media/clip.mp4"), { headers: { Range: "bytes=zz" } });
    expect(garbage.status).toBe(416);
  });

  it("无 Range 的请求保持 200 整文件响应，并声明 Accept-Ranges", async () => {
    const res = await app.request(url("media/clip.mp4"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
  });

  it(".html 默认保持 text/plain，仅在 ?render=1 时渲染为 text/html", async () => {
    const plain = await app.request(url("media/mock.html"));
    expect(plain.headers.get("Content-Type")).toContain("text/plain");

    const rendered = await app.request(url("media/mock.html", "&render=1"));
    expect(rendered.headers.get("Content-Type")).toContain("text/html");
    expect(await rendered.text()).toBe("<h1>mock</h1>");

    // 选择加入仅限 .html：对非 HTML 资源指定 render=1 不产生变化。
    const video = await app.request(url("media/clip.mp4", "&render=1"));
    expect(video.headers.get("Content-Type")).toBe("video/mp4");
  });
});

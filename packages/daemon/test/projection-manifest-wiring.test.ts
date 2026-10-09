import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// P20 接线固定（失效的失效器/未注入服务类别——由编排命名，沿用 r1 的 P7 固定与 P17
// 未注入解析器先例）。判别能力已有证明（conflict-detector-discrimination 与
// projection-planner 测试），但只有 rigspec-instantiator 在生产中实际向 planProjection
// 注入真实清单查找时才会生效。RigSpecInstantiator 位于深层启动路径（无法单元构造），
// 因此这里在源码层固定启用路径——接线丢失（移除 store 或 lastHashLookup）会在此失败，
// 防止发布静默失效的失效器（查找永远为 null → P17 回退）。
describe("P20 接线固定——rigspec-instantiator 注入真实清单查找", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/domain/rigspec-instantiator.ts", import.meta.url)),
    "utf-8",
  );

  it("在真实数据库 this.db 上构造 ProjectionManifestStore，而非模拟对象", () => {
    expect(src).toMatch(/new ProjectionManifestStore\(this\.db\)/);
  });

  it("planProjection 调用将 lastHashLookup 接到该存储的 lastHash（启用路径）", () => {
    // planProjection({...}) 选项对象携带调用存储的 lastHashLookup——丢失此行会回退为
    // 永久使用 P17 回退路径（失效器失效）。
    expect(src).toMatch(/lastHashLookup:\s*\(targetPath\)\s*=>\s*projectionManifest\.lastHash\(targetPath\)/);
  });
});

// P20 原子 4 PROTECT 接线固定。filterProtectedProjections 已有单元证明
//（projection-protect.test.ts），但只有实例化器实际用它过滤交付文件，并透传操作员的
// force 标志时才会生效。任一接线丢失（不再调用过滤器，或硬编码 force）都会静默退回
// “覆盖操作员编辑”，而警告仍声称“未覆盖”。
describe("P20 原子 4 接线固定——实例化器使用真实 force 标志交付经 PROTECT 过滤的集合", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/domain/rigspec-instantiator.ts", import.meta.url)),
    "utf-8",
  );

  it("通过 filterProtectedProjections 过滤交付的投影文件，并取得 .delivered", () => {
    expect(src).toMatch(/filterProtectedProjections\(/);
    expect(src).toMatch(/\}\s*,?\s*\)\.delivered/);
  });

  it("将操作员 force 标志透传到过滤器（不是硬编码值）", () => {
    // 过滤器受 { force: input.force } 控制——这是节点输入中的 force，由工作组循环从
    // opts?.force 提供。硬编码 force:true 会绕过保护。
    expect(src).toMatch(/\{\s*force:\s*input\.force\s*\}/);
    expect(src).toMatch(/force:\s*opts\?\.force/);
  });
});

// P20 应用时记录的写侧接线固定（review-r1 LOW——与查找侧固定对称）。适配器中已有
// recordProjection 被调用的证明（claude-adapter-record-projection.test.ts），但只有启动流程
// 实际构造存储并传入真实 record() 回调时才会记录。此处丢失会安全降级到 P17（绝不错误
// 覆盖），所以严重度为 LOW——但会静默发生：清单永不填充，所有差异永久保持
// hash_conflict。此测试固定启用路径，使丢失可见而非静默。
describe("P20 应用时记录接线固定——启动流程将 recordProjection 接到真实存储", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/startup.ts", import.meta.url)),
    "utf-8",
  );

  it("在真实数据库上构造 ProjectionManifestStore", () => {
    expect(src).toMatch(/new ProjectionManifestStore\(db\)/);
  });

  it("传入将写入哈希记录到该存储的 recordProjection（启用路径）", () => {
    // recordProjection -> projectionManifestStore.record({ ..., lastHash: hashContent(content), ... })。
    // 丢失接线意味着清单永不填充（静默降级为永久 P17）。
    expect(src).toMatch(/recordProjection:\s*\([^)]*\)\s*=>\s*projectionManifestStore\.record\(/);
    expect(src).toMatch(/lastHash:\s*hashContent\(content\)/);
  });

  it("原子 4b：启动时探测 projectionManifestStore.isReadable()，清单不可读则明确警告（启动启用路径）", () => {
    // 若丢失此接线，整表不可读会让所有投影静默降级为保护状态——操作员不会得知没有任何
    // 投影执行。启动探测与明确警告构成启用路径。
    expect(src).toMatch(/projectionManifestStore\.isReadable\(\)/);
    expect(src).toMatch(/启动时无法读取 projection-manifest/);
  });
});

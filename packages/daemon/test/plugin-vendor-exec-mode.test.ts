// OPR skills-vendoring exec-mode QA blocker——第二跳（review50-r1 对 ac34ed75 的 NOT-CLEAR）。
// PluginVendorService.ensureVendored 通过 text readFile->writeFile 将 asset 从 repo staging 到
// ~/.openrig/plugins，这会丢失 executable mode——这是 adapter preserveMode 修复无法覆盖的上游 hop
//（adapter 会忠实保留已经是 0644 的 staged copy）。这些 REAL-fs pin 覆盖 production 在 startup.ts
// 接入的相同 fsOps shape，并同时覆盖 fresh-write 路径与 content-identical hash-skip 路径
//（此前 staged 的 0644 文件必须在重新 vendor 时修复）。

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { PluginVendorService, type PluginVendorFs } from "../src/domain/plugin-vendor-service.js";

function realVendorFs(): PluginVendorFs {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
    listFiles: (dir) => {
      const r: string[] = [];
      const w = (d: string, pre: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name));
          else r.push(pre ? nodePath.join(pre, e.name) : e.name);
        }
      };
      w(dir, "");
      return r;
    },
    statMode: (p) => fs.statSync(p).mode,
    chmod: (p, m) => fs.chmodSync(p, m),
  };
}

const httpClient = async () => ({ ok: false, status: 404 });
const perm = (p: string) => fs.statSync(p).mode & 0o777;
const sha256 = (content: Buffer | string) =>
  createHash("sha256").update(content).digest("hex");

function materializePreviousRelease(target: string) {
  const fixtureRoot = nodePath.join(
    import.meta.dirname,
    "fixtures",
    "plugin-vendor",
    "openrig-core-835b700fc",
  );
  const paths = [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "hooks/scripts/refocus.cjs",
  ];
  for (const rel of paths) {
    const encoded = fs.readFileSync(
      nodePath.join(fixtureRoot, rel + ".base64"),
      "utf-8",
    );
    const dest = nodePath.join(target, rel);
    fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(encoded.trim(), "base64"));
  }
}

function seedAssets(root: string) {
  const claudeManifest = nodePath.join(root, "openrig-core", ".claude-plugin", "plugin.json");
  const codexManifest = nodePath.join(root, "openrig-core", ".codex-plugin", "plugin.json");
  const skillDir = nodePath.join(root, "openrig-core", "skills", "compaction-restore", "scripts");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(nodePath.dirname(claudeManifest), { recursive: true });
  fs.mkdirSync(nodePath.dirname(codexManifest), { recursive: true });
  const hook = nodePath.join(skillDir, "precompact-hook.mjs");
  const skillMd = nodePath.join(root, "openrig-core", "skills", "compaction-restore", "SKILL.md");
  fs.writeFileSync(claudeManifest, '{"name":"openrig-core","version":"0.1.0"}\n');
  fs.writeFileSync(codexManifest, '{"name":"openrig-core","version":"0.1.0"}\n');
  fs.writeFileSync(hook, "#!/usr/bin/env node\nconsole.log('hook');\n");
  fs.writeFileSync(skillMd, "# compaction-restore\n");
  fs.chmodSync(hook, 0o755);
  fs.chmodSync(skillMd, 0o644);
  return { hookRel: "skills/compaction-restore/scripts/precompact-hook.mjs", skillRel: "skills/compaction-restore/SKILL.md" };
}

describe("PluginVendorService 在 vendor staging 期间保留 executable mode（QA NOT-CLEAR，第 2 跳）", () => {
  it("ensureVendored 将 exec helper 以 0755 staging，并让 non-exec 相邻文件保持 0644", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vendor-execmode-"));
    const assets = nodePath.join(base, "assets", "plugins");
    const rel = seedAssets(assets);
    const userPlugins = nodePath.join(base, "home", "plugins");
    const svc = new PluginVendorService({ vendoredAssetsDir: assets, userPluginsDir: userPlugins, fs: realVendorFs(), httpClient });

    await svc.ensureVendored("openrig-core");

    const outHook = nodePath.join(userPlugins, "openrig-core", rel.hookRel);
    const outSkill = nodePath.join(userPlugins, "openrig-core", rel.skillRel);
    expect(fs.existsSync(outHook)).toBe(true);
    expect(perm(outHook)).toBe(0o755);
    expect(perm(outSkill)).toBe(0o644);
  });

  it("即使 content 逐字相同，重新 vendor 也会修复此前以 0644 staging 的 exec helper（hash-skip 路径）", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vendor-execmode-idem-"));
    const assets = nodePath.join(base, "assets", "plugins");
    const rel = seedAssets(assets);
    const userPlugins = nodePath.join(base, "home", "plugins");
    const svc = new PluginVendorService({ vendoredAssetsDir: assets, userPluginsDir: userPlugins, fs: realVendorFs(), httpClient });

    await svc.ensureVendored("openrig-core");

    // 保持 equal-version installed byte 不变，但准确复现 QA state：逐字相同的 executable helper
    // 携带错误 mode。
    const outHook = nodePath.join(userPlugins, "openrig-core", rel.hookRel);
    fs.chmodSync(outHook, 0o644);
    expect(perm(outHook)).toBe(0o644);

    await svc.ensureVendored("openrig-core");

    // content 未变化（跳过写入），但 mode reconcile 为 source 的 0755。
    expect(perm(outHook)).toBe(0o755);
  });

  it("让 symlinked unversioned global canon 逐字保持不变", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vendor-global-authority-"));
    const assets = nodePath.join(base, "assets", "plugins");
    seedAssets(assets);
    const userPlugins = nodePath.join(base, "home", "plugins");
    const logs: string[] = [];
    const svc = new PluginVendorService({
      vendoredAssetsDir: assets,
      userPluginsDir: userPlugins,
      fs: realVendorFs(),
      httpClient,
      logger: (...args) => logs.push(args.map(String).join(" ")),
    });
    await svc.ensureVendored("openrig-core");

    const canonDir = nodePath.join(base, "shared-canon", "compaction-restore");
    const canonSkill = nodePath.join(canonDir, "SKILL.md");
    const globalRoot = nodePath.join(base, "home", ".agents", "skills");
    fs.mkdirSync(canonDir, { recursive: true });
    fs.mkdirSync(globalRoot, { recursive: true });
    fs.writeFileSync(canonSkill, "# newer shared canon\n");
    fs.symlinkSync(canonDir, nodePath.join(globalRoot, "compaction-restore"));

    svc.ensureSkillGlobally("openrig-core", "compaction-restore", [globalRoot]);

    expect(fs.readFileSync(canonSkill, "utf-8")).toBe("# newer shared canon\n");
    expect(fs.existsSync(nodePath.join(canonDir, ".openrig-vendor-version"))).toBe(false);
    expect(logs.join("\n")).toMatch(/unversioned\/external authority.*保持不变/i);
  });

  it("仅在 source version 更新时更新有真实 marker 的 global projection", async () => {
    const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vendor-global-upgrade-"));
    const assets = nodePath.join(base, "assets", "plugins");
    seedAssets(assets);
    const userPlugins = nodePath.join(base, "home", "plugins");
    const globalRoot = nodePath.join(base, "home", ".agents", "skills");
    const targetDir = nodePath.join(globalRoot, "compaction-restore");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(nodePath.join(targetDir, "SKILL.md"), "# projected 0.0.1\n");
    fs.writeFileSync(nodePath.join(targetDir, ".openrig-vendor-version"), "0.0.1\n");
    const svc = new PluginVendorService({
      vendoredAssetsDir: assets,
      userPluginsDir: userPlugins,
      fs: realVendorFs(),
      httpClient,
    });
    await svc.ensureVendored("openrig-core");

    svc.ensureSkillGlobally("openrig-core", "compaction-restore", [globalRoot]);

    expect(fs.readFileSync(nodePath.join(targetDir, "SKILL.md"), "utf-8")).toBe("# compaction-restore\n");
    expect(fs.readFileSync(nodePath.join(targetDir, ".openrig-vendor-version"), "utf-8")).toBe("0.1.0\n");
  });
});

describe("PluginVendorService release-version 权威性", () => {
  it("bundled release 更新时替换实际 835b700fc refocus hook", async () => {
    const base = fs.mkdtempSync(
      nodePath.join(os.tmpdir(), "vendor-release-upgrade-"),
    );
    const assets = nodePath.resolve(import.meta.dirname, "../assets/plugins");
    const userPlugins = nodePath.join(base, "home", "plugins");
    const installedPlugin = nodePath.join(userPlugins, "openrig-core");
    const hookRel = "hooks/scripts/refocus.cjs";
    materializePreviousRelease(installedPlugin);

    const installedHook = nodePath.join(installedPlugin, hookRel);
    const bundledHook = nodePath.join(assets, "openrig-core", hookRel);
    expect(sha256(fs.readFileSync(installedHook))).toBe(
      "09601be0c704da9bf49eb2c8b174f9caa2983fd11fc5df9333b49ab28d4d3bfc",
    );
    expect(sha256(fs.readFileSync(bundledHook))).toBe(
      "833f09f9026d69ff8e296e357ac91fa0ad4b24922836af19fb26b578758f5598",
    );

    const svc = new PluginVendorService({
      vendoredAssetsDir: assets,
      userPluginsDir: userPlugins,
      fs: realVendorFs(),
      httpClient,
    });
    await svc.ensureVendored("openrig-core");

    expect(sha256(fs.readFileSync(installedHook))).toBe(
      sha256(fs.readFileSync(bundledHook)),
    );
    for (const manifestDir of [".claude-plugin", ".codex-plugin"]) {
      const installed = JSON.parse(
        fs.readFileSync(
          nodePath.join(installedPlugin, manifestDir, "plugin.json"),
          "utf-8",
        ),
      ) as { version: string };
      const bundled = JSON.parse(
        fs.readFileSync(
          nodePath.join(assets, "openrig-core", manifestDir, "plugin.json"),
          "utf-8",
        ),
      ) as { version: string };
      expect(installed.version).toBe(bundled.version);
    }
  });
});

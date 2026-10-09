import nodePath from "node:path";
import { createHash } from "node:crypto";
import { RigSpecCodec } from "./rigspec-codec.js";
import { RigSpecSchema } from "./rigspec-schema.js";
import { assertShippableSubstance, resolveAgentRef, type AgentResolverFsOps } from "./agent-resolver.js";
import { serializePodBundleManifest, type PodBundleManifest, type PodBundleAgentEntry, type PodBundleAgentImportEntry, type BundleProvenance, type BundleCompatibility } from "./bundle-types.js";
import type { RigSpec, StartupBlock } from "./types.js";

export interface PodAssemblerFsOps extends AgentResolverFsOps {
  mkdirp(path: string): void;
  writeFile(path: string, content: string): void;
  copyDir(src: string, dest: string): void;
  listFiles(dirPath: string): string[];
}

export interface PodAssembleOptions {
  rigRoot: string;
  rigSpecPath: string;
  outputDir: string;
  bundleName: string;
  bundleVersion: string;
  /**
   * 可选的 Item-1 provenance 输入。调用方填写已知字段
   * (sourceHost, authorSession, daemonVersion, cliVersion, sourceRigId,
   * sourceRigName、notes）。除非调用方预先设置，否则 assembler 会把根 createdAt 镜像到
   * provenance.createdAt；调用方值优先，以保证测试确定性。缺少该 block 表示不记录 provenance
   *（向后兼容）。
   */
  provenance?: BundleProvenance;
  /**
   * 可选的 Item-2 compatibility 输入。调用方声明最低后台服务与 CLI 版本，以及可选的
   * schema_version 再确认。缺少该 block 表示不记录 compatibility（向后兼容）。
   */
  compatibility?: BundleCompatibility;
}

export interface PodAssembleResult {
  manifest: PodBundleManifest;
  collectedFiles: string[];
}

/**
 * 支持 pod 的 bundle assembler。遍历嵌入 pod member 的 agent_ref，收集 AgentSpec 及其
 * resource/import，并生成已重写 ref 的自包含 bundle。
 */
export class PodBundleAssembler {
  private fs: PodAssemblerFsOps;

  constructor(deps: { fsOps: PodAssemblerFsOps }) {
    this.fs = deps.fsOps;
  }

  /**
   * 根据工作组 spec 组装支持 pod 的 bundle。
   * @param opts 组装选项
   * @returns manifest 与已收集文件列表
   */
  assemble(opts: PodAssembleOptions): PodAssembleResult {
    // 1. 解析并校验工作组 spec。
    if (!this.fs.exists(opts.rigSpecPath)) {
      throw new Error(`未找到工作组 spec：${opts.rigSpecPath}`);
    }
    const rigSpecYaml = this.fs.readFile(opts.rigSpecPath);
    const raw = RigSpecCodec.parse(rigSpecYaml);
    const validation = RigSpecSchema.validate(raw);
    if (!validation.valid) {
      throw new Error(`工作组 spec 无效：${validation.errors.join("；")}`);
    }
    const rigSpec = RigSpecSchema.normalize(raw as Record<string, unknown>);

    // 2. 收集全部文件。
    const collectedFiles: string[] = [];
    const agentEntries: PodBundleAgentEntry[] = [];
    const resolvedAgentPaths = new Set<string>();

    // 2a. 工作组 spec：重写 ref 后再写入，推迟到步骤 4。
    this.fs.mkdirp(opts.outputDir);
    collectedFiles.push("rig.yaml");

    // 跟踪 ref 重写：originalRef -> vendored local: ref。
    const refRewrites = new Map<string, string>();

    // 2b. culture 文件。
    if (rigSpec.cultureFile) {
      this.collectRigFile(rigSpec.cultureFile, opts.rigRoot, opts.outputDir, collectedFiles);
    }

    // 2b2. 文档文件：声明后必需，不同于可选的 culture/startup。
    if (rigSpec.docs) {
      for (const doc of rigSpec.docs) {
        const absPath = nodePath.resolve(opts.rigRoot, doc.path);
        if (!this.fs.exists(absPath)) {
          throw new Error(`未找到已声明的文档文件：${doc.path}（解析为 ${absPath}）。请从 docs 字段移除它，或创建该文件。`);
        }
        this.collectRigFile(doc.path, opts.rigRoot, opts.outputDir, collectedFiles);
      }
    }

    // 2c. 工作组 startup 文件。
    this.collectStartupFiles(rigSpec.startup, opts.rigRoot, opts.outputDir, collectedFiles);

    // 2d. 遍历 pod。
    for (const pod of rigSpec.pods) {
      // Pod startup 文件。
      this.collectStartupFiles(pod.startup, opts.rigRoot, opts.outputDir, collectedFiles);

      for (const member of pod.members) {
        // Member startup 文件。
        this.collectStartupFiles(member.startup, opts.rigRoot, opts.outputDir, collectedFiles);

        // Terminal member 是 bundle 原生 sentinel，不是 vendored 智能体。
        if (member.agentRef === "builtin:terminal") {
          continue;
        }

        // 解析 agent_ref。
        const result = resolveAgentRef(member.agentRef, opts.rigRoot, this.fs);
        if (!result.ok) {
          throw new Error(`无法为 member ${pod.id}.${member.id} 解析 agent_ref "${member.agentRef}"：${result.code === "validation_failed" ? (result as { errors: string[] }).errors.join("；") : (result as { error: string }).error}`);
        }

        // 去重：已经收集时跳过，但仍记录重写关系。
        const agentVendorPath = `agents/${result.resolved.spec.name}`;
        refRewrites.set(member.agentRef, `local:${agentVendorPath}`);

        if (resolvedAgentPaths.has(result.resolved.sourcePath)) continue;
        resolvedAgentPaths.add(result.resolved.sourcePath);
        this.vendorDirectory(result.resolved.sourcePath, nodePath.join(opts.outputDir, agentVendorPath), collectedFiles, agentVendorPath);

        // 收集 import entry：始终记录 provenance，但只 vendor 一次。
        const importEntries: PodBundleAgentImportEntry[] = [];
        for (const imp of result.imports) {
          const importVendorPath = `agents/${imp.spec.name}`;

          // 文件只 vendor 一次（按路径去重），但始终记录 importEntry。
          if (!resolvedAgentPaths.has(imp.sourcePath)) {
            resolvedAgentPaths.add(imp.sourcePath);
            this.vendorDirectory(imp.sourcePath, nodePath.join(opts.outputDir, importVendorPath), collectedFiles, importVendorPath);
          }

          importEntries.push({
            name: imp.spec.name,
            version: imp.spec.version,
            path: importVendorPath,
            originalRef: this.findOriginalImportRef(result.resolved.spec, imp.spec.name, result.imports),
            hash: imp.hash,
          });
        }

        // 将 vendored agent.yaml 中的 import ref 重写为 local: vendored 路径。
        if (result.imports.length > 0) {
          this.rewriteAgentYamlImportRefs(
            nodePath.join(opts.outputDir, agentVendorPath, "agent.yaml"),
            agentVendorPath,
            result.imports.map((imp) => ({
              originalRef: this.findOriginalImportRef(result.resolved.spec, imp.spec.name, result.imports),
              vendoredPath: `agents/${imp.spec.name}`,
            })),
          );
        }

        agentEntries.push({
          name: result.resolved.spec.name,
          version: result.resolved.spec.version,
          path: agentVendorPath,
          originalRef: member.agentRef,
          hash: result.resolved.hash,
          importEntries,
        });
      }
    }

    // 3. 写入重写后的 rig.yaml，其中 agent_ref 已指向 vendored 值。
    const rewrittenRigYaml = this.rewriteRigSpecRefs(rigSpecYaml, refRewrites);
    this.fs.writeFile(nodePath.join(opts.outputDir, "rig.yaml"), rewrittenRigYaml);

    // 4. 构建 manifest。
    const createdAt = new Date().toISOString();
    const manifest: PodBundleManifest = {
      schemaVersion: 2,
      name: opts.bundleName,
      version: opts.bundleVersion,
      createdAt,
      rigSpec: "rig.yaml",
      agents: agentEntries,
      cultureFile: rigSpec.cultureFile,
    };
    if (opts.provenance) {
      manifest.provenance = {
        ...opts.provenance,
        createdAt: opts.provenance.createdAt ?? createdAt,
      };
    }
    if (opts.compatibility) {
      manifest.compatibility = { ...opts.compatibility };
    }

    // 写入 manifest。
    this.fs.writeFile(
      nodePath.join(opts.outputDir, "bundle.yaml"),
      serializePodBundleManifest(manifest),
    );
    collectedFiles.push("bundle.yaml");

    return { manifest, collectedFiles };
  }

  private collectRigFile(relPath: string, rigRoot: string, outputDir: string, collected: string[]): void {
    const absPath = nodePath.resolve(rigRoot, relPath);
    if (!absPath.startsWith(rigRoot)) {
      throw new Error(`检测到路径穿越："${relPath}" 逃逸工作组根目录`);
    }
    if (!this.fs.exists(absPath)) return; // 可选文件可以不存在。
    const content = this.fs.readFile(absPath);
    assertShippableSubstance([{ path: relPath, bytes: content }]);
    this.fs.mkdirp(nodePath.dirname(nodePath.join(outputDir, relPath)));
    this.fs.writeFile(nodePath.join(outputDir, relPath), content);
    collected.push(relPath);
  }

  private collectStartupFiles(startup: StartupBlock | undefined, rigRoot: string, outputDir: string, collected: string[]): void {
    if (!startup) return;
    for (const file of startup.files) {
      this.collectRigFile(file.path, rigRoot, outputDir, collected);
    }
  }

  private vendorDirectory(srcDir: string, destDir: string, collected: string[], relPrefix: string): void {
    const files = this.fs.listFiles(srcDir);
    const sources = files.map((file) => ({
      file,
      content: this.fs.readFile(nodePath.join(srcDir, file)),
    }));
    assertShippableSubstance(sources.map(({ file, content }) => ({
      path: nodePath.join(relPrefix, file),
      bytes: content,
    })));
    this.fs.mkdirp(destDir);
    for (const { file, content } of sources) {
      const destPath = nodePath.join(destDir, file);
      this.fs.mkdirp(nodePath.dirname(destPath));
      this.fs.writeFile(destPath, content);
      collected.push(nodePath.join(relPrefix, file).replace(/\\/g, "/"));
    }
  }

  private findOriginalImportRef(spec: import("./types.js").AgentSpec, importName: string, resolvedImports: import("./agent-resolver.js").ResolvedAgentSpec[]): string {
    // 按已解析 spec 名称匹配原始 import ref。
    for (let i = 0; i < spec.imports.length; i++) {
      if (i < resolvedImports.length && resolvedImports[i]!.spec.name === importName) {
        return spec.imports[i]!.ref;
      }
    }
    return `unknown:${importName}`;
  }

  private rewriteAgentYamlImportRefs(
    vendoredAgentYamlPath: string,
    agentVendorDir: string,
    importMappings: Array<{ originalRef: string; vendoredPath: string }>,
  ): void {
    if (!this.fs.exists(vendoredAgentYamlPath)) return;
    const content = this.fs.readFile(vendoredAgentYamlPath);
    let rewritten = content;
    for (const mapping of importMappings) {
      // 计算从智能体目录到 vendored import 目录的相对路径。
      const rel = nodePath.relative(agentVendorDir, mapping.vendoredPath).replace(/\\/g, "/");
      const localRef = `local:${rel}`;
      // 用 vendored local: ref 替换原始 ref。
      rewritten = rewritten.replace(mapping.originalRef, localRef);
    }
    this.fs.writeFile(vendoredAgentYamlPath, rewritten);
  }

  private rewriteRigSpecRefs(originalYaml: string, refRewrites: Map<string, string>): string {
    // 解析为原始对象，重写 agent_ref 值后重新序列化。
    const raw = RigSpecCodec.parse(originalYaml) as Record<string, unknown>;
    const pods = raw["pods"] as Array<Record<string, unknown>> | undefined;
    if (pods) {
      for (const pod of pods) {
        const members = pod["members"] as Array<Record<string, unknown>> | undefined;
        if (members) {
          for (const member of members) {
            const originalRef = member["agent_ref"] as string;
            const rewritten = refRewrites.get(originalRef);
            if (rewritten) {
              member["agent_ref"] = rewritten;
            }
          }
        }
      }
    }
    return RigSpecCodec.serialize(RigSpecSchema.normalize(raw as Record<string, unknown>));
  }
}

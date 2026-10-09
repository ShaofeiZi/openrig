import { LegacyRigSpecCodec as LegacyCodec } from "./rigspec-codec.js";
import { LegacyRigSpecSchema as LegacySchema } from "./rigspec-schema.js";
import { RigSpecCodec as PodCodec } from "./rigspec-codec.js";
import { RigSpecSchema as PodSchema } from "./rigspec-schema.js";
import { yamlTextHasTopLevelRigsList } from "./topology/topology-manifest.js";

export type SourceKind = "rig_spec" | "rig_bundle" | "rig_name" | "topology";

export interface RouteResult {
  sourceKind: SourceKind;
  sourceRef: string;
}

interface RouterFsOps {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  readHead: (path: string, bytes: number) => Buffer;
}

/** Gzip 魔数：0x1f 0x8b。 */
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

function podSchemaOwnsDiagnostics(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  if ("pods" in obj) return true;
  // 只有 document 声明 legacy marker 时，diagnostic 才由 Legacy 负责；否则 canonical root 中的
  // typo 不能静默切换 schema。
  return !("nodes" in obj || "schema_version" in obj);
}

/**
 * 根据文件扩展名或基于内容的自动检测，将 source path 路由到正确的 bootstrap pipeline。
 */
export class UpCommandRouter {
  private fs: RouterFsOps;

  constructor(deps: { fsOps: RouterFsOps }) {
    this.fs = deps.fsOps;
  }

  route(sourceRef: string): RouteResult {
    // Rig name 检测：不含 '/' 且无文件扩展名 → 视为现有 rig name。OPR.0.4.4.11（guard G-1）：
    // `.rigtopology` 在此视为文件扩展名，因此裸 `factory.rigtopology` 会进入 topology routing。
    // 不含斜杠且无扩展名的 source 逐字保留 rig_name 优先级（FR-2 negative AC；`./file` 是显式
    // 路径逃生口）。
    if (!sourceRef.includes("/") && !sourceRef.match(/\.(ya?ml|rigbundle|rigtopology)$/i)) {
      return { sourceKind: "rig_name", sourceRef };
    }

    if (!this.fs.exists(sourceRef)) {
      throw new Error(`未找到 source：${sourceRef}。请提供 .yaml 工作组 spec 路径或要恢复的工作组名称。`);
    }

    // 按扩展名路由
    const ext = sourceRef.split(".").pop()?.toLowerCase();
    if (ext === "rigbundle") {
      return { sourceKind: "rig_bundle", sourceRef };
    }
    // OPR.0.4.4.11（arch ruling 1）：声明的扩展名具有约束力——`.rigtopology` 文件即使 manifest
    // validation 失败，也会在下游以 topology 身份报错；绝不会落入 rig-spec parsing。
    if (ext === "rigtopology") {
      return { sourceKind: "topology", sourceRef };
    }
    if (ext === "yaml" || ext === "yml") {
      // OPR.0.4.4.11（guard yaml fold）：根据 FR-1 detection contract，顶层带 `rigs:` LIST 的 YAML
      // document 是 topology——在 rig-spec validation 前 sniff，使 `factory.yaml` topology 不会因
      // 令人困惑的 rig-spec error 而失败。rig spec 绝不携带顶层 `rigs:`，因此 sniff 无歧义。
      // 无法读取的文件进入现有 rig-spec 路径，由该路径原样报告。
      try {
        if (yamlTextHasTopLevelRigsList(this.fs.readFile(sourceRef))) {
          return { sourceKind: "topology", sourceRef };
        }
      } catch {
        // 继续向下——error surface 由 validateYamlAsRigSpec 负责
      }
      // 执行语义 validation——拒绝 bundle.yaml、package.yaml 等。
      return this.validateYamlAsRigSpec(sourceRef);
    }

    // 无扩展名文件的自动检测回退
    return this.autoDetect(sourceRef);
  }

  private validateYamlAsRigSpec(sourceRef: string): RouteResult {
    try {
      const content = this.fs.readFile(sourceRef);

      // 首先尝试 canonical pod-aware schema
      const podRaw = PodCodec.parse(content);
      const podValidation = PodSchema.validate(podRaw);
      if (podValidation.valid) {
        return { sourceKind: "rig_spec", sourceRef };
      }
      // S7：pod-shaped document 即使无效，也由 pod-aware validator 负责。若落入 legacy，会把精确
      // topology diagnostic 替换为无关的“nodes is required”错误。
      if (podSchemaOwnsDiagnostics(podRaw)) {
        throw new Error(`Source 是 YAML，但不是有效的工作组 spec：${podValidation.errors[0] ?? "未知错误"}`);
      }

      // 回退到 legacy schema
      const raw = LegacyCodec.parse(content);
      const validation = LegacySchema.validate(raw);
      if (validation.valid) {
        return { sourceKind: "rig_spec", sourceRef };
      }

      // 不是有效 rig spec——提供可操作的错误信息
      const obj = raw as Record<string, unknown> | null;
      if (obj && typeof obj === "object") {
        if ("packages" in obj && ("integrity" in obj || "rig_spec" in obj)) {
          throw new Error(`Source 看起来是 bundle manifest（bundle.yaml），而非工作组 spec。请改用 'zrig bundle install'。`);
        }
        if ("exports" in obj || "compatibility" in obj) {
          throw new Error(`Source 看起来是 package manifest（package.yaml），而非工作组 spec。请改用 'zrig package install'。`);
        }
      }

      throw new Error(`Source 是 YAML，但不是有效的工作组 spec：${validation.errors[0] ?? "未知错误"}`);
    } catch (err) {
      if ((err as Error).message.includes("Source 看起来") || (err as Error).message.includes("Source 是 YAML")) {
        throw err;
      }
      throw new Error(`无法将 '${sourceRef}' 解析为工作组 spec：${(err as Error).message}`);
    }
  }

  private autoDetect(sourceRef: string): RouteResult {
    // 检查 gzip（binary bundle）
    try {
      const head = this.fs.readHead(sourceRef, 2);
      if (head.length >= 2 && head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1]) {
        return { sourceKind: "rig_bundle", sourceRef };
      }
    } catch {
      // 无法读取 head——尝试按 text 处理
    }

    // 尝试按 YAML 解析并验证为 rig spec（先 canonical，再 legacy）
    try {
      const content = this.fs.readFile(sourceRef);

      // OPR.0.4.4.11（guard G-1）：无扩展名 PATH-form source 增加顶层 `rigs:` list sniff →
      // topology。仅 path 形式可到达这里——不含斜杠且无扩展名的 source 已在上方分类为 rig_name，
      // 绝不会到达 autoDetect（已记录的优先级）。
      if (yamlTextHasTopLevelRigsList(content)) {
        return { sourceKind: "topology", sourceRef };
      }

      // 尝试 canonical pod-aware
      const podRaw = PodCodec.parse(content);
      const podVal = PodSchema.validate(podRaw);
      if (podVal.valid) {
        return { sourceKind: "rig_spec", sourceRef };
      }
      if (podSchemaOwnsDiagnostics(podRaw)) {
        throw new Error(`Source 是 YAML，但不是有效的工作组 spec：${podVal.errors[0] ?? "未知错误"}。工作组 spec 请使用 .yaml，bundle 请使用 .rigbundle。`);
      }

      // 尝试 legacy
      const raw = LegacyCodec.parse(content);
      const validation = LegacySchema.validate(raw);
      if (validation.valid) {
        return { sourceKind: "rig_spec", sourceRef };
      }

      // YAML 有效但不是 rig spec——提供可操作的提示
      const obj = raw as Record<string, unknown> | null;
      if (obj && typeof obj === "object") {
        if ("packages" in obj && "integrity" in obj) {
          throw new Error(`Source 看起来是 bundle manifest（bundle.yaml），而非工作组 spec。请改用 'zrig bundle install'。`);
        }
        if ("exports" in obj || "compatibility" in obj) {
          throw new Error(`Source 看起来是 package manifest（package.yaml），而非工作组 spec。请改用 'zrig package install'。`);
        }
      }

      throw new Error(`Source 是 YAML，但不是有效的工作组 spec：${validation.errors[0] ?? "未知错误"}。工作组 spec 请使用 .yaml，bundle 请使用 .rigbundle。`);
    } catch (err) {
      if ((err as Error).message.includes("Source 看起来") || (err as Error).message.includes("Source 是 YAML")) {
        throw err; // 重新抛出可操作的提示
      }
      throw new Error(`无法确定 '${sourceRef}' 的 source 类型。工作组 spec 请使用 .yaml，bundle 请使用 .rigbundle。`);
    }
  }
}

/**
 * Bundle workflow_specs 路由器（第 6 项 / slice-05 检查点 7.3e 步骤 2）。
 *
 * 纯函数。将 bundle 清单 workflow_specs[] 块声明的工作流规格 YAML 文件，从 bundle
 * 解包树复制到操作员工作流规格库。不依赖后台服务，可通过注入 FsOps 完整单元测试。
 *
 * 镜像 bundle-skills-router 模式（文件路径、保留目录布局的单文件复制、去除前导前缀）。
 * 按 orch 对第 6 项完整性批准的候选 A：workflow_specs 是 v0 第三种跨原语类别
 *（位于 skills + plugins 之后）。来源原语已可从 main 到达
 *（WorkflowSpecCache + workflow-runtime + scanner）。
 *
 * 安全性（已记录的 feedback_pre_existing_trust_boundary_reuse_canonical_helper 补充）：
 * 双侧包含检查——声明的来源路径必须位于 bundleRoot 内；去除前导 "workflows/" 后解析的
 * 目标路径必须位于 targetWorkflowSpecsDir 内。去除前导前缀可能提升中间的 ../ 段，
 * 使其绕过来源检查却越出目标边界。
 *
 * 如实限定范围：来源文件缺失时在结果中呈现警告，而不是抛错，使安装生命周期可用现有内容
 * 继续执行。与 bundle-skills-router 一致。
 *
 * /install 处理器集成在检查点 7.3e 步骤 3 落地。
 */

import nodePath from "node:path";

/** 文件系统注入点——真实实现封装 node:fs，测试使用内存实现替代。 */
export interface WorkflowSpecsRouterFsOps {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  mkdirp: (path: string) => void;
}

/** routeWorkflowSpecs 的输入。 */
export interface RouteWorkflowSpecsInput {
  /** bundle 解包根目录的绝对路径（unpack 创建的临时目录）。 */
  bundleRoot: string;
  /** 清单 workflow_specs[] 块中声明的相对 workflow_spec 路径。 */
  declaredWorkflowSpecs: string[];
  /**
   * spec-library-workflow-scanner 实际读取的操作员工作流规格库绝对路径。
   * **调用方契约**：必须严格等于
   *   `nodePath.join(ContextPackSettingsStore.resolveConfig().workspaceSpecsRoot, "workflows")`
   * ——即 `scanWorkflowSpecFolder` 在
   * `packages/daemon/src/domain/spec-library-workflow-scanner.ts:320-342` 中发现的目录，
   * 并由 `packages/daemon/src/startup.ts:903-916` 的 `deps.workflowsFolderDir` 暴露。
   * SettingsStore 是实际操作员主机路径的唯一权威来源；此处不得写死默认值——设置分层
   *（env > config > workspace-default）会改变解析根，因此在注释中重复任何字面默认值
   * 都可能产生漂移。写入其他位置虽会静默成功，却无法被实时工作流扫描器发现，
   * 最终让操作员走入死路。/install 集成辅助函数（检查点 7.3e 步骤 3）在调用
   * routeWorkflowSpecs 前，必须通过上述 SettingsStore 调用解析此路径。
   */
  targetWorkflowSpecsDir: string;
}

/** 一个已路由 workflow_spec（或一条拒绝记录）。 */
export interface RoutedWorkflowSpecRecord {
  /** 来自 manifest.workflow_specs[] 的声明路径。 */
  declaredPath: string;
  /** "routed" 表示复制成功且扫描器可见。
   * "missing" 表示 bundle 中缺少来源（如实跳过）。
   * "unsafe" 表示来源越出 bundleRoot，或声明路径使用扫描器会忽略的非 YAML 后缀
   *（结构上对操作员不可见）。
   * "conflict" 表示 basename 与更早路由条目冲突——只写入首个声明路径；后续项标记为
   * 冲突，使 routedCount 在扫描器可见边界保持真实（镜像本 slice 更广泛的三段式冲突错误姿态）。 */
  status: "routed" | "missing" | "unsafe" | "conflict";
  /** 路由成功时 workflow_spec 在目标库中的绝对落盘路径。 */
  installedAt?: string;
  /** 人类可读详情（调用方三段式错误形状的输入）。 */
  detail?: string;
}

/** 聚合路由结果。 */
export interface RouteWorkflowSpecsResult {
  records: RoutedWorkflowSpecRecord[];
  routedCount: number;
  rejectedCount: number;
}

/**
 * 将每个已声明 workflow_spec 从 bundle 树路由到操作员工作流规格库。逐条目安全要求：
 * 同时对来源路径（bundleRoot 下）与目标路径（去除前导前缀后的 targetWorkflowSpecsDir 下）
 * 执行包含检查，落实已记录的信任边界双侧防护经验。调用方使用这里返回的 records
 * 写入安装审计记录。
 */
export function routeWorkflowSpecs(
  input: RouteWorkflowSpecsInput,
  fs: WorkflowSpecsRouterFsOps,
): RouteWorkflowSpecsResult {
  const records: RoutedWorkflowSpecRecord[] = [];
  const bundleRootResolved = nodePath.resolve(input.bundleRoot);
  const targetRootResolved = nodePath.resolve(input.targetWorkflowSpecsDir);
  fs.mkdirp(input.targetWorkflowSpecsDir);
  // 追踪已路由 basename，使 basename 扁平化后的重名冲突表现为 conflict 记录，
  // 而不是静默覆盖并产生错误 routedCount（d81456dc 上已记录的 B1 guard 捕获）。
  const routedBasenames = new Set<string>();

  for (const declared of input.declaredWorkflowSpecs) {
    // 扫描器可见性预过滤：spec-library-workflow-scanner 只读取顶层 .yaml/.yml 文件
    //（spec-library-workflow-scanner.ts:366 + 390-397）。非 YAML 声明虽会路由到磁盘，
    // 却无法通过 Library UI 被操作员看到，属于假阳性类别。在此拒绝，确保 routedCount
    // 在扫描器可见边界保持真实。
    if (!/\.ya?ml$/i.test(declared)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `workflow_spec '${declared}' 不是 .yaml/.yml 文件；扫描器会忽略非 YAML 后缀`,
      });
      continue;
    }
    const sourceAbs = nodePath.resolve(input.bundleRoot, declared);
    // 对来源做纵深路径包含防护（镜像 skills router 模式）。清单校验器已经通过
    // isRelativeSafePath 拒绝不安全路径，但此处仍重新检查，以防输入绕过上游校验。
    if (sourceAbs !== bundleRootResolved && !sourceAbs.startsWith(bundleRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `workflow_spec 路径 '${declared}' 越出 bundle 工作区，已拒绝`,
      });
      continue;
    }
    if (!fs.exists(sourceAbs)) {
      records.push({
        declaredPath: declared,
        status: "missing",
        detail: `bundle 中不存在 workflow_spec 来源 '${declared}'，已跳过`,
      });
      continue;
    }
    // 目标 = targetWorkflowSpecsDir 下的顶层 basename。
    //
    // 扫描器可达性契约：spec-library-workflow-scanner 仅通过 readdirSync(folder) + isFile()
    // 读取顶层 YAML 文件（见 spec-library-workflow-scanner.ts:382-397），不会递归。
    // 子目录内的嵌套 YAML 对扫描器和 Library UI 不可见。工作流规格必须落在
    // <workspace.specs_root>/workflows 顶层才对操作员可见。只取 basename 的目标计算强制保证
    // 这一点；若保留 bundle 目录布局，会把规格静默路由到未扫描位置。
    //
    // 附带收益：basename 不可能越出 targetWorkflowSpecsDir
    //（nodePath.basename(any-path) 是不含分隔符的叶子名），因此 skills router 上已记录的
    // “去除前缀后目标侧逃逸”风险（595e9550 B1 修复）在此结构上不可能发生。
    //
    // 写入前捕获 basename 冲突：见 routedBasenames 去重集合及下方冲突分支。两个声明路径
    // 共享同一文件名时首个优先（status=routed），后续项标为 status=conflict，使 routedCount
    // 在扫描器可见边界保持真实（镜像本 slice 的三段式冲突错误姿态）。扫描器完全忽略
    // 非 .yaml/.yml 条目，因此非 YAML 后缀已预过滤为 status=unsafe。
    const basename = nodePath.basename(declared);
    const targetAbs = nodePath.resolve(input.targetWorkflowSpecsDir, basename);
    // 健全性检查（防御性）：basename 在结构上安全，但 resolve 理论上可能对 "" 为空操作；
    // 保留该检查，预期始终通过。
    if (targetAbs !== targetRootResolved && !targetAbs.startsWith(targetRootResolved + nodePath.sep)) {
      records.push({
        declaredPath: declared,
        status: "unsafe",
        detail: `workflow_spec '${declared}' 的目标路径越出目标工作流规格库，已拒绝`,
      });
      continue;
    }
    // basename 冲突检测：两个共享 basename 的声明路径在扁平化后会指向同一文件。只写入首个，
    // 后续项以 conflict 记录呈现，使 routedCount 等于扫描器可见规格数量
    //（d81456dc 上已记录的 B1 guard 捕获）。操作员可通过重命名声明路径或整理 bundle 清单修复。
    if (routedBasenames.has(basename)) {
      records.push({
        declaredPath: declared,
        status: "conflict",
        detail: `workflow_spec basename '${basename}' 与更早的声明路径冲突；仅路由首项（basename 扁平化冲突）`,
      });
      continue;
    }
    const content = fs.readFile(sourceAbs);
    fs.writeFile(targetAbs, content);
    routedBasenames.add(basename);
    records.push({
      declaredPath: declared,
      status: "routed",
      installedAt: targetAbs,
    });
  }

  const routedCount = records.filter((r) => r.status === "routed").length;
  const rejectedCount = records.length - routedCount;
  return { records, routedCount, rejectedCount };
}

#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCHEMA = "openrig-telemetry-state-migration/v1";
const rig = process.env.OPENRIG_RIG_BIN || "rig";
const HELP = `用法：migrate-telemetry-state-0.5.9.mjs [选项]

不提供阶段标志时运行只读计划。
此工具仅执行用户智能体选择的一项有界操作，不会安装、启动、停止或以其他方式编排
OpenRig 升级。

选项：
  --home <path>               要检查或迁移的 OpenRig 主目录
  --apply-state               准备 canonical 根目录、恢复材料和兼容配置
  --verify                    激活后验证真实成对的 canonical 遥测
  --apply-library             通过非破坏性且经过验证的库复制完成收尾
  --rollback <preimage>       仅撤销此辅助工具负责的准备/收尾效果
  --preimage <path>           apply-state 创建的受保护恢复材料
  --verification <path>       收尾程序要求的成功验证回执
  -h, --help                  显示此帮助且不检查实例
`;
const DEFAULT_SYSTEM_WORLD = `schema: openrig.system-world/v0alpha1
id: openrig-default
version: "0.5.9"
context:
  - ref: onboarding-width
  - ref: world-public
    profiles:
      claude: guided
      codex: codex-coverage
skills: []
`;

function parseArguments(argv) {
  const valueOptions = new Set(["--home", "--preimage", "--verification", "--rollback"]);
  const phaseOptions = new Set(["--apply-state", "--verify", "--apply-library"]);
  const values = new Map();
  const phases = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (phaseOptions.has(option)) {
      phases.add(option);
      continue;
    }
    if (valueOptions.has(option)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { issue: issue("value_required", null, `${option} 需要一个值`, { option }) };
      }
      values.set(option, value);
      index += 1;
      continue;
    }
    return { issue: issue("unknown_option", null, "请运行 --help 查看支持的选项", { option }) };
  }
  return { values, phases };
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function emit(report, status = 0) {
  const stream = status === 0 ? process.stdout : process.stderr;
  stream.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(status);
}

function issue(code, pathValue, next, extra = {}) {
  return { code, ...(pathValue ? { path: pathValue } : {}), ...extra, next };
}

function readJson(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function lstatOrNull(pathValue) {
  try {
    return fs.lstatSync(pathValue);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function treeSnapshot(root, ignored = new Set()) {
  const rootStat = lstatOrNull(root);
  if (!rootStat) return { digest: null, rootIdentity: null, entries: [] };
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`库根目录不是真实目录：${root}`);
  }
  const rows = [];
  const entries = [];
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (ignored.has(relative)) continue;
      const current = fs.lstatSync(absolute);
      const mode = current.mode & 0o777;
      if (current.isSymbolicLink()) {
        const linkTargetBase64 = fs.readlinkSync(absolute, { encoding: "buffer" }).toString("base64");
        const afterRead = fs.lstatSync(absolute);
        if (!afterRead.isSymbolicLink()
          || afterRead.dev !== current.dev
          || afterRead.ino !== current.ino
          || (afterRead.mode & 0o777) !== mode) {
          throw new Error(`盘点期间 symlink 发生变化：${absolute}`);
        }
        entries.push({
          path: relative,
          type: "symlink",
          mode,
          linkTargetBase64,
          identity: { dev: String(current.dev), ino: String(current.ino) },
        });
        rows.push(`${relative}\0symlink\0${mode}\0${linkTargetBase64}`);
      } else if (current.isDirectory()) {
        entries.push({ path: relative, type: "directory", mode });
        rows.push(`${relative}\0directory\0${mode}`);
        visit(absolute, relative);
      } else if (current.isFile()) {
        const digest = sha256(fs.readFileSync(absolute));
        entries.push({ path: relative, type: "file", mode, sha256: digest });
        // 逐字节保留引入 symlink 支持前的常规文件序列化格式。
        rows.push(`${relative}\0${mode}\0${digest}`);
      } else {
        throw new Error(`库中存在不受支持的条目：${absolute}`);
      }
    }
  };
  visit(root);
  return {
    digest: sha256(rows.join("\n")),
    rootIdentity: { dev: String(rootStat.dev), ino: String(rootStat.ino) },
    entries,
  };
}

function treeDigest(root, ignored = new Set()) {
  return treeSnapshot(root, ignored).digest;
}

function librarySourceDrift(sourcePath, message) {
  const drift = new Error(`context 库在盘点后发生变化：${sourcePath}：${message}`);
  drift.migrationIssueCode = "library_source_drift";
  drift.migrationPath = sourcePath;
  return drift;
}

function assertTreeSnapshot(root, expected, ignored = new Set()) {
  let current;
  try {
    current = treeSnapshot(root, ignored);
  } catch (error) {
    throw librarySourceDrift(root, error.message);
  }
  const rootIdentityChanged = expected.rootIdentity !== null && (
    current.rootIdentity?.dev !== expected.rootIdentity.dev
    || current.rootIdentity?.ino !== expected.rootIdentity.ino
  );
  if (current.digest !== expected.digest || rootIdentityChanged) {
    throw librarySourceDrift(root, "tree digest or root identity no longer matches");
  }
  const currentLinks = new Map(current.entries
    .filter((entry) => entry.type === "symlink")
    .map((entry) => [entry.path, entry]));
  for (const link of expected.entries.filter((entry) => entry.type === "symlink")) {
    const observed = currentLinks.get(link.path);
    if (!observed
      || observed.mode !== link.mode
      || observed.linkTargetBase64 !== link.linkTargetBase64
      || observed.identity.dev !== link.identity.dev
      || observed.identity.ino !== link.identity.ino) {
      throw librarySourceDrift(path.join(root, link.path), "symlink payload, type, mode, or inode no longer matches");
    }
  }
  return current;
}

function regularFileSnapshot(filePath) {
  const before = lstatOrNull(filePath);
  if (!before) throw new Error(`托管文件缺失：${filePath}`);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`托管路径不是常规文件：${filePath}`);
  }
  const mode = before.mode & 0o777;
  const digest = sha256(fs.readFileSync(filePath));
  const after = fs.lstatSync(filePath);
  if (!after.isFile()
    || after.isSymbolicLink()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || (after.mode & 0o777) !== mode) {
    throw new Error(`托管文件在盘点期间发生变化：${filePath}`);
  }
  return {
    type: "file",
    mode,
    sha256: digest,
    identity: { dev: String(before.dev), ino: String(before.ino) },
  };
}

function assertRegularFileSnapshot(filePath, expected) {
  if (!expected) throw new Error(`托管文件没有已记录身份：${filePath}`);
  const current = regularFileSnapshot(filePath);
  if (current.type !== expected.type
    || current.mode !== expected.mode
    || current.sha256 !== expected.sha256
    || current.identity.dev !== expected.identity?.dev
    || current.identity.ino !== expected.identity?.ino) {
    throw new Error(`托管文件身份不再匹配：${filePath}`);
  }
  return current;
}

function readLibraryConfig(home, issues) {
  const configPath = path.join(home, "config.json");
  const configExists = fs.existsSync(configPath);
  const config = configExists ? readJson(configPath) : {};
  if (!config) {
    issues.push(issue("config_invalid", configPath, "迁移 context 库前请修复 config.json"));
    return null;
  }
  const context = config.context === undefined ? {} : config.context;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    issues.push(issue("config_invalid", configPath, "迁移 context 库前请将 config.context 改为对象"));
    return null;
  }
  if (context.packsRoot !== undefined && (typeof context.packsRoot !== "string" || context.packsRoot.length === 0)) {
    issues.push(issue("config_invalid", configPath, "迁移前请将 context.packsRoot 设为非空路径，或将其移除"));
    return null;
  }
  if (context.root !== undefined && (typeof context.root !== "string" || context.root.length === 0)) {
    issues.push(issue("config_invalid", configPath, "迁移前请将 context.root 设为非空路径，或将其移除"));
    return null;
  }
  const defaultLegacyRoot = path.join(home, "context-packs");
  const configuredLegacyRoot = context.packsRoot
    ? path.resolve(context.packsRoot)
    : context.root
    ? path.resolve(context.root)
    : defaultLegacyRoot;
  if (context.packsRoot !== undefined && context.root !== undefined
    && path.resolve(context.packsRoot) !== path.resolve(context.root)) {
    issues.push(issue("context_root_conflict", configPath, "请选择激活期间必须保持权威的唯一 context 库", {
      legacyRoot: path.resolve(context.packsRoot),
      configuredRoot: path.resolve(context.root),
    }));
    return null;
  }
  const targetRoot = configuredLegacyRoot === defaultLegacyRoot ? path.join(home, "context") : configuredLegacyRoot;
  const activationContext = { ...context, root: configuredLegacyRoot };
  delete activationContext.packsRoot;
  const finalContext = { ...context, root: targetRoot };
  delete finalContext.packsRoot;
  if (context.systemWorld === undefined) {
    activationContext.systemWorld = path.join(home, "context", "system", "system-world.yaml");
    if (targetRoot !== path.join(home, "context")) finalContext.systemWorld = activationContext.systemWorld;
  }
  const activationConfig = { ...config, context: activationContext };
  const finalConfig = { ...config, context: finalContext };
  return {
    configPath,
    configExists,
    originalConfig: configExists ? fs.readFileSync(configPath) : null,
    activationConfig: Buffer.from(`${JSON.stringify(activationConfig, null, 2)}\n`),
    finalConfig: Buffer.from(`${JSON.stringify(finalConfig, null, 2)}\n`),
    sourceRoot: configuredLegacyRoot,
    targetRoot,
  };
}

function systemWorldPlan(home, issues) {
  const directory = path.join(home, "context", "system");
  const filePath = path.join(directory, "system-world.yaml");
  const file = lstatOrNull(filePath);
  if (file && (!file.isFile() || file.isSymbolicLink())) {
    issues.push(issue("system_world_conflict", filePath, "请保留不透明条目，并在准备前选择预期的 System World"));
    return null;
  }
  if (file && sha256(fs.readFileSync(filePath)) !== sha256(DEFAULT_SYSTEM_WORLD)) {
    issues.push(issue("system_world_conflict", filePath, "请保留操作员所有的 System World，并在准备前显式协调"));
    return null;
  }
  const directoryStat = lstatOrNull(directory);
  if (directoryStat && (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())) {
    issues.push(issue("system_world_conflict", directory, "请保留不透明条目，并在准备前选择预期的 System World 目录"));
    return null;
  }
  if (directoryStat) {
    const foreign = fs.readdirSync(directory).filter((name) => name !== "system-world.yaml");
    if (foreign.length > 0) {
      issues.push(issue("system_world_conflict", path.join(directory, foreign[0]), "请保留附加内容，并在准备前协调预留的 System World 目录"));
      return null;
    }
  }
  return { directory, filePath, existed: Boolean(file) };
}

function inventoryClaudeSeats(issues) {
  const result = spawnSync(rig, ["ps", "--nodes", "-A", "--json", "--full"], { encoding: "utf8" });
  if (result.status !== 0) {
    issues.push(issue(
      "inventory_unavailable",
      null,
      `请运行 ${rig} ps --nodes -A --json --full 并恢复后台服务盘点，然后重试`,
      { diagnostic: result.stderr?.trim() || result.stdout?.trim() || "命令未产生诊断信息" },
    ));
    return [];
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const entries = Array.isArray(parsed) ? parsed : parsed.entries;
    if (!Array.isArray(entries) || parsed.truncated === true) throw new Error("盘点缺失或已截断");
    return entries.filter((entry) => entry.runtime === "claude-code" && entry.sessionStatus === "running");
  } catch (error) {
    issues.push(issue("inventory_unavailable", null, "重试前请获取一份完整且未截断的节点盘点", {
      diagnostic: error.message,
    }));
    return [];
  }
}

function targetIssue(target) {
  let cursor = target;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (fs.existsSync(cursor) && !fs.statSync(cursor).isDirectory()) {
    return issue("unwriteable_target", target, "应用前请替换非目录祖先，或选择正确的 OpenRig 主目录", {
      blockingPath: cursor,
    });
  }
  if (!fs.existsSync(target)) return null;
  if (!fs.statSync(target).isDirectory()) {
    return issue("unwriteable_target", target, "请保留非目录目标，并在应用前修复路径");
  }
  return null;
}

function scanLegacy(directory, kind, destination, issues, managedEmptyDirectories = [], allowedDirectories = []) {
  if (!fs.existsSync(directory)) return [];
  if (!fs.statSync(directory).isDirectory()) {
    issues.push(issue("foreign_file", directory, "请保留此路径，并找出真实的旧版遥测目录"));
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const source = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".json.tmp")) continue;
    if (kind === "context" && entry.name === "system" && entry.isDirectory()) {
      if (fs.readdirSync(source).length === 0) {
        managedEmptyDirectories.push(source);
        continue;
      }
      if (allowedDirectories.includes(source)) continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      issues.push(issue("foreign_file", source, "应用此有界迁移前，请分类或归档非遥测条目"));
      continue;
    }
    const parsed = readJson(source);
    const identity = kind === "context" ? parsed?.session_name : parsed?.seatSession;
    const timestamp = kind === "context" ? parsed?.sampled_at : parsed?.asOf;
    if (typeof identity !== "string" || identity.length === 0
      || typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
      issues.push(issue("malformed_sidecar", source, `应用前请修复或归档格式错误的 ${kind} sidecar`));
      continue;
    }
    files.push({
      kind,
      source,
      destination: path.join(destination, entry.name),
      sessionName: identity,
      bytes: fs.readFileSync(source),
      mode: fs.statSync(source).mode & 0o777,
    });
  }
  return files;
}

function buildPlan(home) {
  const issues = [];
  const managedEmptyDirectories = [];
  const roots = {
    legacyContext: path.join(home, "context"),
    legacyProvider: path.join(home, "provider-usage"),
    contextUsage: path.join(home, "state", "context-usage"),
    providerUsage: path.join(home, "state", "provider-usage"),
  };
  for (const target of [roots.contextUsage, roots.providerUsage]) {
    const found = targetIssue(target);
    if (found) issues.push(found);
  }
  const systemWorld = systemWorldPlan(home, issues);
  const allowedContextDirectories = systemWorld && lstatOrNull(systemWorld.directory)
    ? [systemWorld.directory]
    : [];
  const telemetry = [
    ...scanLegacy(roots.legacyContext, "context", roots.contextUsage, issues, managedEmptyDirectories, allowedContextDirectories),
    ...scanLegacy(roots.legacyProvider, "provider", roots.providerUsage, issues),
  ];
  inventoryClaudeSeats(issues);
  const library = readLibraryConfig(home, issues);
  if (library && fs.existsSync(library.sourceRoot) && !fs.statSync(library.sourceRoot).isDirectory()) {
    issues.push(issue("library_source_invalid", library.sourceRoot, "请保留此路径，并找出真实的旧版 context 库"));
  }
  return { roots, telemetry, library, systemWorld, managedEmptyDirectories, issues };
}

function publicPlan(home, plan) {
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    home,
    phase: "plan",
    applied: false,
    complete: plan.issues.length === 0,
    roots: plan.roots,
    actions: [
      { decision: "prepare-directory", path: plan.roots.contextUsage },
      { decision: "prepare-directory", path: plan.roots.providerUsage },
      ...plan.telemetry.map((item) => ({ decision: "preserve-legacy-fallback", kind: item.kind, path: item.source, sha256: sha256(item.bytes) })),
      ...(plan.systemWorld ? [{ decision: plan.systemWorld.existed ? "preserve-system-world" : "install-system-world", path: plan.systemWorld.filePath }] : []),
      ...(plan.library ? [{
        decision: "pin-library-during-activation",
        from: plan.library.sourceRoot,
        to: plan.library.sourceRoot,
        finalizer: plan.library.sourceRoot === plan.library.targetRoot ? "verify-in-place" : "copy-after-verification",
        finalizerTarget: plan.library.targetRoot,
      }] : []),
    ],
    issues: plan.issues,
    next: plan.issues.length === 0
      ? "用户智能体批准此安装专用计划后，请选择未使用的 --preimage 路径并运行 --apply-state"
      : "请解决所有问题；计划模式未做任何更改",
  };
}

function atomicWrite(destination, bytes, mode) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.openrig-telemetry-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function storePreimage(preimage, records) {
  if (fs.existsSync(preimage)) {
    emit({ schema: SCHEMA, phase: "apply-state", ok: false, issues: [issue(
      "preimage_exists",
      preimage,
      "请选择新的 preimage 路径；此辅助工具绝不会覆盖已有路径",
    )] }, 1);
  }
  fs.mkdirSync(preimage, { recursive: true });
  const files = records.map((record, index) => {
    const digest = sha256(record.bytes);
    const storedAs = path.join("files", `${String(index).padStart(4, "0")}-${digest}`);
    const storedPath = path.join(preimage, storedAs);
    fs.mkdirSync(path.dirname(storedPath), { recursive: true });
    fs.writeFileSync(storedPath, record.bytes, { flag: "wx", mode: record.mode });
    return { ...record.public, storedAs, sha256: digest, mode: record.mode };
  });
  return files;
}

function loadManifest(preimage, home, phase) {
  const manifestPath = path.join(preimage, "manifest.json");
  const manifest = readJson(manifestPath);
  if (manifest?.schema !== SCHEMA || manifest.home !== home || !Array.isArray(manifest.files)) {
    emit({ schema: SCHEMA, phase, ok: false, issues: [issue(
      "preimage_manifest_mismatch",
      manifestPath,
      "请使用此主目录的 apply-state 回执所生成的准确 preimage",
    )] }, 1);
  }
  return manifest;
}

function validatePreimage(preimage, manifest) {
  const issues = [];
  for (const file of manifest.files) {
    const storedPath = path.resolve(preimage, file.storedAs);
    if (!storedPath.startsWith(`${path.resolve(preimage)}${path.sep}`) || !fs.existsSync(storedPath)
      || sha256(fs.readFileSync(storedPath)) !== file.sha256) {
      issues.push(issue("preimage_mismatch", storedPath, "回滚前请恢复逐字节匹配的 preimage", {
        originalPath: file.originalPath,
      }));
    }
  }
  return issues;
}

function contextFilenameForSession(home, preimage, manifest, sessionName) {
  const preservedSource = manifest.files.find((file) => {
    if (file.kind !== "context-source") return false;
    return readJson(path.join(preimage, file.storedAs))?.session_name === sessionName;
  });
  if (preservedSource) return path.basename(preservedSource.originalPath);

  const directory = path.join(home, "state", "context-usage");
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return null;
  return fs.readdirSync(directory, { withFileTypes: true })
    .find((entry) => entry.isFile() && readJson(path.join(directory, entry.name))?.session_name === sessionName)?.name ?? null;
}

function applyState(home, preimage) {
  if (!preimage) {
    emit({ schema: SCHEMA, phase: "apply-state", ok: false, issues: [issue(
      "preimage_required",
      null,
      "请通过 --preimage 指定受保护备份根目录下的新路径",
    )] }, 1);
  }
  const plan = buildPlan(home);
  if (plan.issues.length > 0) emit({ ...publicPlan(home, plan), phase: "apply-state", ok: false }, 1);

  const records = [
    ...plan.telemetry.map((item) => ({
      bytes: item.bytes,
      mode: item.mode,
      public: { kind: `${item.kind}-source`, originalPath: item.source },
    })),
    ...(plan.library?.originalConfig ? [{
      bytes: plan.library.originalConfig,
      mode: fs.statSync(plan.library.configPath).mode & 0o777,
      public: { kind: "config", originalPath: plan.library.configPath },
    }] : []),
  ];
  const files = storePreimage(preimage, records);
  const manifestPath = path.join(preimage, "manifest.json");
  const prepared = {
    schema: SCHEMA,
    home,
    status: "prepared",
    createdAt: new Date().toISOString(),
    files,
    stateDirectories: [plan.roots.contextUsage, plan.roots.providerUsage].map((directory) => ({
      path: directory,
      existed: Boolean(lstatOrNull(directory)),
    })),
    managedEmptyDirectories: plan.managedEmptyDirectories,
    systemWorld: plan.systemWorld ? {
      path: plan.systemWorld.filePath,
      existed: plan.systemWorld.existed,
      sha256: sha256(DEFAULT_SYSTEM_WORLD),
      mode: 0o644,
    } : null,
    libraryPlan: plan.library ? {
      configPath: plan.library.configPath,
      configExisted: plan.library.configExists,
      sourceRoot: plan.library.sourceRoot,
      targetRoot: plan.library.targetRoot,
      activationConfigBase64: plan.library.activationConfig.toString("base64"),
      activationConfigSha256: sha256(plan.library.activationConfig),
      finalConfigBase64: plan.library.finalConfig.toString("base64"),
      finalConfigSha256: sha256(plan.library.finalConfig),
    } : null,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(prepared, null, 2)}\n`, { flag: "wx" });

  try {
    fs.mkdirSync(plan.roots.contextUsage, { recursive: true });
    fs.mkdirSync(plan.roots.providerUsage, { recursive: true });
    if (plan.systemWorld && !plan.systemWorld.existed) {
      atomicWrite(plan.systemWorld.filePath, Buffer.from(DEFAULT_SYSTEM_WORLD), 0o644);
    }
    if (plan.library) {
      const configMode = plan.library.configExists ? fs.statSync(plan.library.configPath).mode & 0o777 : 0o600;
      if (plan.library.configExists && sha256(fs.readFileSync(plan.library.configPath)) !== sha256(plan.library.originalConfig)) {
        throw new Error(`配置在准备期间发生变化：${plan.library.configPath}`);
      }
      atomicWrite(plan.library.configPath, plan.library.activationConfig, configMode);
    }
  } catch (error) {
    emit({
      schema: SCHEMA,
      phase: "apply-state",
      ok: false,
      applied: false,
      complete: false,
      preimage,
      issues: [issue("unwriteable_target", null, "请检查已保留的 preimage 和部分目标状态；解决问题后再重试", {
        diagnostic: error.message,
      })],
    }, 1);
  }

  const appliedAt = new Date().toISOString();
  atomicWrite(manifestPath, Buffer.from(`${JSON.stringify({ ...prepared, status: "applied", appliedAt }, null, 2)}\n`), 0o600);
  emit({
    schema: SCHEMA,
    generatedAt: appliedAt,
    home,
    phase: "apply-state",
    applied: true,
    complete: false,
    preimage,
    preparedDirectories: [plan.roots.contextUsage, plan.roots.providerUsage],
    preservedLegacy: plan.telemetry.map((item) => item.source),
    configuredContextRoot: plan.library?.sourceRoot ?? null,
    issues: [],
    next: "用户智能体现在可以激活准确的目标 runtime；证明仅写 canonical、读取时 canonical 优先且 legacy 回退，然后使用此 --preimage 运行 --verify",
  });
}

function sampleTime(filePath, identityKey, timeKey, expectedSession, issues) {
  const parsed = readJson(filePath);
  if (!parsed) {
    if (fs.existsSync(filePath)) issues.push(issue("malformed_sidecar", filePath, "请修复格式错误的 sidecar 并获取新样本"));
    return null;
  }
  if (parsed[identityKey] !== expectedSession || typeof parsed[timeKey] !== "string") {
    issues.push(issue("malformed_sidecar", filePath, "请修复 sidecar 身份或时间戳并获取新样本"));
    return null;
  }
  const time = Date.parse(parsed[timeKey]);
  if (Number.isNaN(time)) {
    issues.push(issue("malformed_sidecar", filePath, "请修复 sidecar 时间戳并获取新样本"));
    return null;
  }
  return time;
}

function managedSystemWorldState(home, manifest, issues, expectedArtifact = undefined) {
  if (manifest.systemWorld) {
    const expected = manifest.systemWorld;
    const filePath = expected.path;
    const current = lstatOrNull(filePath);
    if (!current?.isFile() || current.isSymbolicLink()
      || sha256(fs.readFileSync(filePath)) !== expected.sha256
      || (current.mode & 0o777) !== expected.mode) {
      issues.push(issue("system_world_conflict", filePath, "请保留已变化的 System World，并在继续前恢复准确的已准备产物"));
      return { directories: [path.dirname(filePath)], artifact: null };
    }
    const foreign = fs.readdirSync(path.dirname(filePath)).filter((name) => name !== path.basename(filePath));
    if (foreign.length > 0) {
      issues.push(issue("system_world_conflict", path.join(path.dirname(filePath), foreign[0]), "请保留附加内容，并在继续前协调预留的 System World 目录"));
    }
    const artifact = { path: filePath, sha256: expected.sha256, mode: expected.mode };
    if (expectedArtifact !== undefined && (
      expectedArtifact === null
      || expectedArtifact.path !== artifact.path
      || expectedArtifact.sha256 !== artifact.sha256
      || expectedArtifact.mode !== artifact.mode
    )) {
      issues.push(issue("destination_drift", filePath, "请保留已变化的 System World，并从准确迁移状态重新运行验证"));
    }
    return { directories: [path.dirname(filePath)], artifact };
  }
  const directory = path.join(home, "context", "system");
  const systemWorldPath = path.join(directory, "system-world.yaml");
  const directories = manifest.managedEmptyDirectories ?? [];
  if (!Array.isArray(directories) || directories.length > 1 || directories.some((entry) => entry !== directory)) {
    issues.push(issue("preimage_manifest_mismatch", directory, "请使用此辅助工具生成的准确 preimage"));
    return { directories: [], artifact: null };
  }
  if (directories.length === 0) {
    if (expectedArtifact !== undefined && expectedArtifact !== null) {
      issues.push(issue("verification_receipt_invalid", systemWorldPath, "请针对这一准确的主目录和 preimage 重新运行 --verify"));
    }
    return { directories, artifact: null };
  }
  if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
    issues.push(issue("system_world_conflict", directory, "重试前请启动准确的目标后台服务，并确保只有其 canonical 默认 System World"));
    return { directories, artifact: null };
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== "system-world.yaml" || !entries[0].isFile() || entries[0].isSymbolicLink()) {
    issues.push(issue("system_world_conflict", directory, "请保留不同或额外的 System World 内容，并手动协调"));
    return { directories, artifact: null };
  }
  const bytes = fs.readFileSync(systemWorldPath);
  const artifact = {
    path: systemWorldPath,
    sha256: sha256(bytes),
    mode: fs.statSync(systemWorldPath).mode & 0o777,
  };
  if (artifact.sha256 !== sha256(DEFAULT_SYSTEM_WORLD)) {
    issues.push(issue("system_world_conflict", systemWorldPath, "请保留不同的 System World，并手动协调"));
  }
  if (expectedArtifact !== undefined && (
    expectedArtifact === null
    || expectedArtifact.path !== artifact.path
    || expectedArtifact.sha256 !== artifact.sha256
    || expectedArtifact.mode !== artifact.mode
  )) {
    issues.push(issue("destination_drift", systemWorldPath, "请保留已变化的 System World，并从准确迁移状态重新运行验证"));
  }
  return { directories, artifact };
}

function telemetryPair(home, preimage, manifest, sessionName, issues) {
  const filename = contextFilenameForSession(home, preimage, manifest, sessionName);
  if (!filename) return null;
  const contextPath = path.join(home, "state", "context-usage", filename);
  const providerPath = path.join(home, "state", "provider-usage", filename);
  const contextAt = sampleTime(contextPath, "session_name", "sampled_at", sessionName, issues);
  const providerAt = sampleTime(providerPath, "seatSession", "asOf", sessionName, issues);
  if (contextAt === null || providerAt === null) return null;
  return {
    sessionName,
    contextPath,
    providerPath,
    contextAt,
    providerAt,
    sampledAt: new Date(Math.min(contextAt, providerAt)).toISOString(),
  };
}

function legacyTails(manifest, telemetry, appliedAt, issues) {
  const originalByPath = new Map(manifest.files
    .filter((file) => file.kind === "context-source" || file.kind === "provider-source")
    .map((file) => [file.originalPath, file]));
  const currentPaths = new Set(telemetry.map((file) => file.source));
  for (const original of originalByPath.values()) {
    if (!currentPaths.has(original.originalPath)) {
      issues.push(issue("legacy_source_drift", original.originalPath, "请恢复绑定 preimage 的 legacy sidecar 并重新运行验证"));
    }
  }
  const tails = [];
  for (const file of telemetry) {
    const original = originalByPath.get(file.source);
    const currentSha256 = sha256(file.bytes);
    if (original && original.sha256 === currentSha256 && original.mode === file.mode) continue;
    const current = readJson(file.source);
    const timeKey = file.kind === "context" ? "sampled_at" : "asOf";
    const identityKey = file.kind === "context" ? "session_name" : "seatSession";
    const observedAt = Date.parse(current?.[timeKey]);
    if (Number.isNaN(observedAt) || observedAt <= appliedAt) {
      issues.push(issue("legacy_source_drift", file.source, "请保留已变化的 legacy sidecar，并从新的 preimage 重新运行迁移"));
      continue;
    }
    tails.push({
      kind: file.kind,
      originalPath: file.source,
      sessionName: current[identityKey],
      observedAt: current[timeKey],
      sha256: currentSha256,
      mode: file.mode,
    });
  }
  return tails;
}

function requireTailConvergence(tails, samples, issues) {
  for (const tail of tails) {
    const sample = samples.get(tail.sessionName);
    const observedAt = Date.parse(tail.observedAt);
    if (!sample || sample.contextAt <= observedAt || sample.providerAt <= observedAt) {
      issues.push(issue("legacy_writer_active", tail.originalPath, "请在两个新状态根目录为指定席位获取更新样本；若 legacy 写入继续，请替换该进程", {
        sessionName: tail.sessionName,
        observedAt: tail.observedAt,
        ...(sample ? {
          contextObservedAt: new Date(sample.contextAt).toISOString(),
          providerObservedAt: new Date(sample.providerAt).toISOString(),
        } : {}),
      }));
    }
  }
}

function verify(home, preimage) {
  if (!preimage) {
    emit({ schema: SCHEMA, phase: "verify", ok: false, issues: [issue("preimage_required", null, "请传入 apply-state 使用的 --preimage 路径")] }, 1);
  }
  const manifest = loadManifest(preimage, home, "verify");
  const issues = validatePreimage(preimage, manifest);
  if (manifest.status !== "applied" || typeof manifest.appliedAt !== "string") {
    issues.push(issue("preimage_manifest_mismatch", path.join(preimage, "manifest.json"), "请使用已完成 apply-state 的 preimage"));
  }
  const appliedAt = Date.parse(manifest.appliedAt);
  const systemWorld = managedSystemWorldState(home, manifest, issues);
  const legacyTelemetry = [
    ...scanLegacy(path.join(home, "context"), "context", path.join(home, "state", "context-usage"), issues, [], systemWorld.directories),
    ...scanLegacy(path.join(home, "provider-usage"), "provider", path.join(home, "state", "provider-usage"), issues),
  ];
  const tails = legacyTails(manifest, legacyTelemetry, appliedAt, issues);
  const seats = inventoryClaudeSeats(issues);
  const sampleSessions = new Set(tails.map((tail) => tail.sessionName));
  for (const seat of seats) {
    const sessionName = seat.canonicalSessionName || seat.sessionName;
    if (typeof sessionName === "string") sampleSessions.add(sessionName);
  }
  const samples = new Map();
  const freshSamples = [];
  for (const sessionName of sampleSessions) {
    const sample = telemetryPair(home, preimage, manifest, sessionName, issues);
    if (sample) {
      samples.set(sessionName, sample);
      if (sample.contextAt > appliedAt && sample.providerAt > appliedAt) {
        const { contextAt: _contextAt, providerAt: _providerAt, ...publicSample } = sample;
        freshSamples.push(publicSample);
      }
    }
  }
  requireTailConvergence(tails, samples, issues);
  if (freshSamples.length === 0) {
    issues.push(issue("missing_fresh_sample", path.join(home, "state", "context-usage"), "宣布迁移完成前，请在两个新遥测根目录获取一份 apply 后的 Claude 样本"));
  }

  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    home,
    phase: "verify",
    verified: issues.length === 0,
    complete: issues.length === 0,
    preimage,
    preimageManifestSha256: sha256(fs.readFileSync(path.join(preimage, "manifest.json"))),
    managedSystemWorld: systemWorld.artifact,
    freshSamples,
    legacyTails: tails,
    issues,
    next: issues.length === 0 ? "canonical 遥测采用情况已验证" : "请解决列出的未完成状态并重新运行 verify",
  };
  emit(report, issues.length === 0 ? 0 : 1);
}

function verificationReceipt(home, preimage, verificationPath) {
  if (!verificationPath) return { issue: issue("verification_receipt_required", null, "请捕获成功的 --verify JSON 回执，并通过 --verification 传入") };
  const receipt = readJson(verificationPath);
  const manifestPath = path.join(preimage, "manifest.json");
  const manifest = readJson(manifestPath);
  const expectsSystemWorld = Boolean(manifest?.systemWorld)
    || (Array.isArray(manifest?.managedEmptyDirectories) && manifest.managedEmptyDirectories.length === 1);
  const valid = receipt?.schema === SCHEMA
    && receipt.phase === "verify"
    && receipt.verified === true
    && receipt.complete === true
    && typeof receipt.home === "string"
    && typeof receipt.preimage === "string"
    && path.resolve(receipt.home) === home
    && path.resolve(receipt.preimage) === path.resolve(preimage)
    && receipt.preimageManifestSha256 === sha256(fs.readFileSync(manifestPath))
    && Array.isArray(receipt.legacyTails)
    && receipt.legacyTails.every((tail) => (tail?.kind === "context" || tail?.kind === "provider")
      && typeof tail.originalPath === "string"
      && typeof tail.sessionName === "string"
      && typeof tail.observedAt === "string"
      && typeof tail.sha256 === "string"
      && Number.isInteger(tail.mode))
    && (expectsSystemWorld
      ? receipt.managedSystemWorld && typeof receipt.managedSystemWorld.path === "string"
        && typeof receipt.managedSystemWorld.sha256 === "string"
        && Number.isInteger(receipt.managedSystemWorld.mode)
      : receipt.managedSystemWorld === null);
  return valid
    ? { receipt }
    : { issue: issue("verification_receipt_invalid", verificationPath, "请针对这一准确的主目录和 preimage 重新运行 --verify，捕获其 JSON 后重试") };
}

function validateLegacySources(preimage, manifest, root, kind, issues, allowedEntries = [], verifiedTails = []) {
  const files = manifest.files.filter((file) => file.kind === kind && path.dirname(file.originalPath) === root);
  const telemetryKind = kind === "context-source" ? "context" : "provider";
  const tails = verifiedTails.filter((tail) => tail.kind === telemetryKind && path.dirname(tail.originalPath) === root);
  const expectedByPath = new Map(files.map((file) => [file.originalPath, file]));
  for (const tail of tails) expectedByPath.set(tail.originalPath, tail);
  const allowed = new Set([...expectedByPath.keys()].map((filePath) => path.basename(filePath)));
  const allowedEntrySet = new Set(allowedEntries);
  if (!fs.existsSync(root)) {
    for (const file of expectedByPath.values()) {
      issues.push(issue("legacy_source_drift", file.originalPath, "迁移库前请恢复经过验证的 legacy 遥测源"));
    }
    return [...expectedByPath.values()];
  }
  if (!fs.statSync(root).isDirectory()) {
    issues.push(issue("legacy_source_drift", root, "迁移库前请恢复经过验证的 legacy 遥测目录"));
    return files;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json.tmp")) continue;
    if (allowedEntrySet.has(path.join(root, entry.name))) continue;
    if (!entry.isFile() || !allowed.has(entry.name)) {
      issues.push(issue("legacy_source_drift", path.join(root, entry.name), "收尾前请分类新的 legacy 根条目，并获取新验证回执"));
    }
  }
  for (const file of expectedByPath.values()) {
    const sourceKind = fs.existsSync(file.originalPath) ? fs.lstatSync(file.originalPath) : null;
    if (!sourceKind?.isFile() || sourceKind.isSymbolicLink()
      || sha256(fs.readFileSync(file.originalPath)) !== file.sha256
      || (sourceKind.mode & 0o777) !== file.mode) {
      issues.push(issue("legacy_source_drift", file.originalPath, "请重新运行 apply-state 和 verify；某个 legacy 遥测源在回执生成后发生变化"));
    }
  }
  return [...expectedByPath.values()];
}

function legacySourceDrift(sourcePath, error) {
  const drift = new Error(`legacy 源在验证后发生变化：${sourcePath}：${error.message}`);
  drift.migrationIssueCode = "legacy_source_drift";
  drift.migrationPath = sourcePath;
  return drift;
}

function assertLegacySourcesStillVerified(home, preimage, manifest, allowedContextEntries, verifiedTails) {
  const issues = [];
  validateLegacySources(
    preimage,
    manifest,
    path.join(home, "context"),
    "context-source",
    issues,
    allowedContextEntries,
    verifiedTails,
  );
  validateLegacySources(
    preimage,
    manifest,
    path.join(home, "provider-usage"),
    "provider-source",
    issues,
    [],
    verifiedTails,
  );
  if (issues.length > 0) {
    const first = issues[0];
    throw legacySourceDrift(first.path ?? home, new Error(first.code));
  }
}

function decodePlannedBytes(encoded, digest) {
  const bytes = Buffer.from(encoded ?? "", "base64");
  if (!encoded || sha256(bytes) !== digest) throw new Error("manifest 规划的字节与其摘要不匹配");
  return bytes;
}

function entrySnapshot(entryPath) {
  const stat = fs.lstatSync(entryPath);
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) {
    return {
      type: "symlink",
      mode,
      linkTargetBase64: fs.readlinkSync(entryPath, { encoding: "buffer" }).toString("base64"),
      identity: { dev: String(stat.dev), ino: String(stat.ino) },
    };
  }
  if (stat.isFile()) {
    return {
      type: "file",
      mode,
      sha256: sha256(fs.readFileSync(entryPath)),
      identity: { dev: String(stat.dev), ino: String(stat.ino) },
    };
  }
  if (stat.isDirectory()) {
    return { type: "directory", mode, tree: treeSnapshot(entryPath) };
  }
  throw new Error(`库中存在不受支持的条目：${entryPath}`);
}

function copyEntryOpaque(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (stat.isFile()) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, stat.mode & 0o777);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { mode: stat.mode & 0o777 });
    for (const name of fs.readdirSync(source).sort((left, right) => left.localeCompare(right))) {
      copyEntryOpaque(path.join(source, name), path.join(destination, name));
    }
    fs.chmodSync(destination, stat.mode & 0o777);
    return;
  }
  throw new Error(`库中存在不受支持的条目：${source}`);
}

function semanticEntrySnapshot(snapshot) {
  if (snapshot.type !== "directory") {
    const { identity: _identity, ...semantic } = snapshot;
    return semantic;
  }
  return {
    type: snapshot.type,
    mode: snapshot.mode,
    digest: snapshot.tree.digest,
    entries: snapshot.tree.entries.map((entry) => {
      const { identity: _identity, ...semantic } = entry;
      return semantic;
    }),
  };
}

function assertEntrySnapshot(entryPath, expected, requireIdentity = true) {
  const current = entrySnapshot(entryPath);
  if (JSON.stringify(semanticEntrySnapshot(current)) !== JSON.stringify(semanticEntrySnapshot(expected))) {
    throw new Error(`条目的字节、类型、链接 payload 或 mode 发生变化：${entryPath}`);
  }
  if (!requireIdentity) return current;
  if (expected.type === "directory") {
    if (current.tree.rootIdentity?.dev !== expected.tree.rootIdentity?.dev
      || current.tree.rootIdentity?.ino !== expected.tree.rootIdentity?.ino) {
      throw new Error(`条目身份发生变化：${entryPath}`);
    }
    const currentLinks = new Map(current.tree.entries.filter((entry) => entry.type === "symlink").map((entry) => [entry.path, entry.identity]));
    for (const link of expected.tree.entries.filter((entry) => entry.type === "symlink")) {
      const identity = currentLinks.get(link.path);
      if (identity?.dev !== link.identity?.dev || identity?.ino !== link.identity?.ino) {
        throw new Error(`symlink 身份发生变化：${path.join(entryPath, link.path)}`);
      }
    }
  } else if (current.identity.dev !== expected.identity.dev || current.identity.ino !== expected.identity.ino) {
    throw new Error(`条目身份发生变化：${entryPath}`);
  }
  return current;
}

function libraryPlanFromManifest(manifest, home, issues) {
  const plan = manifest.libraryPlan;
  try {
    if (!plan
      || typeof plan.configPath !== "string"
      || typeof plan.sourceRoot !== "string"
      || typeof plan.targetRoot !== "string"
      || typeof plan.configExisted !== "boolean") throw new Error("库计划缺失或格式错误");
    const activationConfig = decodePlannedBytes(plan.activationConfigBase64, plan.activationConfigSha256);
    const finalConfig = decodePlannedBytes(plan.finalConfigBase64, plan.finalConfigSha256);
    if (path.resolve(plan.configPath) !== path.join(home, "config.json")) throw new Error("配置路径与此主目录不匹配");
    return { ...plan, activationConfig, finalConfig };
  } catch (error) {
    issues.push(issue("preimage_manifest_mismatch", path.join(home, "config.json"), "请使用此主目录对应的准确准备回执", {
      diagnostic: error.message,
    }));
    return null;
  }
}

function applyLibrary(home, preimage, verificationPath) {
  if (!preimage) {
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, issues: [issue("preimage_required", null, "请传入 apply-state 使用的 --preimage 路径")] }, 1);
  }
  const manifest = loadManifest(preimage, home, "apply-library");
  const issues = validatePreimage(preimage, manifest);
  if (manifest.status !== "applied") {
    issues.push(issue("preimage_manifest_mismatch", path.join(preimage, "manifest.json"), "收尾程序需要一份已完成的准备回执"));
  }
  const receipt = verificationReceipt(home, preimage, verificationPath);
  if (receipt.issue) issues.push(receipt.issue);
  const verifiedTails = receipt.receipt?.legacyTails ?? [];
  const systemWorld = managedSystemWorldState(home, manifest, issues, receipt.receipt?.managedSystemWorld);
  const tailSamples = new Map();
  for (const sessionName of new Set(verifiedTails.map((tail) => tail.sessionName))) {
    const sample = telemetryPair(home, preimage, manifest, sessionName, issues);
    if (sample) tailSamples.set(sessionName, sample);
  }
  requireTailConvergence(verifiedTails, tailSamples, issues);
  const library = libraryPlanFromManifest(manifest, home, issues);
  validateLegacySources(
    preimage,
    manifest,
    path.join(home, "context"),
    "context-source",
    issues,
    systemWorld.directories,
    verifiedTails,
  );
  validateLegacySources(
    preimage,
    manifest,
    path.join(home, "provider-usage"),
    "provider-source",
    issues,
    [],
    verifiedTails,
  );
  if (library) {
    const currentConfigSha = fs.existsSync(library.configPath) ? sha256(fs.readFileSync(library.configPath)) : null;
    if (currentConfigSha !== library.activationConfigSha256) {
      issues.push(issue("config_drift", library.configPath, "请保留已变化的配置，并在收尾前准备新迁移回执"));
    }
  }
  if (issues.length > 0 || !library) {
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues }, 1);
  }

  let sourceTreeSnapshot;
  try {
    sourceTreeSnapshot = treeSnapshot(library.sourceRoot);
  } catch (error) {
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues: [issue(
      "library_source_invalid",
      library.sourceRoot,
      "请保留不受支持的条目，扩展有界迁移后再重试",
      { diagnostic: error.message },
    )] }, 1);
  }
  const systemEntry = sourceTreeSnapshot.entries.find((entry) => entry.path === "system");
  const systemWorldEntry = sourceTreeSnapshot.entries.find((entry) => entry.path === "system/system-world.yaml");
  if (systemEntry?.type === "symlink" || systemWorldEntry?.type === "symlink") {
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues: [issue(
      "system_world_conflict",
      path.join(library.sourceRoot, "system"),
      "请保留预留 System World 路径中的不透明条目，并在迁移前协调",
    )] }, 1);
  }
  const sourceSystemWorld = path.join(library.sourceRoot, "system", "system-world.yaml");
  const sourceSystemEntries = systemEntry?.type === "directory"
    ? sourceTreeSnapshot.entries.filter((entry) => entry.path === "system" || entry.path.startsWith("system/"))
    : [];
  const sourceSystemWorldIsDefault = systemWorldEntry?.type === "file"
    && sha256(fs.readFileSync(sourceSystemWorld)) === sha256(DEFAULT_SYSTEM_WORLD)
    && sourceSystemEntries.length === 2;
  if (systemEntry && !sourceSystemWorldIsDefault) {
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues: [issue(
      "system_world_conflict",
      path.join(library.sourceRoot, "system"),
      "请保留 legacy 库的预留 system 条目，并在收尾前显式协调",
    )] }, 1);
  }

  try {
    assertTreeSnapshot(library.sourceRoot, sourceTreeSnapshot);
  } catch (error) {
    const libraryDrift = error.migrationIssueCode === "library_source_drift";
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues: [issue(
      libraryDrift ? "library_source_drift" : "preimage_mismatch",
      libraryDrift ? error.migrationPath : preimage,
      libraryDrift
        ? "请保留已变化的 context 库，并从新盘点重新运行"
        : "收尾前请恢复可写且逐字节匹配的 preimage",
      { diagnostic: error.message },
    )] }, 1);
  }

  const targetStat = lstatOrNull(library.targetRoot);
  if (targetStat && (!targetStat.isDirectory() || targetStat.isSymbolicLink())) {
    emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues: [issue(
      "library_target_conflict",
      library.targetRoot,
      "请保留不透明目标，并在收尾前选择预期的 canonical context 根目录",
    )] }, 1);
  }
  const sourceTopLevel = sourceTreeSnapshot.digest === null
    ? []
    : fs.readdirSync(library.sourceRoot, { withFileTypes: true })
      .map((entry) => entry.name)
      .filter((name) => name !== "system")
      .sort((left, right) => left.localeCompare(right));
  if (library.sourceRoot !== library.targetRoot) {
    for (const name of sourceTopLevel) {
      const destination = path.join(library.targetRoot, name);
      if (lstatOrNull(destination)) {
        emit({ schema: SCHEMA, phase: "apply-library", ok: false, applied: false, complete: false, issues: [issue(
          "library_target_conflict",
          destination,
          "请保留两个条目并在收尾前协调冲突；不会覆盖任何现有目标",
        )] }, 1);
      }
    }
  }

  const prepared = {
    ...manifest,
    status: "finalizer-prepared",
    library: {
      sourceRoot: library.sourceRoot,
      targetRoot: library.targetRoot,
      sourceTreeDigest: sourceTreeSnapshot.digest,
      sourceTreeRootIdentity: sourceTreeSnapshot.rootIdentity,
      sourceTreeInventory: sourceTreeSnapshot.entries,
      skippedMatchingSourceSystemWorld: sourceSystemWorldIsDefault,
      configExisted: library.configExisted,
      activationConfigSha256: library.activationConfigSha256,
      finalConfigSha256: library.finalConfigSha256,
      copiedRoots: [],
    },
  };
  const manifestPath = path.join(preimage, "manifest.json");
  atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(prepared, null, 2)}\n`), 0o600);

  try {
    assertTreeSnapshot(library.sourceRoot, sourceTreeSnapshot);
    fs.mkdirSync(library.targetRoot, { recursive: true });
    const copiedRoots = [];
    if (library.sourceRoot !== library.targetRoot) {
      for (const name of sourceTopLevel) {
        const source = path.join(library.sourceRoot, name);
        const destination = path.join(library.targetRoot, name);
        assertTreeSnapshot(library.sourceRoot, sourceTreeSnapshot);
        const sourceEntry = entrySnapshot(source);
        copiedRoots.push({ name, snapshot: sourceEntry });
        atomicWrite(manifestPath, Buffer.from(`${JSON.stringify({
          ...prepared,
          status: "finalizer-copying",
          library: { ...prepared.library, copiedRoots },
        }, null, 2)}\n`), 0o600);
        copyEntryOpaque(source, destination);
        const destinationEntry = assertEntrySnapshot(destination, sourceEntry, false);
        copiedRoots[copiedRoots.length - 1] = { name, snapshot: destinationEntry };
        atomicWrite(manifestPath, Buffer.from(`${JSON.stringify({
          ...prepared,
          status: "finalizer-copying",
          library: { ...prepared.library, copiedRoots },
        }, null, 2)}\n`), 0o600);
      }
    }
    assertTreeSnapshot(library.sourceRoot, sourceTreeSnapshot);
    assertLegacySourcesStillVerified(
      home,
      preimage,
      manifest,
      [...systemWorld.directories, ...copiedRoots.map((entry) => path.join(library.targetRoot, entry.name))],
      verifiedTails,
    );
    if (sha256(fs.readFileSync(library.configPath)) !== library.activationConfigSha256) {
      throw new Error(`配置在收尾期间发生变化：${library.configPath}`);
    }
    if (library.activationConfigSha256 !== library.finalConfigSha256) {
      atomicWrite(library.configPath, library.finalConfig, fs.statSync(library.configPath).mode & 0o777);
    }
    const appliedAt = new Date().toISOString();
    const completed = {
      ...prepared,
      status: "finalizer-applied",
      library: {
        ...prepared.library,
        copiedRoots,
        targetTreeDigest: treeDigest(library.targetRoot),
        appliedConfigSha256: sha256(fs.readFileSync(library.configPath)),
        appliedAt,
      },
    };
    atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(completed, null, 2)}\n`), 0o600);
    emit({
      schema: SCHEMA,
      generatedAt: appliedAt,
      home,
      phase: "apply-library",
      applied: true,
      complete: true,
      preimage,
      operation: "non-destructive-finalizer",
      sourceRoot: library.sourceRoot,
      contextRoot: library.targetRoot,
      systemWorldPath: systemWorld.artifact?.path ?? null,
      copied: copiedRoots.map((entry) => path.join(library.targetRoot, entry.name)),
      preservedRecovery: [library.sourceRoot, path.join(home, "context"), path.join(home, "provider-usage")],
      issues: [],
      next: "请检查复制后的库、生效的 context 根目录、System World 来源以及有代表性的新席位行为；在单独退役前保留 legacy 源",
    });
  } catch (error) {
    const sourceDrift = error.migrationIssueCode === "legacy_source_drift";
    const libraryDrift = error.migrationIssueCode === "library_source_drift";
    emit({
      schema: SCHEMA,
      phase: "apply-library",
      ok: false,
      applied: false,
      complete: false,
      preimage,
      issues: [issue(
        sourceDrift ? "legacy_source_drift" : libraryDrift ? "library_source_drift" : "library_apply_incomplete",
        sourceDrift || libraryDrift ? error.migrationPath : null,
        libraryDrift
          ? "请保留已变化的 context 库，并在重试前使用此 preimage 运行 --rollback"
          : sourceDrift
          ? "请保留已变化的 legacy 遥测源并获取新验证回执"
          : "重试前请使用此 preimage 运行 --rollback；已复制的根目录仍有记录，源未被删除",
        { diagnostic: error.message },
      )],
    }, 1);
  }
}

function rollback(home, preimage) {
  const manifest = loadManifest(preimage, home, "rollback");
  const issues = validatePreimage(preimage, manifest);
  const libraryPlan = libraryPlanFromManifest(manifest, home, issues);
  const configRecord = manifest.files.find((file) => file.kind === "config");
  const copiedRoots = Array.isArray(manifest.library?.copiedRoots) ? manifest.library.copiedRoots : [];
  const restored = [];
  const alreadyOriginal = [];

  if (libraryPlan) {
    const configExists = fs.existsSync(libraryPlan.configPath);
    const currentConfigSha = configExists ? sha256(fs.readFileSync(libraryPlan.configPath)) : null;
    const originalSha = configRecord?.sha256 ?? null;
    const accepted = new Set([originalSha, libraryPlan.activationConfigSha256, libraryPlan.finalConfigSha256].filter(Boolean));
    if (currentConfigSha === originalSha || (!libraryPlan.configExisted && currentConfigSha === null)) {
      alreadyOriginal.push(libraryPlan.configPath);
    } else if (currentConfigSha === null || !accepted.has(currentConfigSha)) {
      issues.push(issue("destination_drift", libraryPlan.configPath, "请保留已变化的配置，并在回滚前决定其恢复方式"));
    }
  }

  for (const copied of copiedRoots) {
    const destination = libraryPlan ? path.join(libraryPlan.targetRoot, copied.name) : null;
    if (!destination || copied.name.includes(path.sep) || copied.name === "." || copied.name === "..") {
      issues.push(issue("preimage_manifest_mismatch", destination, "请使用此主目录对应的准确准备回执"));
      continue;
    }
    if (!lstatOrNull(destination)) {
      alreadyOriginal.push(destination);
      continue;
    }
    try {
      assertEntrySnapshot(destination, copied.snapshot, true);
    } catch (error) {
      issues.push(issue("destination_drift", destination, "请保留已变化的库副本条目，并在回滚前协调", {
        diagnostic: error.message,
      }));
    }
  }

  const systemWorld = manifest.systemWorld;
  if (systemWorld && !systemWorld.existed && lstatOrNull(systemWorld.path)) {
    const current = lstatOrNull(systemWorld.path);
    if (!current?.isFile() || current.isSymbolicLink()
      || sha256(fs.readFileSync(systemWorld.path)) !== systemWorld.sha256
      || (current.mode & 0o777) !== systemWorld.mode) {
      issues.push(issue("destination_drift", systemWorld.path, "请保留已变化的 System World，并在回滚前协调"));
    }
  }

  if (issues.length > 0) {
    emit({ schema: SCHEMA, phase: "rollback", rolledBack: false, complete: false, preimage, restored: [], alreadyOriginal, issues }, 1);
  }

  for (const copied of [...copiedRoots].reverse()) {
    const destination = path.join(libraryPlan.targetRoot, copied.name);
    if (lstatOrNull(destination)) {
      fs.rmSync(destination, { recursive: true, force: false });
      restored.push(destination);
    }
  }
  if (libraryPlan) {
    if (libraryPlan.configExisted && configRecord) {
      const original = fs.readFileSync(path.join(preimage, configRecord.storedAs));
      if (!fs.existsSync(libraryPlan.configPath) || sha256(fs.readFileSync(libraryPlan.configPath)) !== configRecord.sha256) {
        atomicWrite(libraryPlan.configPath, original, configRecord.mode);
        restored.push(libraryPlan.configPath);
      }
    } else if (fs.existsSync(libraryPlan.configPath)) {
      fs.rmSync(libraryPlan.configPath);
      restored.push(libraryPlan.configPath);
    }
  }
  if (systemWorld && !systemWorld.existed && lstatOrNull(systemWorld.path)) {
    fs.rmSync(systemWorld.path);
    restored.push(systemWorld.path);
    const directory = path.dirname(systemWorld.path);
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  }
  for (const directory of [...(manifest.stateDirectories ?? [])].reverse()) {
    if (!directory.existed && lstatOrNull(directory.path)?.isDirectory() && fs.readdirSync(directory.path).length === 0) {
      fs.rmdirSync(directory.path);
      restored.push(directory.path);
    }
  }
  emit({
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    home,
    phase: "rollback",
    rolledBack: true,
    complete: true,
    preimage,
    restored,
    alreadyOriginal,
    preservedLegacy: [path.join(home, "context"), path.join(home, "provider-usage"), libraryPlan?.sourceRoot].filter(Boolean),
    issues: [],
    next: "此辅助工具负责的准备和收尾效果已撤销；legacy 源及无关 canonical 状态保持不变",
  });
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}
const parsed = parseArguments(argv);
if (parsed.issue) {
  emit({ schema: SCHEMA, phase: "input", ok: false, issues: [parsed.issue] }, 1);
}
const homeArg = parsed.values.get("--home") || process.env.OPENRIG_HOME;
if (!homeArg) {
  emit({ schema: SCHEMA, phase: "input", ok: false, issues: [issue("home_required", null, "请传入 --home 或设置 OPENRIG_HOME")] }, 1);
}
const home = path.resolve(homeArg);
const apply = parsed.phases.has("--apply-state");
const verifyFlag = parsed.phases.has("--verify");
const applyLibraryFlag = parsed.phases.has("--apply-library");
const rollbackArg = parsed.values.get("--rollback");
if ([apply, verifyFlag, applyLibraryFlag, Boolean(rollbackArg)].filter(Boolean).length > 1) {
  emit({ schema: SCHEMA, phase: "input", ok: false, issues: [issue("phase_conflict", null, "请在 --apply-state、--verify、--apply-library 或 --rollback 中仅选择一项")] }, 1);
}

if (apply) applyState(home, parsed.values.get("--preimage"));
if (verifyFlag) verify(home, parsed.values.get("--preimage"));
if (applyLibraryFlag) applyLibrary(home, parsed.values.get("--preimage"), parsed.values.get("--verification"));
if (rollbackArg) rollback(home, path.resolve(rollbackArg));
emit(publicPlan(home, buildPlan(home)));

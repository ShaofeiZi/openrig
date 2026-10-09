// Canonical project-workspace scaffold。S01 拥有这些字节；S05 的 instance initializer 调用此 owner，
// 而不是复制其行为。

import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WORKSPACE_DIRS = ["missions", "exhaust"] as const;

const PROJECT_SPEC = `---
intent: 将此项目的持久工作组织为 mission 和 slice，再通过 queue 支持的 agent 协作推进。
---

# 项目

这是默认 zrig workspace 的项目级上下文。它让 agent 在进入活动 mission 和 slice 前获得稳定的
项目意图。请编辑此文件，说明项目用途及其受益对象。
`;

const PROJECT_MANIFEST = `schema: openrig.project/v0alpha1
kind: project
install:
  intent: SPEC.md
  context: []
  skills: []
missions:
  root: missions
# 在上方添加有序的项目 Markdown 地址和稳定的 catalog skill ID。
# Skill 来源和 System World 保持在 project workspace 之外。
`;

const WORKSPACE_CATALOG = `schema: openrig.workspace/v0alpha1
projects:
  - id: default
    root: .
`;

const WORKSPACE_GITIGNORE = `# zrig 临时工作和本地 runtime 投影状态。
/exhaust/
/.openrig/
`;

export function workspaceScaffoldDirs(): string[] {
  return [...WORKSPACE_DIRS];
}

export function workspaceScaffoldFiles(): Array<{ relPath: string; content: string }> {
  return [
    { relPath: "SPEC.md", content: PROJECT_SPEC },
    { relPath: "project.yaml", content: PROJECT_MANIFEST },
    { relPath: "workspace.yaml", content: WORKSPACE_CATALOG },
    { relPath: ".gitignore", content: WORKSPACE_GITIGNORE },
  ];
}

export type ManagedPathKind = "missing" | "file" | "directory" | "other";

export interface InitializationFsOps {
  pathKind(path: string): ManagedPathKind;
  mkdirp(path: string): void;
  writeFile(path: string, content: string): void;
}

export interface InitializationConflict {
  path: string;
  expected: "file" | "directory";
  actual: Exclude<ManagedPathKind, "missing">;
}

export interface InitWorkspaceResult {
  ok: boolean;
  root: string;
  rootCreated: boolean;
  subdirs: Array<{ name: string; path: string; created: boolean }>;
  files: Array<{ relPath: string; absPath: string; created: boolean; skipped: "exists" | null }>;
  conflicts: InitializationConflict[];
  dryRun: boolean;
}

export function nodeInitializationFs(): InitializationFsOps {
  return {
    pathKind(path) {
      try {
        const value = lstatSync(path);
        if (value.isDirectory()) return "directory";
        if (value.isFile()) return "file";
        return "other";
      } catch {
        return "missing";
      }
    },
    mkdirp: (path) => mkdirSync(path, { recursive: true }),
    writeFile: (path, content) => writeFileSync(path, content, "utf8"),
  };
}

/** 以增量方式协调 S01 project workspace。所有冲突都在首次写入前发现，因此格式错误的用户所有路径
 * 绝不会留下半成品 scaffold。 */
export function ensureDefaultWorkspace(options: {
  root: string;
  dryRun?: boolean;
  fs?: InitializationFsOps;
}): InitWorkspaceResult {
  const fs = options.fs ?? nodeInitializationFs();
  const dryRun = options.dryRun ?? false;
  const rootKind = fs.pathKind(options.root);
  const subdirs = workspaceScaffoldDirs().map((name) => {
    const path = join(options.root, name);
    return { name, path, created: fs.pathKind(path) === "missing" };
  });
  const files = workspaceScaffoldFiles().map(({ relPath }) => {
    const absPath = join(options.root, relPath);
    const created = fs.pathKind(absPath) === "missing";
    return { relPath, absPath, created, skipped: created ? null : "exists" as const };
  });
  const conflicts: InitializationConflict[] = [];

  if (rootKind !== "missing" && rootKind !== "directory") {
    conflicts.push({ path: options.root, expected: "directory", actual: rootKind });
  }
  for (const subdir of subdirs) {
    const actual = fs.pathKind(subdir.path);
    if (actual !== "missing" && actual !== "directory") {
      conflicts.push({ path: subdir.path, expected: "directory", actual });
    }
  }
  for (const file of files) {
    const actual = fs.pathKind(file.absPath);
    if (actual !== "missing" && actual !== "file") {
      conflicts.push({ path: file.absPath, expected: "file", actual });
    }
  }

  if (conflicts.length === 0 && !dryRun) {
    if (rootKind === "missing") fs.mkdirp(options.root);
    for (const subdir of subdirs) if (subdir.created) fs.mkdirp(subdir.path);
    for (const file of workspaceScaffoldFiles()) {
      const absPath = join(options.root, file.relPath);
      if (fs.pathKind(absPath) === "missing") fs.writeFile(absPath, file.content);
    }
  }

  return {
    ok: conflicts.length === 0,
    root: options.root,
    rootCreated: rootKind === "missing",
    subdirs,
    files,
    conflicts,
    dryRun,
  };
}

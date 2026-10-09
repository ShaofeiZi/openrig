import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

export const DESTROY_CONFIRM_TOKEN = "destroy-openrig-state";

export type DestroyScope = "state" | "all";

export interface DestroyRuntimeConfig {
  stateRoot: string;
  dbPath: string;
  transcriptsPath: string;
  daemonHost: string;
  daemonPort: number;
}

export interface DestroyTarget {
  path: string;
  kind: "state_root" | "db_file" | "db_shm" | "db_wal" | "transcripts_dir";
  backupPath?: string;
}

export interface DestroyPlan {
  scope: DestroyScope;
  backup: boolean;
  stateRoot: string;
  daemonHost: string;
  daemonPort: number;
  managedTmuxSessions: string[];
  targets: DestroyTarget[];
  warnings: string[];
}

export interface DestroyResult {
  scope: DestroyScope;
  backup: boolean;
  stateRoot: string;
  backupPaths: string[];
  daemonStopped: boolean;
  portCleared: boolean;
  stateRecreated: boolean;
  tmuxKilled: number;
  tmuxMissing: number;
  warnings: string[];
}

export interface ListenerInspection {
  kind: "openrig" | "other_http" | "unreachable";
  healthy?: boolean;
  detail?: string;
}

export interface DestroyDeps {
  stopDaemon: () => Promise<void>;
  inspectListener: (host: string, port: number) => Promise<ListenerInspection>;
  findListeningPid: (port: number) => number | null;
  killProcess: (pid: number) => void;
  exists: (path: string) => boolean;
  renamePath: (from: string, to: string) => void;
  removePath: (path: string) => void;
  mkdirp: (path: string) => void;
  listManagedTmuxSessions: (dbPath: string) => string[];
  killTmuxSession: (sessionName: string) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

function normalizePathForPrefix(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

export function isWithinPath(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(normalizePathForPrefix(root));
}

function formatTimestamp(date: Date): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

export function buildBackupPath(targetPath: string, exists: (path: string) => boolean, now = new Date()): string {
  const stamp = formatTimestamp(now);
  const base = `${targetPath}.backup-${stamp}`;
  if (!exists(base)) return base;
  let suffix = 2;
  while (exists(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function listManagedTmuxSessionsFromDb(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT DISTINCT
        COALESCE(
          b.tmux_session,
          (
            SELECT s2.session_name
            FROM sessions s2
            WHERE s2.node_id = n.id
            ORDER BY datetime(s2.created_at) DESC, s2.rowid DESC
            LIMIT 1
          )
        ) AS session_name
      FROM nodes n
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE COALESCE(b.attachment_type, 'tmux') = 'tmux'
    `).all() as Array<{ session_name: string | null }>;

    return rows
      .map((row) => row.session_name?.trim() ?? "")
      .filter((name): name is string => Boolean(name))
      .sort();
  } finally {
    db.close();
  }
}

export function buildDestroyPlan(
  scope: DestroyScope,
  backup: boolean,
  config: DestroyRuntimeConfig,
  deps: Pick<DestroyDeps, "exists" | "listManagedTmuxSessions" | "now">
): DestroyPlan {
  const warnings: string[] = [];
  const targets: DestroyTarget[] = [];

  const stateRootExists = deps.exists(config.stateRoot);
  targets.push({
    path: config.stateRoot,
    kind: "state_root",
    ...(backup && stateRootExists ? { backupPath: buildBackupPath(config.stateRoot, deps.exists, deps.now()) } : {}),
  });

  const addExternalTarget = (path: string, kind: DestroyTarget["kind"]) => {
    if (!deps.exists(path)) return;
    if (isWithinPath(path, config.stateRoot)) return;
    targets.push({
      path,
      kind,
      ...(backup ? { backupPath: buildBackupPath(path, deps.exists, deps.now()) } : {}),
    });
    warnings.push(`${kind} 在状态根之外，将被${backup ? "单独备份" : "单独删除"}：${path}`);
  };

  addExternalTarget(config.dbPath, "db_file");
  addExternalTarget(`${config.dbPath}-shm`, "db_shm");
  addExternalTarget(`${config.dbPath}-wal`, "db_wal");
  addExternalTarget(config.transcriptsPath, "transcripts_dir");

  let managedTmuxSessions: string[] = [];
  if (scope === "all" && deps.exists(config.dbPath)) {
    try {
      managedTmuxSessions = deps.listManagedTmuxSessions(config.dbPath);
    } catch (err) {
      warnings.push(`无法从 ${config.dbPath} 枚举受管 tmux 会话：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    scope,
    backup,
    stateRoot: config.stateRoot,
    daemonHost: config.daemonHost,
    daemonPort: config.daemonPort,
    managedTmuxSessions,
    targets,
    warnings,
  };
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "0.0.0.0";
}

export async function executeDestroy(plan: DestroyPlan, deps: DestroyDeps): Promise<DestroyResult> {
  const warnings = [...plan.warnings];
  const backupPaths: string[] = [];
  let stateRecreated = false;

  try {
    await deps.stopDaemon();
  } catch (err) {
    warnings.push(`stopDaemon 失败：${err instanceof Error ? err.message : String(err)}`);
  }

  let daemonStopped = false;
  let portCleared = false;

  if (isLocalHost(plan.daemonHost)) {
    const before = await deps.inspectListener(plan.daemonHost, plan.daemonPort);
    if (before.kind === "openrig") {
      const listenerPid = deps.findListeningPid(plan.daemonPort);
      if (listenerPid !== null) {
        try {
          deps.killProcess(listenerPid);
        } catch (err) {
          warnings.push(`无法终止监听进程 ${listenerPid}：${err instanceof Error ? err.message : String(err)}`);
        }
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if ((await deps.inspectListener(plan.daemonHost, plan.daemonPort)).kind === "unreachable") break;
          await deps.sleep(100);
        }
      } else {
        warnings.push(`zrig 在端口 ${plan.daemonPort} 上有响应，但未找到监听进程。`);
      }
    } else if (before.kind === "other_http") {
      warnings.push(`端口 ${plan.daemonPort} 被一个活跃的非 zrig HTTP 监听器占用。状态未被改动。`);
    }

    const after = await deps.inspectListener(plan.daemonHost, plan.daemonPort);
    portCleared = after.kind === "unreachable";
    daemonStopped = portCleared;
  } else {
    warnings.push(`后台服务主机 ${plan.daemonHost} 不是本地。rig destroy 仅操作本地后台服务目标；状态未被改动。`);
  }

  if (!portCleared) {
    return {
      scope: plan.scope,
      backup: plan.backup,
      stateRoot: plan.stateRoot,
      backupPaths,
      daemonStopped,
      portCleared,
      stateRecreated,
      tmuxKilled: 0,
      tmuxMissing: 0,
      warnings,
    };
  }

  let tmuxKilled = 0;
  let tmuxMissing = 0;
  if (plan.scope === "all") {
    for (const sessionName of plan.managedTmuxSessions) {
      if (deps.killTmuxSession(sessionName)) tmuxKilled += 1;
      else tmuxMissing += 1;
    }
  }

  for (const target of plan.targets) {
    if (!deps.exists(target.path)) continue;
    if (plan.backup && target.backupPath) {
      deps.renamePath(target.path, target.backupPath);
      backupPaths.push(target.backupPath);
    } else {
      deps.removePath(target.path);
    }
  }

  deps.mkdirp(plan.stateRoot);
  stateRecreated = true;

  return {
    scope: plan.scope,
    backup: plan.backup,
    stateRoot: plan.stateRoot,
    backupPaths,
    daemonStopped,
    portCleared,
    stateRecreated,
    tmuxKilled,
    tmuxMissing,
    warnings,
  };
}

export function findListeningPidWithLsof(port: number): number | null {
  try {
    const output = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" }).trim();
    if (!output) return null;
    const first = output.split(/\s+/)[0]?.trim();
    if (!first) return null;
    const pid = parseInt(first, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function killTmuxSessionWithCli(sessionName: string): boolean {
  try {
    execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

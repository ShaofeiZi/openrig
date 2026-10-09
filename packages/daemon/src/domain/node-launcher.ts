import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { TranscriptStore } from "./transcript-store.js";
import type { PersistedEvent } from "./types.js";
import { validateSessionName, deriveSessionName } from "./session-name.js";
import {
  startTranscriptRotation,
  getTranscriptRotationOptionsFromEnv,
} from "./transcript-rotation.js";
import type { TmuxOptionDefaultsApplier } from "./tmux-option-defaults.js";
import { observeSolePane, paneObservationVerdict } from "./pane-binding-observation.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import type { OccupantKind } from "./session-registry.js";

import type { Session, Binding } from "./types.js";

export type LaunchResult =
  | { ok: true; sessionName: string; session: Session; binding: Binding; warnings?: string[] }
  | { ok: false; code: string; message: string };

interface LaunchOpts {
  sessionName?: string;
  cwd?: string;
  /**
   * 逐席位 silence window 覆盖（秒）。当前不生效：live SeatActivityService poller 使用全局
   * 默认值 3 秒，不读取逐席位窗口。保留给未来的 per-seat-poller 决策；调用方从
   * AgentSpec.profile.activity 传入。
   */
  silenceWindowSeconds?: number;
  /** tenure ledger 中，有意启动的 fresh occupant 与工作组初次启动不同。 */
  occupantKind?: OccupantKind;
}

interface NodeLauncherDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
  transcriptStore?: TranscriptStore;
  sessionEnv?: Record<string, string | undefined>;
  /** 默认 silence window（秒）。当前只作为 SeatActivityService 的全局默认值 3 秒使用；
   *  通过 LaunchOpts 提供的逐席位覆盖目前不生效。 */
  defaultSilenceWindowSeconds?: number;
  /**
   * OPR.0.4.6.02 S1——共享的 tmux option-defaults applier：mouse/status 属于 session
   * scope，set-clipboard/copy-command 属于 server scope；启动时应用到刚创建的 session。由
   * startup 注入，使其与 SuccessorSessionLauncher 共享同一实例及逐后台服务一次的
   * server-defaults memo。省略时（多数单元测试）launch 路径完全跳过 option 应用。
   */
  tmuxOptionDefaults?: TmuxOptionDefaultsApplier;
}

export class NodeLauncher {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter;
  private transcriptStore: TranscriptStore | null;
  private sessionEnv: Record<string, string>;
  private defaultSilenceWindowSeconds: number;
  private tmuxOptionDefaults: TmuxOptionDefaultsApplier | null;

  constructor(deps: NodeLauncherDeps) {
    // 硬 runtime 不变量：所有 domain service 必须共享同一个数据库句柄，否则 launchNode 中的
    // db.transaction() 无法原子覆盖全部写入。
    if (deps.db !== deps.rigRepo.db) {
      throw new Error("NodeLauncher：rigRepo 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("NodeLauncher：sessionRegistry 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("NodeLauncher：eventBus 必须共享同一个数据库句柄");
    }

    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.transcriptStore = deps.transcriptStore ?? null;
    this.sessionEnv = compactEnv(deps.sessionEnv ?? {});
    this.defaultSilenceWindowSeconds = deps.defaultSilenceWindowSeconds ?? 3;
    this.tmuxOptionDefaults = deps.tmuxOptionDefaults ?? null;
  }

  async launchNode(
    rigId: string,
    logicalId: string,
    opts?: LaunchOpts
  ): Promise<LaunchResult> {
    // 1. 验证节点存在且尚未绑定。
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      return { ok: false, code: "node_not_found", message: `未找到工作组 ${rigId}` };
    }

    const node = rig.nodes.find((n) => n.logicalId === logicalId);
    if (!node) {
      return { ok: false, code: "node_not_found", message: `工作组中未找到节点 ${logicalId}` };
    }

    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(node.id)) {
      return guard.lifecycle([node.id], () => this.launchNode(rigId, logicalId, opts));
    }

    if (node.binding !== null) {
      return { ok: false, code: "already_bound", message: `节点 ${logicalId} 已绑定` };
    }

    // 2. 派生或验证 session name。
    const sessionName = opts?.sessionName ?? deriveSessionName(rig.rig.name, logicalId);
    if (!validateSessionName(sessionName)) {
      return {
        ok: false,
        code: "invalid_session_name",
        message: `派生出的会话名称 "${sessionName}" 不符合 zrig 命名模式`,
      };
    }

    // 3. 进程启动前预留绑定 source 的 occupant generation。预留无副作用且 fail-open：ledger
    // 不可用时返回 null，launch 仍然有效。
    const occupantGeneration = this.sessionRegistry.reserveOccupantGeneration();

    // 使用 OpenRig identity 环境变量创建 tmux session。重名表示冲突，绝不授权终止同名的
    // 非托管 session。
    const openRigEnv = compactEnv({
      OPENRIG_NODE_ID: node.id,
      OPENRIG_SESSION_NAME: sessionName,
      OPENRIG_RUNTIME: node.runtime ?? undefined,
      ...this.sessionEnv,
      OPENRIG_OCCUPANT_GENERATION: occupantGeneration ?? undefined,
    });
    const sessionCwd = opts?.cwd ?? node.cwd ?? undefined;
    const tmuxResult = await this.tmuxAdapter.createSession(sessionName, sessionCwd, openRigEnv);
    if (!tmuxResult.ok) {
      return { ok: false, code: tmuxResult.code, message: tmuxResult.message };
    }

    const launchWarnings: string[] = [];

    // 在 DB 事务前观察 pane。具体 pane 与 session+binding 一起提交；无法解析的 pane 在同一
    // 事务中得到持久的具名 verdict，而不是继续携带无法解释的 NULL。
    const paneObservation = await observeSolePane(this.tmuxAdapter, sessionName);

    // 3a2. OPR.0.4.6.02 S1——通过共享 applier 把后台服务 tmux option 默认值应用到刚创建的
    // session。mouse/status 属于 session scope，set-clipboard/copy-command 属于 server scope。
    // 只触碰新 session，绝不追溯修改现有 session（BR-1 never-retro）。option 设置失败以非致命
    // launch warning 返回。
    if (this.tmuxOptionDefaults) {
      launchWarnings.push(...(await this.tmuxOptionDefaults.applyToFreshSession(sessionName)));
    }

    // 3b. 启动 transcript rotation。V1 预发布 CLI/后台服务 Item 1：有界 capture-pane 覆盖替代
    // 无界 pipe-pane 机制。单次 rotation tick 内的失败静默按 best-effort 处理；只有 transcript
    // 目录不可写会产生 launch warning。
    if (this.transcriptStore?.enabled) {
      const dirOk = this.transcriptStore.ensureTranscriptDir(rig.rig.name);
      if (dirOk) {
        const transcriptPath = this.transcriptStore.getTranscriptPath(rig.rig.name, sessionName);
        startTranscriptRotation(
          this.tmuxAdapter,
          sessionName,
          transcriptPath,
          getTranscriptRotationOptionsFromEnv(),
        );
      } else {
        launchWarnings.push(`无法为工作组 ${rig.rig.name} 创建 transcript 目录`);
      }
    }

    // 4. DB 事务：原子写入 session + binding + event。
    let persistedEvent: PersistedEvent;
    let createdSessionId: string | null = null;
    try {
      const txn = this.db.transaction(() => {
        const session = this.sessionRegistry.registerSession(
          node.id,
          sessionName,
          opts?.occupantKind ?? "initial",
          occupantGeneration,
        );
        createdSessionId = session.id;
        this.sessionRegistry.updateStatus(session.id, "running");
        this.sessionRegistry.updateBinding(node.id, {
          tmuxSession: sessionName,
          ...(paneObservation.ok ? { tmuxPane: paneObservation.pane } : {}),
        });
        if (!paneObservation.ok) {
          new SeatIdentityStore(this.db).upsert(paneObservationVerdict({
            nodeId: node.id,
            sessionName,
            observation: paneObservation,
          }));
        }
        return this.eventBus.persistWithinTransaction({
          type: "node.launched",
          rigId,
          nodeId: node.id,
          logicalId: node.logicalId,
          sessionName,
        });
      });
      persistedEvent = txn();
    } catch (err) {
      // DB 失败后尽力清理 tmux。
      await this.tmuxAdapter.killSession(sessionName);
      return {
        ok: false,
        code: "db_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    this.tmuxAdapter.deliveryGuard?.rebindLifecycle(node.id);
    this.tmuxAdapter.finishLaunchBinding?.(sessionName);

    // 5. 提交后尽力通知 subscriber。
    this.eventBus.notifySubscribers(persistedEvent);

    // 6. 为调用方读取刚创建的 session + binding。
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);
    const session = sessions.find((s) => s.id === createdSessionId);
    const binding = this.sessionRegistry.getBindingForNode(node.id);

    return {
      ok: true,
      sessionName,
      session: session!,
      binding: binding!,
      warnings: launchWarnings.length > 0 ? launchWarnings : undefined,
    };
  }
}

function compactEnv(input: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  return result;
}

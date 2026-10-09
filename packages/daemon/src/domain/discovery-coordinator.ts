import type { TmuxDiscoveryScanner } from "./tmux-discovery-scanner.js";
import type { SessionFingerprinter } from "./session-fingerprinter.js";
import type { SessionEnricher } from "./session-enricher.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { DiscoveredSession } from "./discovery-types.js";
interface ManagedBinding {
  tmuxSession: string | null;
  tmuxPane: string | null;
}

interface DiscoveryCoordinatorDeps {
  scanner: TmuxDiscoveryScanner;
  fingerprinter: SessionFingerprinter;
  enricher: SessionEnricher;
  discoveryRepo: DiscoveryRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
}

/**
 * 编排完整 discovery pipeline：
 * scan → 筛除 managed → fingerprint → enrich → persist → vanish detection → events
 */
export class DiscoveryCoordinator {
  private deps: DiscoveryCoordinatorDeps;

  constructor(deps: DiscoveryCoordinatorDeps) {
    this.deps = deps;
  }

  /** 运行一次 discovery 扫描周期。 */
  async scanOnce(): Promise<DiscoveredSession[]> {
    // 1. 扫描 tmux。
    const scanResult = await this.deps.scanner.scan();

    // 2. 构建 managed session 筛选器（两级）。
    const managedBindings = this.getManagedBindings();
    const managedSessions = new Set<string>();    // session-level: all panes managed
    const managedPanes = new Set<string>();        // pane-level: specific pane managed
    for (const binding of managedBindings) {
      if (binding.tmuxSession) {
        if (binding.tmuxPane) {
          managedPanes.add(`${binding.tmuxSession}:${binding.tmuxPane}`);
        } else {
          managedSessions.add(binding.tmuxSession);
        }
      }
    }

    // 同时筛除已 claim 的 session。
    const claimedSessions = this.deps.discoveryRepo.listDiscovered("claimed");
    const claimedPanes = new Set(claimedSessions.map((s) => `${s.tmuxSession}:${s.tmuxPane}`));

    // 3. 为批量 fingerprint 刷新 cmux signal。
    await this.deps.fingerprinter.refreshCmuxSignals();

    // 4. 处理每个扫描到的 pane。
    const seenIds = new Set<string>();
    const newDiscoveries: DiscoveredSession[] = [];

    for (const pane of scanResult.panes) {
      // 筛选：session 级 managed。
      if (managedSessions.has(pane.tmuxSession)) continue;
      // 筛选：pane 级 managed。
      if (managedPanes.has(`${pane.tmuxSession}:${pane.tmuxPane}`)) continue;
      // 筛选：已 claim。
      if (claimedPanes.has(`${pane.tmuxSession}:${pane.tmuxPane}`)) continue;

      // 生成 fingerprint。
      const fp = await this.deps.fingerprinter.fingerprint(pane);

      // 增强。
      const enrichment = this.deps.enricher.enrich(pane.cwd);

      // 检查是新发现还是重新扫描。
      const existing = this.deps.discoveryRepo.getByTmuxIdentity(pane.tmuxSession, pane.tmuxPane);
      const isNew = !existing;

      // Upsert。
      const session = this.deps.discoveryRepo.upsertDiscoveredSession({
        tmuxSession: pane.tmuxSession,
        tmuxPane: pane.tmuxPane,
        tmuxWindow: pane.tmuxWindow,
        pid: pane.pid ?? undefined,
        cwd: pane.cwd ?? undefined,
        activeCommand: pane.activeCommand ?? undefined,
        runtimeHint: fp.runtimeHint,
        confidence: fp.confidence,
        evidenceJson: JSON.stringify(fp.evidence),
        configJson: JSON.stringify(enrichment.raw),
      });

      seenIds.add(session.id);

      if (isNew) {
        newDiscoveries.push(session);
        this.deps.eventBus.emit({
          type: "session.discovered",
          discoveredId: session.id,
          tmuxSession: pane.tmuxSession,
          tmuxPane: pane.tmuxPane,
          runtimeHint: fp.runtimeHint,
          confidence: fp.confidence,
        });
      }
    }

    // 5. 消失检测：当前扫描中不存在的 active session。
    const previousActiveIds = this.deps.discoveryRepo.getActiveIds();
    const vanishedIds = previousActiveIds.filter((id) => !seenIds.has(id));

    if (vanishedIds.length > 0) {
      // 标记 vanished 前获取 session 详情（供 event 使用）。
      for (const id of vanishedIds) {
        const session = this.deps.discoveryRepo.getDiscoveredSession(id);
        if (session) {
          this.deps.eventBus.emit({
            type: "session.vanished",
            tmuxSession: session.tmuxSession,
            tmuxPane: session.tmuxPane ?? "",
          });
        }
      }
      this.deps.discoveryRepo.markVanished(vanishedIds);
    }

    // 6. 返回当前所有 active discovered session。
    return this.deps.discoveryRepo.listDiscovered("active");
  }

  private getManagedBindings(): ManagedBinding[] {
    const rows = this.deps.sessionRegistry.db.prepare(
      "SELECT tmux_session, tmux_pane FROM bindings"
    ).all() as Array<{ tmux_session: string | null; tmux_pane: string | null }>;

    return rows.map((r) => ({
      tmuxSession: r.tmux_session,
      tmuxPane: r.tmux_pane,
    }));
  }
}

// OPR.0.4.6.MH1 FR-5 —— 仪表板主机配置组件：你的主机
//（可重命名，FR-4）+ 每个已添加主机（地址、传输、状态、选定标记）+
// 添加控件（配对优先，FR-6）+ 切换器（FR-1）。
//
// 切换器范围（PRD §7 开放项，2026-07-07 显式解决，planner2 确认——
// qa2 无静默收窄绑定）：选择主机持久化 host.selected 指针 + 渲染诚实选择状态
//（标记 + 横幅）；无标志 CLI 命令消费它（FR-2）。它不重定向 UI 自己的数据表面
//——UI 表面渲染选定主机的数据是 MH-2 远端读取穿透（PRD §5 OOS 第 1 行；
// P1 意图 MH-2 mini-req 1）。如果创始者品味后续想让选择驱动 UI 重定向，
// 那作为 MH-2 工作在读取穿透基底上落地，不是重开此切片。
//
// 写入路径：切换器 + 重命名 = 设置存储（useSetSetting →
// POST /api/config/host.selected|host.name——两个表面读取的唯一选择/名称
// 存储）；添加 = 通过本地后台服务的窄命名路由族的配对握手
//（架构 B1/P1——浏览器的写入接缝是其本地后台服务；两个表面收敛于
// 同一注册表写入契约）。

import { useState } from "react";
import { useSettings, useSetSetting } from "../../hooks/useSettings.js";
import { useHosts, usePairHost, usePairPoll, type HostRow } from "../../hooks/useHosts.js";

function settingValue(settings: ReturnType<typeof useSettings>["data"], key: string): string {
  const raw = settings?.settings?.[key as never] as { value?: unknown } | undefined;
  return typeof raw?.value === "string" ? raw.value : "";
}

function hostAddress(h: HostRow): string {
  return h.transport === "ssh" ? (h.target ?? "—") : (h.url ?? "—");
}

export function HostConfigCard() {
  const { data: settings } = useSettings();
  const { data: hosts, error: hostsError } = useHosts();
  const setSetting = useSetSetting();
  const pairHost = usePairHost();

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [addDraft, setAddDraft] = useState("");
  const [pairId, setPairId] = useState<string | null>(null);
  const pairPoll = usePairPoll(pairId);

  const ownName = settingValue(settings, "host.name") || hosts?.ownName || "localhost";
  const selected = settingValue(settings, "host.selected") || hosts?.selected || "local";
  const rows = hosts?.hosts ?? [];

  const pairState = pairPoll.data?.status;
  const pairCode = pairPoll.data?.code ?? pairHost.data?.code;

  async function startPair() {
    const url = addDraft.trim();
    if (!url) return;
    try {
      const started = await pairHost.mutateAsync({ url });
      setPairId(started.pairId);
    } catch {
      // pairHost.error 在下方渲染——无需其他操作。
    }
  }

  function finishPair() {
    setPairId(null);
    setAddDraft("");
    pairHost.reset();
  }

  return (
    <section data-testid="dashboard-host-config" className="df-hosts">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-secondary mb-2">
        主机
      </div>

      {/* 你的主机（FR-4：一个存储名称，可重命名）。 */}
      <div className="df-hosts-own" data-testid="host-config-own">
        {renaming ? (
          <form
            className="df-hosts-rename"
            onSubmit={(e) => {
              e.preventDefault();
              const v = nameDraft.trim();
              if (v) void setSetting.mutateAsync({ key: "host.name" as never, value: v });
              setRenaming(false);
            }}
          >
            <input
              data-testid="host-rename-input"
              className="df-hosts-input"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              autoFocus
            />
            <button type="submit" className="df-hosts-btn">保存</button>
            <button type="button" className="df-hosts-btn" onClick={() => setRenaming(false)}>取消</button>
          </form>
        ) : (
          <>
            <span data-testid="host-own-name" className="df-hosts-name">{ownName}</span>
            <span className="df-hosts-tag">本机</span>
            {selected === "local" ? (
              <span data-testid="host-selected-marker-local" className="df-hosts-selected">已选择</span>
            ) : (
              <button
                type="button"
                className="df-hosts-btn"
                data-testid="host-select-local"
                onClick={() => void setSetting.mutateAsync({ key: "host.selected" as never, value: "local" })}
              >
                选择
              </button>
            )}
            <button
              type="button"
              className="df-hosts-btn"
              data-testid="host-rename-button"
              onClick={() => { setNameDraft(ownName); setRenaming(true); }}
            >
              重命名
            </button>
          </>
        )}
      </div>

      {/* 已添加主机：一个注册表，两个表面（FR-5 AC）。 */}
      {hostsError ? (
        <div className="df-hosts-empty">主机注册表不可读：{String((hostsError as Error).message)}</div>
      ) : rows.length === 0 ? (
        <div data-testid="host-config-empty" className="df-hosts-empty">
          暂无远端主机。在下方粘贴地址并配对——在目标上批准一次，完成。
        </div>
      ) : (
        <ul className="df-hosts-list" data-testid="host-config-rows">
          {rows.map((h) => (
            <li key={h.id} className="df-hosts-row">
              <span className="df-hosts-marker">{h.selected ? "*" : ""}</span>
              <span className="df-hosts-id">{h.id}</span>
              <span className="df-hosts-addr">{hostAddress(h)}</span>
              <span className="df-hosts-transport">{h.transport}</span>
              <span className={`df-hosts-status df-hosts-status-${h.status}`}>{h.status}</span>
              {h.selected ? (
                <span className="df-hosts-selected" data-testid={`host-selected-marker-${h.id}`}>已选择</span>
              ) : (
                <button
                  type="button"
                  className="df-hosts-btn"
                  data-testid={`host-select-${h.id}`}
                  onClick={() => void setSetting.mutateAsync({ key: "host.selected" as never, value: h.id })}
                >
                  选择
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {selected !== "local" ? (
        <div className="df-hosts-banner" data-testid="host-selection-banner">
          选定主机：{selected}——无标志 CLI 命令对其运行（zrig host select local 返回）。
        </div>
      ) : null}

      {/* 添加控件：配对优先（FR-6——仪式绝不是前门）。 */}
      {pairId === null ? (
        <form
          className="df-hosts-add"
          onSubmit={(e) => { e.preventDefault(); void startPair(); }}
        >
          <input
            data-testid="host-pair-input"
            className="df-hosts-input"
            placeholder="http://主机:7433 — 配对新主机"
            value={addDraft}
            onChange={(e) => setAddDraft(e.target.value)}
          />
          <button type="submit" className="df-hosts-btn" data-testid="host-pair-button" disabled={pairHost.isPending}>
            配对
          </button>
          {pairHost.error ? (
            <span className="df-hosts-error" data-testid="host-pair-error">{pairHost.error.message}</span>
          ) : null}
        </form>
      ) : (
        <div className="df-hosts-pairing" data-testid="host-pairing">
          {pairState === "approved" ? (
            <>
              <span>已配对。</span>
              <button type="button" className="df-hosts-btn" onClick={finishPair}>完成</button>
            </>
          ) : pairState === "denied" || pairState === "expired" ? (
            <>
              <span data-testid="host-pair-outcome">配对{pairState === "denied" ? "被拒绝" : "已过期"}——未持久化任何内容。</span>
              <button type="button" className="df-hosts-btn" onClick={finishPair}>关闭</button>
            </>
          ) : (
            <>
              <span data-testid="host-pair-code">代码 {pairCode ?? "…"}——等待目标上批准。</span>
              <button type="button" className="df-hosts-btn" onClick={finishPair}>取消</button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

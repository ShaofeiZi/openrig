// OPR.0.4.4.22 FR-6——钻取：按需经已上线的只读转录路由
// （tail / grep / full——零新增路由，读取不改后台服务）展示终端内容。
// 这一层才合法地出现原始 id 和面板内容（BR-10 的钻取层）。
//
// 仅按需拉取：本组件在创始人钻取时才挂载；常驻面板不为此拉取任何东西
// （零常驻转录成本合同——一笔省钱证明）。没有转录的席位显示后台服务诚实的
// 逐席位错误，绝不静默空面板。

import { useEffect, useRef, useState } from "react";

type DrillMode = "tail" | "grep" | "full";

// 加载态展示文案：机器枚举保持协议不变，仅把面向用户的词映射为中文。
const DRILL_MODE_LABEL_ZH: Record<DrillMode, string> = { tail: "尾部", grep: "搜索", full: "全文" };

interface DrillState {
  mode: DrillMode;
  content: string | null;
  error: string | null;
  loading: boolean;
}

async function fetchDrill(session: string, mode: DrillMode, pattern: string): Promise<{ content: string | null; error: string | null }> {
  const base = `/api/transcripts/${encodeURIComponent(session)}`;
  const url =
    mode === "tail" ? `${base}/tail?lines=50`
    : mode === "grep" ? `${base}/grep?pattern=${encodeURIComponent(pattern)}`
    : `${base}/full`;
  try {
    const res = await fetch(url);
    const body = (await res.json()) as { content?: string; matches?: string[]; error?: string };
    if (!res.ok) {
      // 后台服务诚实的逐席位错误，逐字显示。
      return { content: null, error: body.error ?? `HTTP ${res.status}` };
    }
    if (mode === "grep") {
      const matches = body.matches ?? [];
      return { content: matches.length > 0 ? matches.join("\n") : "（无匹配）", error: null };
    }
    return { content: body.content ?? "", error: null };
  } catch (err) {
    return { content: null, error: err instanceof Error ? err.message : "转录获取失败" };
  }
}

export function TranscriptDrillPanel({ sessionName, deferUntilDetailsOpen = false }: { sessionName: string; deferUntilDetailsOpen?: boolean }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [pattern, setPattern] = useState("");
  const [armed, setArmed] = useState(!deferUntilDetailsOpen);
  const [state, setState] = useState<DrillState>({ mode: "tail", content: null, error: null, loading: true });

  const load = (mode: DrillMode, grepPattern = pattern) => {
    setState((s) => ({ ...s, mode, loading: true }));
    void fetchDrill(sessionName, mode, grepPattern).then(({ content, error }) =>
      setState({ mode, content, error, loading: false }),
    );
  };

  // 打开时拉最近尾部（钻取的落地视图）。
  useEffect(() => {
    if (deferUntilDetailsOpen) {
      const details = rootRef.current?.closest("details");
      if (details && !details.open) {
        setArmed(false);
        setState({ mode: "tail", content: null, error: null, loading: false });
        let loaded = false;
        const onOpen = () => {
          if (details.open && !loaded) {
            loaded = true;
            setArmed(true);
            load("tail");
          }
        };
        const observer = new MutationObserver(onOpen);
        observer.observe(details, { attributes: true, attributeFilter: ["open"] });
        details.addEventListener("toggle", onOpen);
        return () => {
          observer.disconnect();
          details.removeEventListener("toggle", onOpen);
        };
      }
    }
    setArmed(true);
    load("tail");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionName]);

  if (!armed) {
    return <div ref={rootRef} />;
  }

  return (
    <div ref={rootRef} data-testid={`transcript-drill-${sessionName}`} className="mt-2 space-y-1 border border-outline-variant p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase text-on-surface-variant">转录 · {sessionName}</span>
        <button
          type="button"
          data-testid="drill-tail"
          onClick={() => load("tail")}
          className={`border px-2 py-0.5 font-mono text-[10px] uppercase ${state.mode === "tail" ? "border-outline bg-surface-variant" : "border-outline-variant hover:bg-surface-variant/50"}`}
        >
          尾部
        </button>
        <input
          data-testid="drill-grep-input"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && pattern.trim()) load("grep", pattern);
          }}
          placeholder="grep 模式…"
          className="border border-outline-variant bg-transparent px-2 py-0.5 font-mono text-[10px]"
        />
        <button
          type="button"
          data-testid="drill-grep"
          disabled={!pattern.trim()}
          onClick={() => load("grep", pattern)}
          className="border border-outline-variant px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-surface-variant/50 disabled:opacity-50"
        >
          搜索
        </button>
        {/* 全文仅在显式请求时（FR-6）。 */}
        <button
          type="button"
          data-testid="drill-full"
          onClick={() => load("full")}
          className="border border-outline-variant px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-surface-variant/50"
        >
          全文
        </button>
      </div>
      {state.loading ? (
        <p className="font-mono text-[10px] text-on-surface-variant">正在加载{DRILL_MODE_LABEL_ZH[state.mode]}…</p>
      ) : state.error ? (
        <p data-testid="drill-error" className="font-mono text-[10px] text-red-700">
          {state.error}
        </p>
      ) : (
        <pre
          data-testid="drill-content"
          className="max-h-80 overflow-auto whitespace-pre-wrap break-words bg-surface-lowest/40 p-2 font-mono text-[10px] leading-relaxed"
        >
          {state.content}
        </pre>
      )}
    </div>
  );
}

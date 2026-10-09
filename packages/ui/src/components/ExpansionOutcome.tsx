import type { ExpandRigResult } from "../hooks/mutations.js";

export function ExpansionOutcome({ result }: { result: ExpandRigResult }) {
  return (
    <div data-testid="expand-result" className="mt-2 font-mono text-[9px]">
      <div className={result.status === "ok" ? "text-green-700" : "text-amber-700"}>
        状态：{result.status} — 命名空间：{result.podNamespace}
      </div>
      {result.nodes?.map((n) => (
        <div key={n.logicalId} className={n.status === "launched" ? "text-on-surface" : "text-red-600"}>
          [{n.status === "launched" ? "正常" : "失败"}] {n.logicalId}{n.error ? ` — ${n.error}` : ""}
        </div>
      ))}
    </div>
  );
}

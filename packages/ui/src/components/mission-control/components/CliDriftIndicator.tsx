// PL-005 Phase A：跨 CLI 版本漂移指示器。
//
// 按 PRD § Runtime/Source Drift Acceptance 第 4 子条：在舰队级呈现
// "运行过期 CLI 的工作组"指示器 + 逐行"该字段在此工作组后台服务版本上不可用"
// 占位。

export interface CliDriftIndicatorProps {
  staleCliCount: number;
  degradedFields: string[];
  sourceFallback?: string | null;
}

export function CliDriftIndicator({
  staleCliCount,
  degradedFields,
  sourceFallback,
}: CliDriftIndicatorProps) {
  if (staleCliCount === 0 && degradedFields.length === 0 && !sourceFallback) {
    return null;
  }
  return (
    <div
      data-testid="mc-cli-drift-indicator"
      className="border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900"
    >
      {staleCliCount > 0 ? (
        <div data-testid="mc-cli-drift-stale-count">
          <span className="font-mono uppercase text-[9px] tracking-[0.12em]">过期 CLI</span>{" "}
          {staleCliCount} 个工作组运行过期 CLI
        </div>
      ) : null}
      {degradedFields.length > 0 ? (
        <div data-testid="mc-cli-drift-fields" className="mt-1">
          <span className="font-mono uppercase text-[9px] tracking-[0.12em]">缺失字段</span>{" "}
          {degradedFields.join(", ")}
        </div>
      ) : null}
      {sourceFallback ? (
        <div data-testid="mc-cli-drift-fallback" className="mt-1 text-amber-700">
          <span className="font-mono uppercase text-[9px] tracking-[0.12em]">回退</span>{" "}
          {sourceFallback}
        </div>
      ) : null}
    </div>
  );
}

export interface MissingFieldPlaceholderProps {
  fieldName: string;
}

export function MissingFieldPlaceholder({ fieldName }: MissingFieldPlaceholderProps) {
  return (
    <span
      data-testid="mc-missing-field-placeholder"
      className="font-mono text-[10px] text-amber-700"
      title={`该字段在此工作组的后台服务版本上不可用`}
    >
      {fieldName}：该字段在此工作组的后台服务版本上不可用
    </span>
  );
}

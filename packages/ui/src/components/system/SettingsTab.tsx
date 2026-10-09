// 用户设置 v0 —— 系统抽屉设置标签页。
//
// v0 三个部分：工作区、文件、进度。每个设置显示解析后的值 + 来源
//（env / file / default）+ 默认值。操作者通过内联表单按键设置；
// 初始化工作区按钮 + 每个设置的重置按钮。
//
// 保持这个读写表面小。CLI（`zrig config get/set/reset`）是规范的
// 智能体编辑路径。

import { useState, type ReactNode } from "react";
import {
  useSettings,
  useSetSetting,
  useResetSetting,
  useInitWorkspace,
  type SettingsKey,
  type ResolvedSetting,
} from "../../hooks/useSettings.js";

interface SettingsRowProps {
  label: string;
  settingKey: SettingsKey;
  resolved: ResolvedSetting;
  testIdPrefix: string;
}

function SettingsRow({ label, settingKey, resolved, testIdPrefix }: SettingsRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(resolved.value ?? ""));
  const [error, setError] = useState<string | null>(null);
  const setMutation = useSetSetting();
  const resetMutation = useResetSetting();

  const isOverridden = resolved.source !== "default";

  const onSave = async () => {
    setError(null);
    try {
      await setMutation.mutateAsync({ key: settingKey, value: draft });
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onReset = async () => {
    setError(null);
    try {
      await resetMutation.mutateAsync(settingKey);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div
      data-testid={`${testIdPrefix}-${settingKey}`}
      className="border border-outline-variant/40 bg-surface-lowest/[0.08] px-3 py-2 space-y-1"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-on-surface truncate">{label}</span>
        <span className="font-mono text-[8px] uppercase tracking-[0.10em] text-on-surface-variant shrink-0">
          来源：{resolved.source}
        </span>
      </div>
      {editing ? (
        <div className="space-y-1">
          <input
            data-testid={`${testIdPrefix}-${settingKey}-input`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full border border-outline-variant bg-surface-lowest/80 px-2 py-1 font-mono text-[10px]"
          />
          <div className="flex gap-2">
            <button
              data-testid={`${testIdPrefix}-${settingKey}-save`}
              onClick={() => void onSave()}
              disabled={setMutation.isPending}
              className="font-mono text-[8px] uppercase border border-outline-variant px-2 py-0.5 hover:bg-surface-high disabled:opacity-50"
            >
              保存
            </button>
            <button
              onClick={() => { setEditing(false); setDraft(String(resolved.value ?? "")); setError(null); }}
              className="font-mono text-[8px] uppercase text-on-surface-variant hover:text-on-surface"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-0.5">
          <div className="font-mono text-[10px] text-on-surface break-all">{String(resolved.value ?? "")}</div>
          <div className="font-mono text-[8px] text-on-surface-variant break-all">默认：{String(resolved.defaultValue ?? "")}</div>
          <div className="flex gap-1 pt-1">
            <button
              data-testid={`${testIdPrefix}-${settingKey}-edit`}
              onClick={() => { setEditing(true); setError(null); }}
              className="font-mono text-[8px] uppercase border border-outline-variant px-1 py-0.5 hover:bg-surface-high"
            >
              编辑
            </button>
            {isOverridden && (
              <button
                data-testid={`${testIdPrefix}-${settingKey}-reset`}
                onClick={() => void onReset()}
                disabled={resetMutation.isPending}
                className="font-mono text-[8px] uppercase border border-outline-variant px-1 py-0.5 hover:bg-surface-high disabled:opacity-50"
              >
                重置
              </button>
            )}
          </div>
        </div>
      )}
      {error && <div data-testid={`${testIdPrefix}-${settingKey}-error`} className="font-mono text-[9px] text-red-600">{error}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-on-surface-variant">{title}</div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

export function SettingsTab() {
  const { data, isLoading, error } = useSettings();
  const initWorkspace = useInitWorkspace();
  const [initResult, setInitResult] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  const onInitWorkspace = async () => {
    setInitError(null);
    setInitResult(null);
    try {
      const r = await initWorkspace.mutateAsync({});
      setInitResult(`已初始化于 ${r.root} — 创建了 ${r.subdirs.filter((s) => s.created).length} 个子目录。`);
    } catch (err) {
      setInitError((err as Error).message);
    }
  };

  if (isLoading) {
    return <div data-testid="settings-loading" className="px-4 py-3 font-mono text-[10px] text-on-surface-variant">正在加载设置…</div>;
  }
  if (error || !data) {
    // V1 第 3 阶段尝试 3 回弹修复 A2 —— 柔化失败模式。
    // 已发布的后台服务（npm 包）v0.2.0 尚未暴露 /api/config；
    // 路由在 v0.3.0 落地。渲染诚实的空态指向 CLI
    //（按 useSettings.ts 头部注释的规范编辑路径），而非原始
    // "HTTP 404" 红色错误。
    const errMsg = (error as Error)?.message ?? "";
    const looksLikeMissingEndpoint = errMsg.includes("404");
    return (
      <div
        data-testid="settings-error"
        className="px-4 py-6 font-mono text-xs text-on-surface-variant border border-outline-variant bg-surface-low"
      >
        {looksLikeMissingEndpoint ? (
          <>
            <div className="text-on-surface font-bold uppercase tracking-wide text-[10px] mb-2">
              设置界面需要后台服务 ≥ v0.3.0
            </div>
            <p className="mb-2">
              已发布的后台服务尚未暴露设置 HTTP 路由。在此之前，通过 CLI 配置：
            </p>
            <pre className="font-mono text-[10px] bg-background border border-outline-variant px-2 py-1 inline-block">
              zrig config get / set / reset
            </pre>
          </>
        ) : (
          <>
            <div className="text-on-surface font-bold uppercase tracking-wide text-[10px] mb-2">
              设置不可用
            </div>
            <p>{errMsg || "后台服务不可达。"}</p>
          </>
        )}
      </div>
    );
  }

  const s = data.settings;

  return (
    <div data-testid="settings-tab" className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
      <Section title="工作区">
        <SettingsRow label="工作区根目录" settingKey="workspace.root" resolved={s["workspace.root"]} testIdPrefix="setting" />
        <SettingsRow label="任务/切片根目录" settingKey="workspace.slices_root" resolved={s["workspace.slices_root"]} testIdPrefix="setting" />
        <SettingsRow label="引导文件路径" settingKey="workspace.steering_path" resolved={s["workspace.steering_path"]} testIdPrefix="setting" />
        <SettingsRow label="规格根目录" settingKey="workspace.specs_root" resolved={s["workspace.specs_root"]} testIdPrefix="setting" />
        <SettingsRow label="项目根目录" settingKey="workspace.projects_root" resolved={s["workspace.projects_root"]} testIdPrefix="setting" />
        <SettingsRow label="项目目录" settingKey="workspace.catalog_path" resolved={s["workspace.catalog_path"]} testIdPrefix="setting" />
        <button
          data-testid="settings-init-workspace"
          onClick={() => void onInitWorkspace()}
          disabled={initWorkspace.isPending}
          className="mt-2 font-mono text-[9px] uppercase border border-outline px-2 py-1 hover:bg-surface-high disabled:opacity-50"
        >
          {initWorkspace.isPending ? "正在初始化…" : "初始化工作区"}
        </button>
        {initResult && <div data-testid="settings-init-result" className="font-mono text-[9px] text-on-surface-variant">{initResult}</div>}
        {initError && <div data-testid="settings-init-error" className="font-mono text-[9px] text-red-600">{initError}</div>}
      </Section>

      <Section title="文件（浏览器白名单）">
        <SettingsRow label="白名单 (name:/abs/path,...)" settingKey="files.allowlist" resolved={s["files.allowlist"]} testIdPrefix="setting" />
      </Section>

      <Section title="进度">
        <SettingsRow label="扫描根目录 (name:/abs/path,...)" settingKey="progress.scan_roots" resolved={s["progress.scan_roots"]} testIdPrefix="setting" />
      </Section>

      <Section title="后台服务（旧版）">
        <SettingsRow label="端口" settingKey="daemon.port" resolved={s["daemon.port"]} testIdPrefix="setting" />
        <SettingsRow label="主机" settingKey="daemon.host" resolved={s["daemon.host"]} testIdPrefix="setting" />
      </Section>

      <Section title="数据库 / 转录（旧版）">
        <SettingsRow label="数据库路径" settingKey="db.path" resolved={s["db.path"]} testIdPrefix="setting" />
        <SettingsRow label="启用转录" settingKey="transcripts.enabled" resolved={s["transcripts.enabled"]} testIdPrefix="setting" />
        <SettingsRow label="转录路径" settingKey="transcripts.path" resolved={s["transcripts.path"]} testIdPrefix="setting" />
      </Section>
    </div>
  );
}

import { useNavigate } from "@tanstack/react-router";
import { usePackages, type PackageSummary } from "../hooks/usePackages.js";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { WorkspacePage } from "./WorkspacePage.js";

function statusColor(status: string | null): string {
  switch (status) {
    case "applied": return "bg-success";
    case "rolled_back": return "bg-warning";
    case "failed": return "bg-destructive";
    default: return "bg-foreground-muted-on-dark";
  }
}

function statusLabel(status: string | null): string {
  switch (status) {
    case "applied": return "已应用";
    case "rolled_back": return "已回滚";
    case "failed": return "失败";
    default: return "无";
  }
}

function PackageCard({ pkg, onSelect }: { pkg: PackageSummary; onSelect: (id: string) => void }) {
  return (
    <div
      data-testid="package-card"
      role="link"
      tabIndex={0}
      className="card-dark p-spacing-6 mb-spacing-3 cursor-pointer"
      onClick={() => onSelect(pkg.id)}
      onKeyDown={(e) => { if (e.key === "Enter") onSelect(pkg.id); }}
    >
      <div className="flex items-baseline justify-between mb-spacing-2">
        <h3 className="text-headline-md uppercase">{pkg.name}</h3>
        <span className="text-label-md font-mono text-foreground-muted-on-dark">v{pkg.version}</span>
      </div>

      {pkg.summary && (
        <p className="text-body-sm text-foreground-muted-on-dark mb-spacing-4">{pkg.summary}</p>
      )}

      <div className="flex items-center gap-spacing-4 text-label-sm">
        <span className="text-foreground-muted-on-dark">
          来源 <span className="font-mono text-foreground-on-dark">{pkg.sourceRef}</span>
        </span>
      </div>

      <div className="flex items-center gap-spacing-4 mt-spacing-3 text-label-sm">
        <span className="text-foreground-muted-on-dark">
          安装次数 <span className="font-mono text-foreground-on-dark" data-testid="install-count">{pkg.installCount}</span>
        </span>

        <span className="flex items-center gap-spacing-1">
          <span className={cn("inline-block w-[6px] h-[6px]", statusColor(pkg.latestInstallStatus))} />
          <span className="text-foreground-muted-on-dark" data-testid="install-status">
            {statusLabel(pkg.latestInstallStatus)}
          </span>
        </span>
      </div>
    </div>
  );
}

export function PackageList() {
  const navigate = useNavigate();
  const { data: packages, isPending, error } = usePackages();
  const sortedPackages = packages
    ? [...packages].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : [];

  // 加载态
  if (isPending) {
    return (
      <WorkspacePage>
      <div data-testid="packages-loading">
        <div className="flex justify-between mb-spacing-6">
          <div className="h-8 w-32 shimmer" />
          <div className="h-8 w-28 shimmer" />
        </div>
        {[1, 2].map((i) => (
          <div key={i} className="card-dark p-spacing-6 mb-spacing-3">
            <div className="h-6 w-48 shimmer-dark mb-spacing-4" />
            <div className="h-12 shimmer-dark mb-spacing-4" />
            <div className="h-4 w-64 shimmer-dark" />
          </div>
        ))}
      </div>
      </WorkspacePage>
    );
  }

  // 错误态
  if (error) {
    return (
      <WorkspacePage>
      <div>
        <Alert data-testid="packages-error">
          <AlertDescription>加载旧版包失败：{error.message}</AlertDescription>
        </Alert>
      </div>
      </WorkspacePage>
    );
  }

  // 空态
  if (sortedPackages.length === 0) {
    return (
      <WorkspacePage>
      <div className="flex flex-col items-center justify-center min-h-[60vh]" data-testid="packages-empty">
        <h2 className="text-display-lg text-foreground mb-spacing-4">暂无旧版包安装</h2>
        <p className="text-body-md text-foreground-muted mb-spacing-8">
          在资料库成为主要创作界面的同时，旧版包工具仍保留，供引导等内部流程使用。
        </p>
        <div className="flex flex-col items-center gap-spacing-3">
          <Button
            variant="default"
            size="lg"
            data-testid="empty-import-btn"
            onClick={() => navigate({ to: "/import" })}
          >
            导入 RigSpec
          </Button>
          <Button
            variant="ghost"
            size="lg"
            data-testid="empty-bootstrap-btn"
            onClick={() => navigate({ to: "/bootstrap" })}
          >
            引导初始化
          </Button>
        </div>
      </div>
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
    <div>
      {/* 页头 */}
      <div className="flex justify-between items-baseline mb-spacing-6">
        <div>
          <h2 className="text-headline-lg uppercase">旧版包工具</h2>
          <p className="text-label-md text-foreground-muted font-grotesk mt-spacing-1">
            保留 {sortedPackages.length} 个旧版包安装，用于引导等内部流程
          </p>
        </div>
        <div className="flex flex-col items-end gap-spacing-2">
          <Button
            variant="default"
            size="sm"
            data-testid="header-import-btn"
            onClick={() => navigate({ to: "/import" })}
          >
            导入 RigSpec
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="header-bootstrap-btn"
            onClick={() => navigate({ to: "/bootstrap" })}
          >
            引导初始化
          </Button>
        </div>
      </div>

      {sortedPackages.map((pkg) => (
        <PackageCard
          key={pkg.id}
          pkg={pkg}
          onSelect={(id) => navigate({ to: "/packages/$packageId", params: { packageId: id } })}
        />
      ))}
    </div>
    </WorkspacePage>
  );
}

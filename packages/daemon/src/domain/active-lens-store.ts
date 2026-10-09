// 规格库工作流 + 激活视角 v0——活动视角持久化。
//
// PRD 第 4 项：视角选择持久化在后台服务侧，跨后台服务重启和浏览器刷新保留。
// PRD 的退回条件明确拒绝临时状态。
//
// 实现：使用 OPENRIG_HOME/active-workflow-lens.json 小型 JSON 文件。
// 与 UI Enhancement Pack v0 的 file-edit-audit JSONL 使用同样的环境变量感知
// 持久化模式——不新增 SQLite 表，也不新增迁移。每次 set 都原子重写文件，
// 避免并发后台服务（单主机 MVP 中很少见）读到残缺内容。
//
// 单活动视角不变量：设置视角会替换此前视角；清除则完整删除文件。存储层不校验
// 指定的 workflow_spec 是否确实存在于 workflow_specs 缓存中——这是上游路由层
// 的职责，因为规格可能在工作区表面对账期间暂时未缓存，并在下次读取前重新出现。

import * as fs from "node:fs";
import * as path from "node:path";

export interface ActiveLens {
  specName: string;
  specVersion: string;
  /** 最近一次激活的 ISO 时间戳；用于诊断和 UI 陈旧状态展示。 */
  activatedAt: string;
}

export interface ActiveLensStoreOpts {
  /** 绝对文件路径。应位于后台服务的 OPENRIG_HOME 下，使视角按主机隔离。 */
  filePath: string;
  /** 测试接缝——默认为 () => new Date()。 */
  now?: () => Date;
}

export class ActiveLensStore {
  private readonly filePath: string;
  private readonly now: () => Date;

  constructor(opts: ActiveLensStoreOpts) {
    this.filePath = opts.filePath;
    this.now = opts.now ?? (() => new Date());
  }

  get(): ActiveLens | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ActiveLens>;
      if (typeof parsed.specName !== "string" || typeof parsed.specVersion !== "string") return null;
      return {
        specName: parsed.specName,
        specVersion: parsed.specVersion,
        activatedAt: typeof parsed.activatedAt === "string" ? parsed.activatedAt : this.now().toISOString(),
      };
    } catch {
      // 畸形文件视为无活动视角；操作人员可用 `rm` 恢复。
      return null;
    }
  }

  set(specName: string, specVersion: string): ActiveLens {
    const lens: ActiveLens = {
      specName,
      specVersion,
      activatedAt: this.now().toISOString(),
    };
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    // 近似原子：先写临时文件再重命名。v0 不执行 fsync（视角属于操作体验状态，
    // 不是审计记录不变量；硬崩溃时丢失可以接受，操作人员重新点击激活即可）。
    const tmp = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(lens));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* 尽力清理 */ }
      throw err;
    }
    return lens;
  }

  clear(): void {
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // 已不存在——无需操作。
    }
  }
}

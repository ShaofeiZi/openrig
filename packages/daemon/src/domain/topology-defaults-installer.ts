import * as fs from "node:fs";
import * as nodePath from "node:path";

/**
 * OPR.0.5.3.6——随产品交付的拓扑 chain-file 默认值（CE-v2 产品化）。
 *
 * 工作组 spec 可携带包含合理默认 chain file 的 `topology/` 文件夹。
 * 工作组启动时，它们安装到类型化 `topology.root` 下
 *（见单一事实来源 docs/reference/chain-file-convention.md），分为四个层级：
 *
 *   <spec>/topology/instance/<NAME>.md      -> <topology.root>/<NAME>.md
 *   <spec>/topology/rig/<NAME>.md           -> <topology.root>/rigs/<rig>/<NAME>.md
 *   <spec>/topology/pods/<pod>/<NAME>.md    -> <topology.root>/rigs/<rig>/pods/<pod>/<NAME>.md
 *   <spec>/topology/seats/<seat>/<NAME>.md  -> <topology.root>/rigs/<rig>/seats/<seat>/<NAME>.md
 *
 * 仅在不存在时复制，绝不覆盖：随产品交付的默认值是入驻团队继续追加的起点，
 * 后续工作组启动绝不能覆盖已经积累的上下文。安装按文件尽力而为（工作组启动绝不因
 * 默认文件复制失败而失败），但每次跳过/安装都会报告，使调用方如实记录而不静默处理。
 */
export interface TopologyDefaultsResult {
  installed: string[];
  /** 目标已存在；随产品交付的默认值未覆盖它。 */
  preserved: string[];
  /** 明确记录的读写失败（尽力而为契约：绝不抛错）。 */
  failed: Array<{ path: string; error: string }>;
  /** spec 完全未携带 topology/ 文件夹时为 true；这是正常情况。 */
  none: boolean;
}

export interface TopologyDefaultsFsOps {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  listFiles(dir: string): string[];
  listDirs(dir: string): string[];
  read(path: string): string;
  write(path: string, content: string): void;
  mkdirp(dir: string): void;
}

const realFsOps: TopologyDefaultsFsOps = {
  exists: (p) => fs.existsSync(p),
  isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  listFiles: (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name),
  listDirs: (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
  read: (p) => fs.readFileSync(p, "utf-8"),
  write: (p, c) => fs.writeFileSync(p, c, "utf-8"),
  mkdirp: (d) => { fs.mkdirSync(d, { recursive: true }); },
};

export function installTopologyDefaults(input: {
  /** 工作组 spec 的目录（rigRoot）；`topology/` 在其下解析。 */
  specDir: string;
  rigName: string;
  /** 已声明的 pod 命名空间；即使没有默认文件，其规范目录也会存在。 */
  podIds?: string[];
  topologyRoot: string;
  fsOps?: TopologyDefaultsFsOps;
}): TopologyDefaultsResult {
  const ops = input.fsOps ?? realFsOps;
  const result: TopologyDefaultsResult = { installed: [], preserved: [], failed: [], none: false };
  const topologyDir = nodePath.join(input.specDir, "topology");

  const ensureDir = (dir: string): void => {
    try {
      ops.mkdirp(dir);
    } catch (err) {
      result.failed.push({ path: dir, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // S7：这些目录是引擎对实时拓扑的投影，不是编写的默认值。每次物化都创建它们，
  // 包括完全没有 topology/ 源文件夹的 spec。
  ensureDir(input.topologyRoot);
  ensureDir(nodePath.join(input.topologyRoot, "rigs", input.rigName));
  for (const podId of input.podIds ?? []) {
    ensureDir(nodePath.join(input.topologyRoot, "rigs", input.rigName, "pods", podId));
  }

  // r2 遗留项：整体绝不抛错契约没有首行例外；即使根探测失败，也必须明确记录为失败，
  // 不能抛错，也不能标为 `none`。
  try {
    if (!ops.isDirectory(topologyDir)) {
      result.none = true;
      return result;
    }
  } catch (err) {
    result.failed.push({ path: topologyDir, error: err instanceof Error ? err.message : String(err) });
    return result;
  }

  const copyIfAbsent = (src: string, dest: string): void => {
    try {
      if (ops.exists(dest)) {
        result.preserved.push(dest);
        return;
      }
      const content = ops.read(src);
      ops.mkdirp(nodePath.dirname(dest));
      ops.write(dest, content);
      result.installed.push(dest);
    } catch (err) {
      result.failed.push({ path: dest, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // r2-B2：尽力而为契约覆盖全部路径。枚举失败（listFiles/listDirs 的 EACCES/EIO）
  // 会作为 section 目录上的明确失败记录，绝不抛错；一个 section 被拒绝也不会阻断其他 section。
  // 原实现把 for 头放在 catch 外，导致目录权限失败在持久化事务之后逸出，
  // 把已提交的物化变成 materialize_error。
  const section = (dir: string, body: () => void): void => {
    try {
      body();
    } catch (err) {
      result.failed.push({ path: dir, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const instanceDir = nodePath.join(topologyDir, "instance");
  section(instanceDir, () => {
    if (!ops.isDirectory(instanceDir)) return;
    for (const name of ops.listFiles(instanceDir)) {
      copyIfAbsent(nodePath.join(instanceDir, name), nodePath.join(input.topologyRoot, name));
    }
  });

  const rigDir = nodePath.join(topologyDir, "rig");
  section(rigDir, () => {
    if (!ops.isDirectory(rigDir)) return;
    for (const name of ops.listFiles(rigDir)) {
      copyIfAbsent(nodePath.join(rigDir, name), nodePath.join(input.topologyRoot, "rigs", input.rigName, name));
    }
  });

  const podsDir = nodePath.join(topologyDir, "pods");
  for (const podId of input.podIds ?? []) {
    const podDir = nodePath.join(podsDir, podId);
    section(podDir, () => {
      if (!ops.isDirectory(podDir)) return;
      for (const name of ops.listFiles(podDir)) {
        copyIfAbsent(
          nodePath.join(podDir, name),
          nodePath.join(input.topologyRoot, "rigs", input.rigName, "pods", podId, name),
        );
      }
    });
  }

  const seatsDir = nodePath.join(topologyDir, "seats");
  section(seatsDir, () => {
    if (!ops.isDirectory(seatsDir)) return;
    for (const seat of ops.listDirs(seatsDir)) {
      section(nodePath.join(seatsDir, seat), () => {
        for (const name of ops.listFiles(nodePath.join(seatsDir, seat))) {
          copyIfAbsent(
            nodePath.join(seatsDir, seat, name),
            nodePath.join(input.topologyRoot, "rigs", input.rigName, "seats", seat, name),
          );
        }
      });
    }
  });

  return result;
}

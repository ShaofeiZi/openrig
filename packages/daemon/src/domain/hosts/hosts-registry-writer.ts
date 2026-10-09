// OPR.0.4.6.MH1 FR-5/FR-6——后台服务侧 hosts-registry WRITE 镜像
//（架构 B1 裁定，固定 P1–P4）。
//
// 浏览器界面无法访问 CLI 的文件系统代码，因此 dashboard 的 add/pair 路径通过本模块写入。
// 本模块刻意逐字镜像 packages/cli/src/host-registry.ts 的 addHostEntry，并由
// packages/daemon/test/hosts-add-pair-routes.test.ts 固定字节级一致性（输入相同 entry，输出
// 相同 YAML 字节；P3）。它还复用 reader 镜像的 validateHostRegistry，确保校验完全一致：
// 最多一个 bearer；无 token 后台服务可不填 bearer，但不能两者都填；保留 id 与重复 id 也按
// 同一规则处理（P3）。reader 模块永久保持只读；所有写入只能经过这份固定 parity 的写契约
//（CLI addHostEntry + 本镜像）。后台服务侧仅由具名的窄 add/pair 路由触达（P1，不存在通用
// registry-write 路由）。
//
// 并发（P4）：使用原子 tmp+rename；并发 add 时整文件 LAST-WRITE-WINS。设计上限是一份操作员
// 规模的 registry 文件，因此刻意不引入锁。两个同时 add 可能丢掉一个 entry；重新执行 add 即可
// 再次收敛（add 时校验与 load 时校验逐字一致）。

import { existsSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  defaultHostRegistryPath,
  loadHostRegistry,
  validateHostRegistry,
  type HostEntry,
} from "./hosts-registry-reader.js";

export type AddHostResult =
  | { ok: true; path: string; entry: HostEntry }
  | { ok: false; error: string };

export function addHostEntry(rawEntry: Record<string, unknown>, path: string = defaultHostRegistryPath()): AddHostResult {
  // 先加载现有内容。文件缺失是 `add` 的合法起点（该动词就是为了避免操作员手建 YAML）；
  // 但文件存在且无效时必须显式报错，绝不能静默覆盖操作员状态。
  let existing: HostEntry[] = [];
  if (existsSync(path)) {
    const loaded = loadHostRegistry(path);
    if (!loaded.ok) {
      return { ok: false, error: `拒绝修改无效的主机注册表：${loaded.error}` };
    }
    existing = loaded.registry.hosts;
  }

  const candidate = { hosts: [...existing, rawEntry] };
  const validated = validateHostRegistry(candidate, path);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  const entry = validated.registry.hosts[validated.registry.hosts.length - 1]!;

  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.hosts.yaml.tmp-${process.pid}`);
    writeFileSync(tmp, stringifyYaml({ hosts: validated.registry.hosts }), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    return { ok: false, error: `写入主机注册表 ${path} 失败：${(err as Error).message}` };
  }
  return { ok: true, path, entry };
}

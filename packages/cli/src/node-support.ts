// `rig doctor` 和 `rig preflight` 共用的 Node.js 支持策略。
// 必须与 scripts/check-abi.mjs 中的 postinstall 守卫保持一致（有测试将两者
// 绑定在一起）：支持 22 和 24，拒绝 22 以下和奇数大版本，
// 24 以上的偶数大版本允许但未经测试。

export const SUPPORTED_NODE_MAJORS = [22, 24] as const;

export type NodeSupportKind = "supported" | "too_old" | "odd" | "untested";

export interface NodeSupport {
  major: number;
  kind: NodeSupportKind;
  /** 一行说明，除 "supported" 外每种类型都有。 */
  message?: string;
  reason?: string;
  fix?: string;
}

const FIX = "通过 nvm、fnm 或你的包管理器安装 Node 22 或 24，然后重新安装 @openrig/cli。";

export function classifyNodeVersion(version: string): NodeSupport {
  const match = version.match(/^v?(\d+)/);
  const major = match ? parseInt(match[1]!, 10) : 0;

  if ((SUPPORTED_NODE_MAJORS as readonly number[]).includes(major)) {
    return { major, kind: "supported" };
  }
  if (major < SUPPORTED_NODE_MAJORS[0]) {
    return {
      major,
      kind: "too_old",
      message: `Node ${version} 不受支持（需要 Node.js 22 或 24）。`,
      reason: "zrig 支持 Node.js 22 和 24。其 SQLite 绑定（better-sqlite3 13）需要 Node 22 或更新版本，在 Node 20 上会崩溃。",
      fix: FIX,
    };
  }
  if (major % 2 !== 0) {
    return {
      major,
      kind: "odd",
      message: `Node ${version} 是奇数版本号，不受支持。`,
      reason: "zrig 支持 Node.js 22 和 24（LTS）。奇数版本号不受支持。",
      fix: FIX,
    };
  }
  return {
    major,
    kind: "untested",
    message: `Node ${major} 尚未在 zrig 上测试。支持版本：Node.js 22 和 24（LTS）。`,
  };
}

// 51-04 testbed 镜像——可复现 MANIFEST 生成器（计划 §1 + §3）。
//
// manifest 是 51-02 runner 与 51-05 矩阵每次运行都引用的持久身份（清点收据纪律）：
// 基础镜像 digest、node 版本、构建镜像所用的 openrig sha，以及 stub 资产哈希。
// 重建契约：相同输入 => 字节一致的 manifest + digest，使不同镜像版本的运行可比较。
// 构建命令（scripts/build-testbed-image.sh 那一族）从源码树 + docker 构建计算出这些输入，
// 再调用本模块发出 manifest——特意保持为一个无依赖的纯辅助模块，以便在 VM 里
// （node:test）封闭单测，符合 scripts/ 的目录惯例。
//
// 内容摘要取在“规范化排序键 JSON”之上，绝不是朴素的字段拼接：某个字段值里嵌入的分隔符
// 不可能伪造出另一组合法输入的摘要（hash-join-delimiter-forgery）。JSON 转义保证不同输入一定不同。

import { createHash } from "node:crypto";

/** 响亮、带类型的失败——缺失/非法的身份输入必须失败，绝不能静默产出一份看似构建正常、
 *  却漏掉身份字段的半成品 manifest。 */
export class TestbedManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "TestbedManifestError";
  }
}

/** 镜像名前缀（计划 §1：`openrig-testbed:<git-sha>`）。 */
export const TESTBED_IMAGE_NAME = "openrig-testbed";

/** manifest schema id——仅在 manifest 结构发生破坏性变更时才递增。 */
export const TESTBED_MANIFEST_SCHEMA = "openrig-testbed-manifest/v1";

/** 定义一次 testbed 镜像构建的身份字段（全部必填、全部非空）。 */
const IDENTITY_FIELDS = ["baseDigest", "nodeVersion", "openrigSha", "stubAssetsHash", "gitSha"];

/** 递归排序键的确定性 JSON——摘要所取的字节稳定形式（条目相同的两个对象，无论键插入顺序如何，
 *  序列化结果一致）。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** 从身份输入计算可复现的 testbed 镜像 manifest。 */
export function computeTestbedManifest(inputs) {
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new TestbedManifestError("testbed manifest inputs must be an object");
  }
  const identity = {};
  for (const field of IDENTITY_FIELDS) {
    const raw = inputs[field];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new TestbedManifestError(`testbed manifest input '${field}' is required (non-empty string)`);
    }
    identity[field] = raw;
  }

  // 被摘要的载荷是 schema + 各身份字段（不含摘要本身）。取在规范化 JSON 上，
  // 使摘要与键序无关且抗伪造。
  const digested = { schema: TESTBED_MANIFEST_SCHEMA, ...identity };
  const manifestDigest = createHash("sha256").update(canonicalJson(digested), "utf8").digest("hex");

  return {
    schema: TESTBED_MANIFEST_SCHEMA,
    image: `${TESTBED_IMAGE_NAME}:${identity.gitSha}`,
    ...identity,
    manifestDigest,
  };
}

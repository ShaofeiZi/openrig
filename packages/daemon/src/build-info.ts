// OPR.0.4.4.11 FR-6——后台服务的构建身份模块。
//
// 此已提交文件是诚实的开发占位实现：源码/开发运行没有 stamp，并将身份字段报告为缺失，绝不
// 捏造 SHA（FR-7 反向验收标准）。scripts/build-package.sh 在打包时只计算一次 stamp（架构裁定
// 6），并用真实值覆盖每个包中已编译的对应文件（dist/build-info.js）；运行时不跨包导入，
// CLI 携带自己的生成孪生。

export interface BuildInfo {
  semver: string | null;
  commit: string | null;
  dirty: boolean | null;
  builtAt: string | null;
}

export const BUILD_INFO: BuildInfo = {
  semver: null,
  commit: null,
  dirty: null,
  builtAt: null,
};

/** 增量 /healthz 字段：有 stamp 时为四个 stamp key，开发环境时为空对象——现有消费者
 *（包括针对开发后台服务的精确正文探针）看不到变化。 */
export function stampFields(info: BuildInfo = BUILD_INFO): Record<string, unknown> {
  if (!info.commit) return {};
  return { semver: info.semver, commit: info.commit, dirty: info.dirty, builtAt: info.builtAt };
}

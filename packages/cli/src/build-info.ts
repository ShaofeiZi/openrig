// OPR.0.4.4.11 FR-6 —— CLI 的构建身份模块。
//
// 提交到仓库的是开发占位：未盖戳的运行会如实报告身份缺失，绝不伪造提交 SHA。
// scripts/build-package.sh 在打包时计算一次戳记，并覆盖编译产物（dist/build-info.js）；
// 这是 CLI 自己持有的、与 daemon 模块对应的孪生模块（架构裁决 6：每包自持模块，
// 不在运行时跨包导入）。

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

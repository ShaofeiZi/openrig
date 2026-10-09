// Slice-04（OPR.0.5.0.4）——ProviderService 接缝。路由（接缝 B）是此 interface 上的轻量层；
// 真实实现（从 rig auth + seat registry + 三条 lane 收集、switch 组合 + action 记录）位于接缝 C/D。
// 保持 interface 形态，使路由可以注册，并在生产 service 接入前如实返回 503。

import type { FourBlockReadModel, PrecheckResult } from "./provider-types.js";

export interface ProviderPrecheckInput {
  seat: string;
  toAccount: string;
}

export interface ProviderSwitchInput {
  seat: string;
  toAccount: string;
  forceUnsafe: boolean;
}

/**
 * 通过类型强制 BR-1 失败可见性的 discriminated union：`succeeded`/`rebind_in_progress` 不携带
 * reason；`failed_safely` 要求非空 reason tuple——没有解释的 switch failure 无法通过编译。
 * reason 为 string[]，使接缝 D 除 PrecheckReason 拒绝外，还能呈现操作失败（auth switch failure、
 * 操作记录失败）。
 */
export type ProviderSwitchResult =
  | { outcome: "succeeded" }
  | { outcome: "rebind_in_progress" }
  | { outcome: "failed_safely"; reasons: [string, ...string[]] };

export interface ProviderService {
  /** 唯一 four-block read model；过滤后的 block 路由是它的 projection。 */
  getReadModel(): Promise<FourBlockReadModel>;
  /** 调用时解析 target/seat state（使用时校验），并返回 safety verdict。 */
  precheck(input: ProviderPrecheckInput): Promise<PrecheckResult>;
  /** 受 precheck gate 控制的 switch；返回显式业务 outcome（绝不是 transport error）。 */
  switchAccount(input: ProviderSwitchInput): Promise<ProviderSwitchResult>;
}

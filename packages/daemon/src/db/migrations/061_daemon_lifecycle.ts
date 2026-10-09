import type { Migration } from "../migrate.js";

/**
 * P7 shutdown-record——后台服务自身的生命周期记录（started/last-seen/stopped），
 * 与身份记录（059 self_host_identity）分离。
 *
 * 架构裁定 d6a6c1db（FLAG-1）：使用全新独立表，而不是在 self_host_identity 上加列——身份与
 * 生命周期在类型和写入节奏上分离（每个 tick 的高频 heartbeat UPDATE 不得扰动 alignment 断言
 * 与 gateway 读取所查询的身份行映像）。每个关注点有唯一归属。（编号：裁定时 060 是下一个空位，
 * 但已被进行中的 tenure-ledger 线路占用；P7 使用 061——独立表语义才是裁定，编号只是偶然。
 * 位于 059_self_host_identity/060_<tenure-ledger> 之后。）
 *
 * 带 boot_epoch 的单例：新启动铸造新 epoch、设置 started_at 并清除 stopped_at；未停止期间
 * heartbeat 推进 last_heartbeat_at；正常关闭设置 stopped_at（每个 epoch 的终态）。渲染按 epoch
 * 设防，因此绝不会在新 epoch 显示上次运行的陈旧 stopped_at。逐 epoch 行历史是构建者选项；
 * 最小实现是此单例。
 */
export const daemonLifecycleSchema: Migration = {
  name: "061_daemon_lifecycle.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS daemon_lifecycle (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      boot_epoch TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_heartbeat_at TEXT,
      stopped_at TEXT
    );
  `,
};

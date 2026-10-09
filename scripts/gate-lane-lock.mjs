import net from "node:net";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * F1 gate-lane 互斥锁（arch d6a6c1db；机制 (B) 绑定本地回环端口，经 arch 批准，含 5 条绑定约束）。
 * arch 的理由是这个“性质”，而非具体系统调用：一个机器级的、进程死亡即由内核释放的、
 * 非阻塞互斥锁，且没有“残留锁”这一类问题。绑定一个本地回环端口即可同时满足这三点
 * （持锁进程死亡时内核释放端口；EADDRINUSE 是一次即时的非阻塞探测 = LOCK_NB），
 * 且零原生依赖。（记录在案：曾否决 Unix socket 绑定——socket 文件在 kill -9 后仍残留 = 残留制品。）
 *
 * 5 条约束：
 *  P1 —— 显式绑定 127.0.0.1（见下）。
 *  P2 —— 排他性是承重设计：绝不设置 SO_REUSEPORT（从不设置；node 默认 listen 也不设置），
 *         因此第二个并发绑定必须失败——一旦有 REUSEPORT，互斥锁就悄悄失效。有护栏测试守护。
 *  P3 —— 端口号本身就是锁名：一个命名常量、一个家目录（见下 GATE_LANE_PORT）。
 *  P4 —— 持锁者信息文件只用于“命名”：在绑定成功之后才写（绑定前写就等于走后门实现了
 *         选项 C——pid-file 锁），尽力读取/清理，绝不参与锁的“决策”（绑定即决策；仅凭 EADDRINUSE 拒绝）。
 *  P5 —— 对外来占用者诚实（由 runner 呈现）：存在持锁者信息 → 报出 pid/started-at；
 *         缺失 → 诚实标注未知；两者都指出端口常量；始终硬拒绝，绝不自动覆盖。
 */

/** P3 —— 唯一的命名锁：端口号即锁名（固定值，来自配置）。 */
export const GATE_LANE_PORT = Number.parseInt(process.env.OPENRIG_GATE_LANE_PORT ?? "40404", 10);

/**
 * @returns {Promise<{ok:true, release:()=>Promise<void>} | {ok:false, reason:"gate-holder"|"foreign-holder"|"bind-error", holder?:{pid:number,startedAt:string}, message?:string}>}
 */
export async function acquireGateLane({ port = GATE_LANE_PORT, holderInfoPath }) {
  // P1 + P2：显式绑定 127.0.0.1；不要传 reusePort——排他性就是这把互斥锁。
  const server = net.createServer();
  const bound = await new Promise((resolve) => {
    server.once("error", (err) => resolve({ ok: false, err }));
    server.listen(port, "127.0.0.1", () => resolve({ ok: true }));
  });

  if (!bound.ok) {
    if (bound.err?.code !== "EADDRINUSE") {
      return { ok: false, reason: "bind-error", message: String(bound.err?.message ?? bound.err) };
    }
    // 端口被占。持锁者会经持锁者信息文件自我声明；其他任何情况都是外来负载
    // → 失败关闭（绝不在未知负载旁边跑 gate lane）。
    if (existsSync(holderInfoPath)) {
      try {
        const holder = JSON.parse(readFileSync(holderInfoPath, "utf8"));
        if (holder && typeof holder.pid === "number" && typeof holder.startedAt === "string") {
          return { ok: false, reason: "gate-holder", holder };
        }
      } catch { /* 信息损坏 → 当作外来占用，失败关闭 */ }
    }
    return { ok: false, reason: "foreign-holder" };
  }

  // P4：绑定即锁。仅为“命名”尽力登记持锁者——持锁者信息写入失败
  // 绝不能让已拿到的 lane 丢失（ contending 的闸门随后只会看到诚实的“未知”）。
  try {
    mkdirSync(dirname(holderInfoPath), { recursive: true });
    writeFileSync(holderInfoPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch { /* 仅用于命名，尽力即可 */ }
  const release = () =>
    new Promise((resolve) => {
      try { unlinkSync(holderInfoPath); } catch { /* 尽力清理 */ }
      server.close(() => resolve());
    });
  return { ok: true, release };
}

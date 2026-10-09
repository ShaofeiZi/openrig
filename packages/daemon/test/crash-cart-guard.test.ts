import { describe, it, expect, vi } from "vitest";
import { assertDaemonDown, DaemonLiveError } from "../src/domain/crash-cart-discovery.js";

// Crash-cart C2——关闭失败守卫（架构 a1344201 Q1）。仅当没有后台服务存活时，daemon-down
// 直接读取才安全：存活的写入者会让副本产生竞态；更重要的是，crash-cart 绝不能与其负责恢复的
// 进程争用。因此，只要记录的 pid 存活或 /healthz 探针有响应（遵循 OPENRIG_URL），守卫就会拒绝；
// 两者都必须为否才能继续。遵循与 51-02 env-helper 拒绝外部后台服务相同的关闭失败与密闭性纪律。
// 所有探针均可注入，因此测试保持密闭。

const noDaemonJson = () => undefined;
const deadPid = () => false;
const silentHealthz = async () => false;

function deps(over: Partial<Parameters<typeof assertDaemonDown>[0]> = {}) {
  return {
    openrigHome: "/scratch/.openrig",
    readDaemonJson: noDaemonJson,
    isProcessAlive: deadPid,
    probeHealthz: silentHealthz,
    openrigUrl: undefined as string | undefined,
    ...over,
  };
}

describe("assertDaemonDown——直接读取的关闭失败守卫", () => {
  it("没有 daemon.json、没有 OPENRIG_URL 且默认 healthz 无响应时通过", async () => {
    const probeHealthz = vi.fn(silentHealthz);
    await expect(assertDaemonDown(deps({ probeHealthz }))).resolves.toBeUndefined();
    // 即使没有状态文件，也会先探测默认 control-plane 地址，再相信“已停止”。
    expect(probeHealthz).toHaveBeenCalledWith("http://127.0.0.1:7433/healthz");
  });

  it("daemon.json 记录的 pid 仍存活时拒绝（绝不复制仍在写入的 WAL）", async () => {
    await expect(
      assertDaemonDown(
        deps({
          readDaemonJson: () => ({ pid: 4242, port: 7433, host: "127.0.0.1", db: "/x/openrig.sqlite" }),
          isProcessAlive: (pid) => pid === 4242,
        }),
      ),
    ).rejects.toBeInstanceOf(DaemonLiveError);
  });

  it("即使 pid 看似死亡，只要 /healthz 探针有响应就拒绝（卡死或外部后台服务）", async () => {
    const probeHealthz = vi.fn(async (url: string) => url.includes("7433"));
    await expect(
      assertDaemonDown(
        deps({
          readDaemonJson: () => ({ pid: 9, port: 7433, host: "127.0.0.1", db: "/x/openrig.sqlite" }),
          isProcessAlive: deadPid,
          probeHealthz,
        }),
      ),
    ).rejects.toBeInstanceOf(DaemonLiveError);
  });

  it("存在状态文件时探测 daemon.json 的 host:port，而不只探测默认地址", async () => {
    const probeHealthz = vi.fn(silentHealthz);
    await assertDaemonDown(
      deps({
        readDaemonJson: () => ({ pid: 9, port: 9999, host: "10.0.0.5", db: "/x/openrig.sqlite" }),
        isProcessAlive: deadPid,
        probeHealthz,
      }),
    );
    expect(probeHealthz).toHaveBeenCalledWith("http://10.0.0.5:9999/healthz");
  });

  it("遵循 OPENRIG_URL：绕过状态文件探测该地址，并在有响应时拒绝", async () => {
    const probeHealthz = vi.fn(async (url: string) => url.startsWith("http://foreign"));
    await expect(
      assertDaemonDown(deps({ openrigUrl: "http://foreign-daemon:8080", probeHealthz })),
    ).rejects.toBeInstanceOf(DaemonLiveError);
    expect(probeHealthz).toHaveBeenCalledWith("http://foreign-daemon:8080/healthz");
  });
});

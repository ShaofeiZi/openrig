import fs from "node:fs";
import path from "node:path";

export interface DaemonStartLock {
  recordChild(pid: number): void;
  release(preserve?: boolean): void;
}

/** 每次受支持的本地启动都独占“绑定前初始化”直到发布完成。
 * ponytail：不做基于年龄的接管——一个死掉的启动器可能留下一个存活但未绑定的子进程。
 * 硬崩溃恢复会在归档本文件之前先检查记录在案的 PID。 */
export function acquireDaemonStartLock(home: string): DaemonStartLock {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "daemon-start.lock");
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`后台服务启动已被占用：${file}。请检查其记录的启动器/子进程 PID、daemon.json 与 daemon.log。若该启动已被遗弃，请先确认这两个进程都已不存在，再归档该占用并重试；本次未拉起任何子进程。`);
  }
  const identity = fs.fstatSync(fd);
  const release = (preserve = false): void => {
    try {
      if (!preserve) {
        const current = fs.statSync(file);
        if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(file);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    fs.writeSync(fd, JSON.stringify({ launcherPid: process.pid, startedAt: new Date().toISOString() }) + "\n");
  } catch (error) {
    release();
    throw error;
  }
  return {
    recordChild: (pid) => { fs.writeSync(fd, JSON.stringify({ childPid: pid }) + "\n"); },
    release,
  };
}

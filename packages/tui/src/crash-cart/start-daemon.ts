/** 启动本地实例绝不能在用户选择前静默指向默认后台服务或
 *  启动内核占用者。 */
export function daemonStartArgs(target: string): string[] {
  const url = new URL(target);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("此目标不是本地后台服务端点。在其所有者启动后重新连接；未启动任何本地后台服务。");
  }
  return ["daemon", "start", "--no-kernel", "--host", url.hostname.replace(/^\[|\]$/g, ""),
    "--port", url.port || "80"];
}

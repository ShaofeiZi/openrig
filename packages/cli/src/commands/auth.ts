// OPR.0.4.1.29 —— `rig auth <verb> [--runtime codex]`：CLI 本地、无需后台服务的认证档案管理。
// 按能力分组，runtime 作为正交标志（不是 `rig codex-auth`，也不是 `rig codex` 名词），
// 遵循 conventions/cli-read-command-grammar。这里打印的每一行都只由 secret-safe 库的结构化、
// 非密钥结果字段构成——token 值绝不可能到达 stdout/stderr。
import { Command } from "commander";
import {
  resolveCodexHome,
  authStatus,
  authList,
  authSave,
  authSwitch,
  authValidate,
  authSeatSet,
  authSeatsList,
  authSeatShow,
  authSeatsReport,
  SEAT_REGISTRY_DISCLAIMER,
  type CodexAuthPaths,
} from "../lib/codex-auth.js";

export interface AuthCommandDeps {
  /** 环境变量来源（默认 process.env）——测试把 CODEX_HOME 指向夹具。 */
  env?: NodeJS.ProcessEnv;
  /** 登录状态探测（默认：真实 `codex login status`，只看退出码）。可注入供测试使用。 */
  loginStatus?: (codexHome: string) => "logged_in" | "not_logged_in" | "unavailable";
  /** 给 seats set 的 updated_ts 计时钟（默认 new Date().toISOString()）。 */
  now?: () => string;
}

function fail(reason: string): void {
  console.error(`zrig auth：${reason}`);
  process.exitCode = 1;
}

// MVP 仅支持 --runtime codex。其他 runtime 将来是同一界面、换一个标志；
// 现在对非 codex 给出明确拒绝，而不是静默地把它当 codex 处理。
function ensureRuntime(runtime: string): boolean {
  if (runtime !== "codex") {
    fail(`unsupported_runtime ${runtime}（MVP 支持：codex）`);
    return false;
  }
  return true;
}

export function authCommand(depsOverride?: AuthCommandDeps): Command {
  const env = depsOverride?.env ?? process.env;
  const paths = (): CodexAuthPaths => resolveCodexHome(env);
  const withRuntime = (c: Command): Command => c.option("--runtime <runtime>", "运行时轴（MVP：codex）", "codex");

  const auth = new Command("auth").description(
    "管理智能体认证档案（CLI 本地；运行时通过 --runtime 指定）。token 绝不打印、记录或存储。",
  );

  withRuntime(auth.command("status"))
    .description("认证文件是否存在 + 登录状态（不含密钥）。")
    .action((opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authStatus(paths(), { loginStatus: depsOverride?.loginStatus });
      console.log(`Codex 主目录：${r.codexHome}`);
      console.log(`Codex 主目录存在：${r.codexHomePresent ? "是" : "否"}`);
      console.log(`当前认证存在：${r.activeAuthPresent ? "是" : "否"}`);
      console.log(`当前认证权限：${r.activeAuthMode ?? "不适用"}`);
      console.log(`当前认证权限安全：${r.activeAuthModeSafe}`);
      console.log(`已保存档案：${r.profileCount}`);
      console.log(`登录状态：${r.loginStatus}`);
    });

  withRuntime(auth.command("list"))
    .description("按名称列出已保存的档案。")
    .action((opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      for (const name of authList(paths())) console.log(name);
    });

  withRuntime(auth.command("save <profile>"))
    .description("把当前认证状态快照为命名档案（文件复制；内容绝不回显）。")
    .action((profile: string, opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authSave(paths(), profile);
      if (!r.ok) return fail(r.reason);
      console.log(`已保存档案：${r.name}`);
      console.log(`档案路径：${r.path}`);
      console.log(`档案权限：${r.mode}`);
    });

  withRuntime(auth.command("switch <profile>"))
    .description("激活一个已保存的档案。")
    .action((profile: string, opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authSwitch(paths(), profile);
      if (!r.ok) return fail(r.reason);
      console.log(`已激活档案：${r.name}`);
      console.log(`当前认证：${r.activePath}`);
      console.log(`当前权限：${r.mode}`);
      console.log(`说明：${r.note}`);
    });

  withRuntime(auth.command("validate <profile>"))
    .description("检查档案的文件模式 + JSON 可解析性（不做在线认证）。")
    .action((profile: string, opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authValidate(paths(), profile);
      if (!r.ok) return fail(r.reason);
      console.log(`档案有效：${r.name}`);
      console.log(`档案路径：${r.path}`);
      console.log(`档案权限：${r.mode}`);
      console.log("note：仅检查文件模式 + JSON 可解析性，不检查在线账号状态。");
    });

  const seats = auth.command("seats").description("席位 -> 档案登记表（仅元数据；不证明账号在线）。");

  withRuntime(seats.command("list"))
    .description("列出席位 -> 档案映射。")
    .action((opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      for (const row of authSeatsList(paths())) console.log(`${row.seat}\t${row.authProfile}\t${row.updatedTs}`);
      console.log(`# ${SEAT_REGISTRY_DISCLAIMER}`);
    });

  withRuntime(seats.command("show <seat>"))
    .description("查看某席位的登记表行。")
    .action((seat: string, opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authSeatShow(paths(), seat);
      if (!r.ok) return fail(r.reason);
      console.log(`seat: ${r.row.seat}`);
      console.log(`rig: ${r.row.rig}`);
      console.log(`runtime: ${r.row.runtime}`);
      console.log(`cwd: ${r.row.cwd}`);
      console.log(`认证档案：${r.row.authProfile}`);
      console.log(`更新时间：${r.row.updatedTs}`);
      console.log(`说明：${SEAT_REGISTRY_DISCLAIMER}`);
    });

  withRuntime(seats.command("set"))
    .description("插入或更新一条席位 -> 档案元数据行。")
    .requiredOption("--seat <seat>", "席位会话名")
    .requiredOption("--rig <rig>", "工作组名")
    .option("--cwd <cwd>", "工作目录（元数据）")
    .option("--profile <profile>", "认证档案标签（省略表示未知）")
    .action((opts: { runtime: string; seat?: string; rig?: string; cwd?: string; profile?: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authSeatSet(
        paths(),
        { seat: opts.seat ?? "", rig: opts.rig ?? "", runtime: "codex", cwd: opts.cwd, authProfile: opts.profile },
        depsOverride?.now,
      );
      if (!r.ok) return fail(r.reason);
      console.log(`席位已更新：${r.seat}`);
      console.log(`注册表路径：${r.registryPath}`);
      console.log(`注册表权限：${r.mode}`);
      console.log(`说明：${r.disclaimer}`);
    });

  withRuntime(seats.command("report"))
    .description("统计：总数 / 已知 / 未知 / 格式错误。")
    .action((opts: { runtime: string }) => {
      if (!ensureRuntime(opts.runtime)) return;
      const r = authSeatsReport(paths());
      console.log(`注册表存在：${r.registryPresent ? "是" : "否"}`);
      console.log(`注册表权限：${r.registryMode ?? "不适用"}`);
      console.log(`注册表权限安全：${r.registryModeSafe}`);
      console.log(`席位总数：${r.total}`);
      console.log(`已知档案：${r.known}`);
      console.log(`未知档案：${r.unknown}`);
      console.log(`格式错误行：${r.malformed}`);
      console.log(`# ${SEAT_REGISTRY_DISCLAIMER}`);
    });

  return auth;
}

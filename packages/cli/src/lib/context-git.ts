// Git 负责历史和合并。上下文库服务于显式选择；
// 失败的更新绝不把半合并的检出发布为智能体上下文。
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertDestinationNamespaceContained, assertSafeInstallRef, assertTreeHasNoSymlinks, validateContextPackManifestForInstall } from "./context-install.js";

const RECEIPT = ".openrig-git-source.json";
interface Selection {
  format: 1;
  checkout: string;
  libraryRoot: string;
  pack: string;
  revision: string;
  digest: string;
  selectedAt: string;
}

function git(checkout: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  } catch (err) {
    // Git 的 stderr 可能回显带凭据的远程。绝不导出它。
    const status = (err as { status?: number }).status;
    throw new Error(`git ${args[0]} 失败${status == null ? "或超时" : `（退出码 ${status}）`}。检出保留在 ${checkout}；请用你现有的凭据通过 Git 检查。`);
  }
}

function optionalGit(checkout: string, args: string[]): string | null {
  try { return git(checkout, args); } catch { return null; }
}

function originLabel(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.toString();
  } catch { return origin; } // 普通本地路径和 Git 的 user@host:path
}

function checkoutRoot(checkout: string): string {
  const root = realpathSync(checkout);
  if (realpathSync(git(root, ["rev-parse", "--show-toplevel"])) !== root) {
    throw new Error(`请选择 Git 检出根目录，而不是子目录：${checkout}`);
  }
  return root;
}

function packDirectory(checkout: string, pack: string): string {
  if (isAbsolute(pack) || pack.split(/[\\/]/).includes("..")) throw new Error("Pack 必须是检出内的相对目录。");
  const path = realpathSync(resolve(checkout, pack));
  const rel = relative(checkout, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Pack 逃逸了检出范围。");
  assertTreeHasNoSymlinks(path);
  validateContextPackManifestForInstall(join(path, "manifest.yaml"));
  return path;
}

function discoverPack(checkout: string, selected?: string): string {
  if (selected !== undefined) return relative(checkout, packDirectory(checkout, selected)) || ".";
  // 使用现有的仓库约定；避免把任意任务目标 manifest 当作 pack
  // 或递归遍历私有仓库的内容。
  const candidates: string[] = [];
  if (existsSync(join(checkout, "manifest.yaml"))) candidates.push(".");
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (existsSync(join(child, "manifest.yaml"))) candidates.push(relative(checkout, child));
      else walk(child);
    }
  };
  walk(join(checkout, ".openrig", "context-packs"));
  if (candidates.length !== 1) throw new Error(`请用 --pack <relative-path> 选择一个 pack。发现了 ${candidates.length} 个：${candidates.join(", ") || "无"}。检出保留在 ${checkout}。`);
  return candidates[0]!;
}

function digestTree(dir: string): string {
  const hash = createHash("sha256");
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(at, entry.name);
      if (path === join(dir, RECEIPT)) continue;
      if (entry.isDirectory()) walk(path);
      else {
        if (!entry.isFile()) throw new Error(`上下文选择包含非常规文件：${path}`);
        const bytes = readFileSync(path);
        hash.update(JSON.stringify([relative(dir, path), bytes.length])).update(bytes);
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

function readSelection(target: string): Selection {
  if (lstatSync(target).isSymbolicLink()) throw new Error("Git 上下文选择不能是符号链接。");
  const value = JSON.parse(readFileSync(join(target, RECEIPT), "utf8")) as Selection;
  if (value.format !== 1 || typeof value.libraryRoot !== "string" || !isAbsolute(value.libraryRoot) || typeof value.checkout !== "string" || !isAbsolute(value.checkout) || typeof value.pack !== "string" || !/^[a-f0-9]{40,64}$/.test(value.revision) || !/^[a-f0-9]{64}$/.test(value.digest)) {
    throw new Error("无效的 Git 来源回执；选择和检出未更改。");
  }
  return value;
}

function cleanCheckout(checkout: string): void {
  if (git(checkout, ["status", "--porcelain"])) throw new Error(`检出有本地更改或冲突。请先用 Git 保留/提交它们再更新：${checkout}`);
  if (optionalGit(checkout, ["rev-parse", "--verify", "MERGE_HEAD"])) throw new Error(`${checkout} 仍有进行中的合并；请先用 Git 完成或中止它。`);
}

function selectPack(checkout: string, pack: string, target: string, libraryRoot: string, previous?: Selection): Selection {
  cleanCheckout(checkout);
  const source = packDirectory(checkout, pack);
  const revision = git(checkout, ["rev-parse", "HEAD"]);
  const history = `${resolve(libraryRoot)}-git-history`;
  const staging = join(history, `staging-${randomUUID()}`);
  mkdirSync(staging, { recursive: true });
  // 只复制声明的读者输入，绝不复制 .git 或无关的私有数据。
  const manifest = parseYaml(readFileSync(join(source, "manifest.yaml"), "utf8")) as { files: Array<{ path: string }> };
  for (const file of ["manifest.yaml", ...manifest.files.map((f) => f.path)]) {
    const from = join(source, file);
    git(checkout, ["ls-files", "--error-unmatch", "--", relative(checkout, from)]);
    if (!lstatSync(from).isFile()) throw new Error(`声明的上下文输入不是常规文件：${from}。暂存保留在 ${staging}`);
    mkdirSync(dirname(join(staging, file)), { recursive: true });
    copyFileSync(from, join(staging, file));
  }
  cleanCheckout(checkout);
  if (git(checkout, ["rev-parse", "HEAD"]) !== revision) throw new Error(`选择期间检出发生了移动；暂存保留在 ${staging}。等待写入者稳定后重试。`);
  const selection: Selection = { format: 1, checkout, libraryRoot: resolve(libraryRoot), pack, revision, digest: digestTree(staging), selectedAt: new Date().toISOString() };
  writeFileSync(join(staging, RECEIPT), JSON.stringify(selection, null, 2) + "\n");
  // 保留之前服务的目录，包括其回执。绝不重置、删除或静默吸收
  // 直接对已安装选择所做的编辑。
  if (previous) {
    if (digestTree(target) !== previous.digest) throw new Error(`更新期间服务的上下文发生了变化；暂存保留在 ${staging}。`);
    const retained = join(history, `previous-${randomUUID()}`);
    renameSync(target, retained);
    try { renameSync(staging, target); }
    catch (err) { renameSync(retained, target); throw err; }
  } else {
    if (existsSync(target)) throw new Error(`上下文目标已存在：${target}`);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(staging, target);
  }
  return selection;
}

export function inspectGitContext(target: string) {
  const selected = readSelection(target);
  const currentDigest = digestTree(target);
  const served = { path: target, ...selected, currentDigest, edited: currentDigest !== selected.digest };
  try {
    const checkout = checkoutRoot(selected.checkout);
    const revision = git(checkout, ["rev-parse", "HEAD"]);
    const upstream = optionalGit(checkout, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    const counts = upstream ? optionalGit(checkout, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])?.split(/\s+/).map(Number) : null;
    const branch = optionalGit(checkout, ["symbolic-ref", "--short", "HEAD"]);
    const remote = branch ? optionalGit(checkout, ["config", "--get", `branch.${branch}.remote`]) : null;
    const origin = remote ? optionalGit(checkout, ["remote", "get-url", "--", remote]) : null;
    return {
      served, checkout: { path: checkout, revision, branch, remote, origin: originLabel(origin),
        status: git(checkout, ["status", "--porcelain"]), conflicts: git(checkout, ["diff", "--name-only", "--diff-filter=U"]),
        upstream, ahead: counts?.[0] ?? null, behind: counts?.[1] ?? null,
        selectedRevisionMatches: revision === selected.revision,
        selectedPackDiff: git(checkout, ["diff", "--stat", selected.revision, "--", selected.pack]),
      },
      remoteAvailability: "未验证；inspect 使用本地引用，update 显式 fetch",
      consumption: "未验证；选择是可读上下文，不是智能体已读取或使用它的证据",
    };
  } catch (err) {
    return { served, checkout: { path: selected.checkout, unavailable: (err as Error).message }, remoteAvailability: "未验证", consumption: "未验证" };
  }
}

export function addGitContext(source: string, opts: { pack?: string; name?: string; checkout?: boolean }, targetRoot: string) {
  if (opts.name) assertSafeInstallRef(opts.name);
  let checkout: string;
  if (opts.checkout) checkout = checkoutRoot(source);
  else {
    // 现有 Git 凭据助手继续负责；不传密钥参数。
    if (source.startsWith("-") || /^(?:https?:\/\/[^/]*@|[a-z]+:\/\/[^/]*:[^/]*@)/i.test(source)) throw new Error("请使用仓库路径或通过你现有 Git 凭据机制的无凭据 Git URL。");
    const parent = `${resolve(targetRoot)}-git-checkouts`;
    mkdirSync(parent, { recursive: true });
    checkout = join(parent, randomUUID());
    git(parent, ["clone", "--", source, checkout]);
    checkout = checkoutRoot(checkout);
  }
  const pack = discoverPack(checkout, opts.pack);
  const manifest = parseYaml(readFileSync(join(packDirectory(checkout, pack), "manifest.yaml"), "utf8")) as { name: string };
  const name = opts.name ?? manifest.name;
  assertSafeInstallRef(name);
  assertDestinationNamespaceContained(targetRoot, name);
  const target = join(targetRoot, name);
  try { lstatSync(target); throw new Error(`上下文目标已存在：${target}。检出保留在 ${checkout}`); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  const selected = selectPack(checkout, pack, target, targetRoot);
  return { installedAt: target, selected };
}

export function updateGitContext(target: string) {
  const selected = readSelection(target);
  if (digestTree(target) !== selected.digest) throw new Error(`服务的上下文有本地编辑。请在 ${selected.checkout} 中保留它们，用 Git 提交，然后在重试前显式恢复此选择。未覆盖任何内容。`);
  const checkout = checkoutRoot(selected.checkout);
  cleanCheckout(checkout);
  const lock = `${target}.update-lock`;
  mkdirSync(lock); // 在重叠更新时可见失败；绝不偷锁
  try {
    const branch = git(checkout, ["symbolic-ref", "--short", "HEAD"]);
    const remote = git(checkout, ["config", "--get", `branch.${branch}.remote`]);
    const merge = git(checkout, ["config", "--get", `branch.${branch}.merge`]);
    if (!remote || remote.startsWith("-") || !merge.startsWith("refs/heads/")) throw new Error("更新前请选择一个有普通 Git 上游的分支。");
    git(checkout, ["fetch", "--", remote]);
    // Git 在真正的合并上保留双方父级并保持冲突可见。
    // 不做 autostash、reset、rebase、force、push 或语义冲突策略。
    git(checkout, ["merge", "--no-edit", "@{upstream}"]);
    selectPack(checkout, selected.pack, target, selected.libraryRoot, selected);
    return inspectGitContext(target);
  } finally { rmdirSync(lock); }
}

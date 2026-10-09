// twin:capture 包装器。
//
// 一条命令把 twin 表面转换为持久的逐 slice 产物集：
//   twin:build（透传 TWIN_ROUTE）→ headless-Chrome 截图 → 通过 FR-5 解析器放入
//   digital-twin/<slice-id>/ → 捕获 change.diff → 强制执行 D-1。
//
// 组合已经过测试的纯辅助函数（resolveArtifactPaths、buildChromeScreenshotArgs）；本文件只做
// 轻量 I/O 编排。不新增依赖，复用仓库已有的无头 Google Chrome 与 twin:build。运行时强制
// 执行确定性要求（D-1）：同一表面截图两次并逐字节比较 PNG；不一致会明确失败，绝不留下
// 静默不稳定的产物。为规避 emptyOutDir 陷阱，本次调用会在下一次构建清空 twin-out 前，
// 把产物复制到逐 slice 文件夹；每次运行只处理一个表面。
//
// 用法：
//   tsx twin/capture/twin-capture.ts --slice example-slice --surface "Topology Graph" \
//     --route /topology/rig/rig_alpha --out-root /abs/path/to/digital-twin
// 参数：--slice（必需）--surface（必需）--route（默认 "/"）--out-root（必需）
//       --chrome（可选，用于覆盖 Chrome 二进制路径）
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveArtifactPaths } from "./artifact-paths.js";
import { buildChromeScreenshotArgs, classifyCaptureResult, fileUrl, type CaptureVerdict } from "./headless-chrome.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** packages/ui（本文件位于 packages/ui/twin/capture/）。 */
const UI_DIR = path.resolve(__dirname, "..", "..");
/** 仓库/工作树根目录，用于获取 fixture/variant 编辑的 git diff。 */
const REPO_ROOT = path.resolve(UI_DIR, "..", "..");

interface Args {
  slice: string;
  surface: string;
  route: string;
  outRoot: string;
  chrome?: string;
  /** FR-6：可选的真实已交付 UI URL；作为配对证明捕获（构建后、由后台服务支撑）。 */
  proofUrl?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined || !a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "";
    }
  }
  const missing = ["slice", "surface", "out-root"].filter((k) => !out[k]);
  if (missing.length) {
    fail(`missing required flag(s): ${missing.map((m) => "--" + m).join(", ")}`);
  }
  return {
    slice: out["slice"] ?? "",
    surface: out["surface"] ?? "",
    route: out["route"] || "/",
    outRoot: out["out-root"] ?? "",
    chrome: out["chrome"] || undefined,
    proofUrl: out["proof-url"] || undefined,
  };
}

function fail(msg: string): never {
  process.stderr.write(`twin:capture FAILED — ${msg}\n`);
  process.exit(1);
}

/** 解析可用的无头 Chrome 二进制；无法解析时如实失败，绝不静默跳过。 */
function resolveChrome(override?: string): string {
  const candidates = [
    override,
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  const which = spawnSync("bash", ["-lc", "command -v google-chrome chromium chrome 2>/dev/null | head -1"], {
    encoding: "utf8",
  });
  const found = which.stdout.trim().split("\n")[0];
  if (found) return found;
  return fail("no headless Chrome found (set --chrome or CHROME_BIN; macOS default is Google Chrome.app)");
}

/** vtb 让静态 file:// twin 确定性稳定（意图 + D-1）。 */
const INTENT_VTB_MS = 9000;
/** 为快速 file:// 捕获设置的宽裕上限。 */
const INTENT_TIMEOUT_MS = 30_000;
/** 实时 http:// 证明捕获的有界上限（无 vtb），使无法完成的路由明确失败。 */
const PROOF_TIMEOUT_MS = 20_000;

interface CaptureOpts {
  url: string;
  pngPath: string;
  virtualTimeBudgetMs?: number;
  timeoutMs: number;
}

/**
 * 使用有界进程超时截取 URL，如实解释结果，并在失败时移除不完整 PNG。绝不挂起；未完成的捕获
 * 会在限定时间内明确失败（QA 复现 7a578b32：旧版无界且始终启用 vtb 的路径会在实时 UI
 * 路由上挂起）。
 */
function captureScreenshot(chrome: string, opts: CaptureOpts): CaptureVerdict {
  const r = spawnSync(
    chrome,
    buildChromeScreenshotArgs({ url: opts.url, pngPath: opts.pngPath, virtualTimeBudgetMs: opts.virtualTimeBudgetMs }),
    { encoding: "utf8", timeout: opts.timeoutMs },
  );
  const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const verdict = classifyCaptureResult({
    status: r.status,
    signal: r.signal,
    timedOut,
    pngExists: existsSync(opts.pngPath),
  });
  if (!verdict.ok) rmSync(opts.pngPath, { force: true });
  return verdict;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const chrome = resolveChrome(args.chrome);
  const paths = resolveArtifactPaths({ slice: args.slice, surface: args.surface, outRoot: args.outRoot });

  // 1. 为目标表面构建 twin（透传 TWIN_ROUTE——已经验证的机制）。
  const build = spawnSync("npm", ["run", "twin:build"], {
    cwd: UI_DIR,
    env: { ...process.env, TWIN_ROUTE: args.route },
    stdio: "inherit",
  });
  if (build.status !== 0) fail(`twin:build failed (status ${build.status})`);

  const builtHtml = path.join(UI_DIR, "twin-out", "intent.html");
  if (!existsSync(builtHtml)) fail(`expected build output not found: ${builtHtml}`);

  // 2. 在后续构建清空 twin-out 前，把产物放入 digital-twin/<slice-id>/。
  mkdirSync(paths.dir, { recursive: true });
  copyFileSync(builtHtml, paths.intentHtml); // regenerable, but emitted for convenience

  // 3. 截取表面（file:// twin）→ 持久 intent.png；vtb 让静态页面稳定。
  const builtUrl = fileUrl(builtHtml);
  const iv = captureScreenshot(chrome, {
    url: builtUrl,
    pngPath: paths.intentPng,
    virtualTimeBudgetMs: INTENT_VTB_MS,
    timeoutMs: INTENT_TIMEOUT_MS,
  });
  if (!iv.ok) fail(`intent capture failed — ${iv.reason}`);

  // 4. D-1 确定性：再次截到临时 PNG 并逐字节比较；不匹配即明确失败。
  const scratch = path.join(paths.dir, ".determinism-check.png");
  const dv = captureScreenshot(chrome, {
    url: builtUrl,
    pngPath: scratch,
    virtualTimeBudgetMs: INTENT_VTB_MS,
    timeoutMs: INTENT_TIMEOUT_MS,
  });
  if (!dv.ok) fail(`D-1 second capture failed — ${dv.reason}`);
  const identical = readFileSync(paths.intentPng).equals(readFileSync(scratch));
  rmSync(scratch, { force: true });
  if (!identical) fail("D-1 determinism check FAILED — two captures of the same surface differ (flake)");

  // 5. change.diff——持久核心：产生本次结果的未提交 fixture/variant 编辑。
  const diff = spawnSync("git", ["-C", REPO_ROOT, "diff", "--", "packages/ui/twin", "packages/ui/src"], {
    encoding: "utf8",
  });
  writeFileSync(paths.changeDiff, diff.stdout ?? "");

  // 6. FR-6 证明侧（可选）：以完全相同的格式捕获 --proof-url 指向的真实已交付 UI
  //    （同一 Chrome 机制，配对输出 <surface>.proof.png），用于并排比较意图与证明。
  //    它需要已运行的构建/后台服务，因此是构建后步骤；默认关闭，以保持意图路径不依赖后台服务。
  let proofLine = "  proof   : (skipped — pass --proof-url <real-ui-url> post-build to capture)\n";
  if (args.proofUrl) {
    // 实时 http:// 路由不使用 virtual-time-budget（永不空闲的实时 UI 会让它挂起），仅设有界超时。
    const pv = captureScreenshot(chrome, {
      url: args.proofUrl,
      pngPath: paths.proofPng,
      timeoutMs: PROOF_TIMEOUT_MS,
    });
    if (!pv.ok) fail(`proof capture failed (${args.proofUrl}) — ${pv.reason}`);
    proofLine = `  proof   : ${paths.proofPng} (from ${args.proofUrl})\n`;
  }

  process.stdout.write(
    `twin:capture OK\n` +
      `  surface : ${args.surface} (route ${args.route})\n` +
      `  intent  : ${paths.intentPng}\n` +
      proofLine +
      `  diff    : ${paths.changeDiff}${(diff.stdout ?? "").trim() ? "" : " (empty — no pending edit)"}\n` +
      `  html    : ${paths.intentHtml} (regenerable)\n` +
      `  D-1     : deterministic (two captures byte-identical)\n`,
  );
}

main();

// OPR.0.3.3.13.1 —— sample-diff 生成器入口。
//
// `npm run build` 之后可运行：
//   node dist/release-surface/generate.js --from v0.3.1 --to v0.3.2 --out <path>
// 把确定性的发布面 diff 输出到 --out（或 stdout）。未接入发布的 `rig` 二进制
// （该部署属于 13.3 的决定）；这是 POC 证明产物生成器。

import fs from "node:fs";

import { generateSurfaceDiff, diffToYaml, SurfaceParserError } from "./surface-diff.js";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  try {
    const diff = generateSurfaceDiff({ from: args.from, to: args.to, cwd: args.cwd });
    const yaml = diffToYaml(diff);
    if (args.out) {
      fs.writeFileSync(args.out, yaml);
      process.stderr.write(`发布面 diff 已写入 ${args.out}\n`);
    } else {
      process.stdout.write(yaml);
    }
    return 0;
  } catch (err) {
    if (err instanceof SurfaceParserError) {
      process.stderr.write(`错误：${err.fact}\n${err.consequence}\n${err.action}\n`);
      return 1;
    }
    throw err;
  }
}

process.exitCode = main(process.argv.slice(2));

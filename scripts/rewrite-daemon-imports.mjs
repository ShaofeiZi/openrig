#!/usr/bin/env node
// 打包步骤（build-package.sh）：把 CLI 与 TUI 里对 `@openrig/daemon/<子路径>` 的编译后 import，
// 指向 CLI 包已随包附带的 `daemon/dist` 那份 daemon，使发布包对未发布的
// `@openrig/daemon` 没有运行时依赖，任何包管理器都能装它（#66）。
//
// 文件用构建已在用的 TypeScript 编译器解析，只重写真正的模块说明符：import/export 声明，
// 以及参数为字面量的 `import()` / `require()` 调用。注释与字符串原样保留。
// 目标来自 packages/daemon/package.json 的 `exports`。本步骤在以下情况失败：解析错误、
// 说明符在 exports 里没有条目、目标未被暂存、以非字面量 `import()`/`require()` 指名该包、
// 以及重写后仍残留 daemon import。连跑两次是 no-op。源码 import 与开发态解析不变。

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PACKAGE = "@openrig/daemon";
const isDaemonSpecifier = (value) => value === PACKAGE || value.startsWith(`${PACKAGE}/`);

// 从一个文件的语法树里取出其中的 daemon 模块说明符。
function daemonSpecifiers(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length > 0) {
    throw new Error(`${file}: cannot parse (${source.parseDiagnostics[0].messageText})`);
  }
  const found = [];
  const visit = (node) => {
    let literal;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      literal = node.moduleSpecifier;
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) literal = argument;
      else if (argument && argument.getText(source).includes(PACKAGE)) {
        throw new Error(`${file}: cannot rewrite non-literal module argument ${argument.getText(source)}`);
      }
    }
    if (literal && ts.isStringLiteralLike(literal) && isDaemonSpecifier(literal.text)) {
      found.push({ value: literal.text, start: literal.getStart(source), end: literal.getEnd() });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function loadSubpathTargets(daemonPackageJsonPath) {
  const exportsMap = JSON.parse(readFileSync(daemonPackageJsonPath, "utf8")).exports ?? {};
  const targets = new Map();
  for (const [key, value] of Object.entries(exportsMap)) {
    const target = typeof value === "string" ? value : value?.import;
    if (typeof target === "string") targets.set(key, target);
  }
  return targets;
}

// 重写一个文件的文本。`targetFor(subpath)` 返回绝对目标路径，否则抛错。
export function rewriteSource(text, file, targetFor) {
  const found = daemonSpecifiers(text, file);
  let output = text;
  // 从后往前替换，使前面的偏移保持有效；保留每个字面量自己的引号。
  for (const { value, start, end } of [...found].reverse()) {
    const target = targetFor(value.slice(PACKAGE.length), file);
    let specifier = relative(dirname(file), target).split(sep).join("/");
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    output = `${output.slice(0, start + 1)}${specifier}${output.slice(end - 1)}`;
  }
  return { output, count: found.length };
}

export function remainingDaemonImports(text, file = "<input>") {
  return daemonSpecifiers(text, file).map(({ value }) => value);
}

function javascriptFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...javascriptFiles(path));
    else if (path.endsWith(".js")) files.push(path);
  }
  return files;
}

export function rewriteDaemonImports({ cliDir, daemonPackageJsonPath }) {
  const targets = loadSubpathTargets(daemonPackageJsonPath);
  const stagedDaemon = join(cliDir, "daemon");
  const targetFor = (subpath, file) => {
    const target = targets.get(`.${subpath}`);
    if (!target) {
      throw new Error(`${file}: @openrig/daemon${subpath} has no entry in the daemon exports map`);
    }
    const absolute = resolve(stagedDaemon, target);
    if (!existsSync(absolute)) {
      throw new Error(`${file}: @openrig/daemon${subpath} maps to ${target}, which is not staged at ${absolute}`);
    }
    return absolute;
  };

  let rewritten = 0;
  let files = 0;
  const roots = [join(cliDir, "dist"), join(cliDir, "tui", "dist")];
  for (const file of roots.flatMap(javascriptFiles)) {
    const text = readFileSync(file, "utf8");
    const { output, count } = rewriteSource(text, file, targetFor);
    if (count === 0) continue;
    writeFileSync(file, output);
    rewritten += count;
    files += 1;
  }

  const left = roots.flatMap(javascriptFiles).flatMap((file) =>
    remainingDaemonImports(readFileSync(file, "utf8"), file).map((found) => `${file}: ${found}`));
  if (left.length > 0) throw new Error(`daemon imports left after rewrite:\n${left.join("\n")}`);
  return { rewritten, files };
}

// 仅在直接执行时运行。比较真实文件路径，而非手拼 URL：import.meta.url 会做百分号转义
// （空格、"#"），且指向软链解析后的文件。
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false; // argv[1] 不是已存在文件，说明本模块是被 import 而非直接运行
  }
}

if (invokedDirectly()) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const { rewritten, files } = rewriteDaemonImports({
      cliDir: join(repoRoot, "packages", "cli"),
      daemonPackageJsonPath: join(repoRoot, "packages", "daemon", "package.json"),
    });
    console.log(`Rewrote ${rewritten} @openrig/daemon import(s) in ${files} file(s) to the shipped daemon/dist.`);
  } catch (error) {
    console.error(`rewrite-daemon-imports: ${error.message}`);
    process.exitCode = 1;
  }
}

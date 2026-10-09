// OPR.0.3.3.13.1 - CLI 表面检测解析器（slice 13 的组件 1）。
//
// 通过 TypeScript 编译器 API（已是 devDependency；根据 slice 治理裁定
// 无新依赖）从 `packages/cli/src/commands/*.ts` 源码文本中提取
// Commander 命令表面。表面是命令路径集（例如 `scope slice create`）
// 和每个命令的选项名 token（例如 `--body-file`），取自 Commander
// 注册链——不是文件名，也不是选项描述（后者经常是模板字面量）。
//
// 两种注册惯用法被解析：
//   - 链式内联子命令：`cmd.command("create").requiredOption(...)`，
//   - 工厂间接：`parent.addCommand(buildChildCommand())`，
//     其中 builder 返回 `new Command("child")...`。
// 注册名优先于文件名（`rig-mode.ts` 文件的
// `new Command("policy")` 表面为 `policy`，绝不是 `rig-policy`）。

import ts from "typescript";

export interface Surface {
  /** 完整命令路径，空格连接（例如 "queue create"、"scope slice create"）。 */
  commands: Set<string>;
  /** "<command-path> <--flag>" 条目，按 FLAG_SEP 分割。 */
  flags: Set<string>;
}

// 命令路径和 flag 之间的 NUL 分隔符。命令路径是空格连接的，
// 因此空格不能无歧义地分割 "<path> <flag>" 条目（路径本身含空格）。
// NUL 从不出现在路径或 flag token 中，因此分割干净。
// 它只存在于 Set 键内部，绝不到达输出。
export const FLAG_SEP = "\u0000";

interface CmdNode {
  name: string;
  flags: Set<string>;
  children: CmdNode[];
}

function firstToken(s: string): string {
  return s.trim().split(/\s+/)[0] ?? "";
}

function stringLiteralText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * 将选项的第一个参数（flags 字符串）缩减为规范长 flag，
 * 忽略值占位符。示例：
 *   "--body-file <path>"  -> "--body-file"
 *   "-l, --literal"       -> "--literal"
 *   "--no-mission-notes"  -> "--no-mission-notes"
 *   "-y"                  -> "-y"
 * 没有 flag token 时返回 null。
 */
export function normalizeFlag(flagsArg: string): string | null {
  const tokens = flagsArg.split(/[\s,]+/).filter(Boolean);
  const longs = tokens.filter((t) => t.startsWith("--"));
  if (longs.length > 0) return longs[longs.length - 1]!;
  const shorts = tokens.filter((t) => /^-[^-]/.test(t));
  return shorts.length > 0 ? shorts[0]! : null;
}

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

function freshNode(rawName: string): CmdNode {
  return { name: firstToken(rawName), flags: new Set(), children: [] };
}

/** 从单个源文件提取根命令节点。 */
function extractFile(fileName: string, text: string): CmdNode[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);

  const fnDecls = new Map<string, ts.FunctionDeclaration>();
  const exportedFnNames: string[] = [];
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      fnDecls.set(node.name.text, node);
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (exported) exportedFnNames.push(node.name.text);
    }
  });

  const fnRoots = new Map<string, CmdNode | null>();
  const inProgress = new Set<string>();

  function rootOfFunction(name: string): CmdNode | null {
    if (fnRoots.has(name)) return fnRoots.get(name)!;
    if (inProgress.has(name)) return null; // 循环守卫
    const decl = fnDecls.get(name);
    if (!decl || !decl.body) {
      fnRoots.set(name, null);
      return null;
    }
    inProgress.add(name);
    const root = processBody(decl.body);
    inProgress.delete(name);
    fnRoots.set(name, root);
    return root;
  }

  function processBody(body: ts.Block): CmdNode | null {
    const vars = new Map<string, CmdNode>();
    let root: CmdNode | null = null;
    for (const stmt of body.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            const node = evalExpr(decl.initializer, vars);
            if (node) vars.set(decl.name.text, node);
          }
        }
      } else if (ts.isExpressionStatement(stmt)) {
        evalExpr(stmt.expression, vars); // 副作用：.command / .addCommand / .option
      } else if (ts.isReturnStatement(stmt) && stmt.expression) {
        root = evalExpr(stmt.expression, vars);
      }
    }
    return root;
  }

  // 解析求值为（或变异）命令节点的表达式。
  // `.command()` 返回新创建的子节点（Commander 语义）；
  // 其他 builder 方法都返回接收者（`this`）。
  function evalExpr(input: ts.Expression, vars: Map<string, CmdNode>): CmdNode | null {
    const expr = unwrap(input);

    if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Command") {
      const nameLit = stringLiteralText(expr.arguments?.[0]);
      return nameLit == null ? null : freshNode(nameLit);
    }

    if (ts.isIdentifier(expr)) {
      return vars.get(expr.text) ?? null;
    }

    if (ts.isCallExpression(expr)) {
      const callee = expr.expression;

      // builderFn() -> 该函数返回的根命令
      if (ts.isIdentifier(callee) && fnDecls.has(callee.text)) {
        return rootOfFunction(callee.text);
      }

      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const recv = evalExpr(callee.expression, vars);

        if (method === "command") {
          const nameLit = stringLiteralText(expr.arguments[0]);
          if (nameLit == null) return recv;
          const child = freshNode(nameLit);
          if (recv) recv.children.push(child);
          return child; // 链式调用附加到子节点
        }
        if (method === "option" || method === "requiredOption") {
          const flagLit = stringLiteralText(expr.arguments[0]);
          if (recv && flagLit != null) {
            const f = normalizeFlag(flagLit);
            if (f) recv.flags.add(f);
          }
          return recv;
        }
        if (method === "addCommand") {
          const arg0 = expr.arguments[0];
          const child = arg0 ? evalExpr(arg0, vars) : null;
          if (recv && child) recv.children.push(child);
          return recv;
        }
        // description / action / argument / alias / addHelpText / 等 → 接收者
        return recv;
      }
    }

    return null;
  }

  const roots: CmdNode[] = [];
  const seen = new Set<CmdNode>();
  for (const name of exportedFnNames) {
    const r = rootOfFunction(name);
    if (r && !seen.has(r)) {
      roots.push(r);
      seen.add(r);
    }
  }
  return roots;
}

function walk(node: CmdNode, prefix: string[], surface: Surface): void {
  const path = [...prefix, node.name];
  const pathStr = path.join(" ");
  surface.commands.add(pathStr);
  for (const f of node.flags) surface.flags.add(pathStr + FLAG_SEP + f);
  for (const child of node.children) walk(child, path, surface);
}

/** 从一组 `{name, text}` 源构建组合命令表面。 */
export function extractSurfaceFromSources(files: { name: string; text: string }[]): Surface {
  const surface: Surface = { commands: new Set(), flags: new Set() };
  for (const file of files) {
    for (const root of extractFile(file.name, file.text)) {
      walk(root, [], surface);
    }
  }
  return surface;
}

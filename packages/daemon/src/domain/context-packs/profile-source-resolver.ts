// OPR.0.5.3.5 Atom 4a——同一语法背后的两个 `#` 前解析器。
//
// Q2 修订 1（已锁定），原样采用桌面语法裁决：非库来源也使用同一套
// `#H2-slug/H3-slug` 语法寻址；只有 `#` 前解析器不同——library ref 经库解析
//（此处为 pack 自身目录），tree path 从已配置根解析，二者均失败响亮。
// 内存中只保留一套语法，背后两个解析器，不引入第二套寻址约定。kind 前缀
// 就是完整的 `#` 前方言：
//
//   walk.md#welcome              -> library（pack 声明的文件）
//   project:SPEC.md              -> 已配置的项目树
//   seat:RECAP.md#decisions      -> 席位树（recap 和 lore 与 LEARNED 并列）
//   mission:NOTES.md#watch-items -> mission 树
//
// 根由调用方从配置传入（CE-v2 03-tree-addressability：寻址动词从配置解析 tree path，
// 绝不使用字面量；本模块不持有路径字面量，并拒绝猜测缺失根）。可组合性来自寻址，
// 而不是归巢：组合时无需把任何内容复制进库。把 project、seat 或 mission 内容复制进库的
// profile 属于缺陷（Q2 修订 1(c)）。

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import type { SourceKind } from "./profile-composer.js";
import { parseAddress } from "../markdown-address.js";

export class SourceResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceResolutionError";
  }
}

const TREE_KINDS = ["project", "seat", "mission"] as const;
export type TreeKind = (typeof TREE_KINDS)[number];

export interface ParsedSourceRef {
  kind: SourceKind;
  /** pack 目录（library）或该 kind 已配置根下的相对路径。 */
  rel: string;
}

/** 把 `#` 前 ref 拆为解析器 kind + 相对路径。未知前缀或遍历形路径会响亮失败——
 *  干净拒绝，绝不逃逸（沿用 trace 动词的 r2-B3 先例）。 */
export function parseSourceRef(ref: string): ParsedSourceRef {
  const colon = ref.indexOf(":");
  let kind: SourceKind = "library";
  let rel = ref;
  if (colon >= 0) {
    const prefix = ref.slice(0, colon);
    if (!(TREE_KINDS as readonly string[]).includes(prefix)) {
      throw new SourceResolutionError(
        `source ref '${ref}' 的 kind 前缀 '${prefix}' 未知——'#' 前方言应为裸 ref（library）或 ${TREE_KINDS.map((k) => `'${k}:'`).join("、")}。`,
      );
    }
    kind = prefix as TreeKind;
    rel = ref.slice(colon + 1);
  }
  if (rel.length === 0) {
    throw new SourceResolutionError(`source ref '${ref}' 的 kind 前缀后路径为空。`);
  }
  const unsafe =
    isAbsolute(rel) ||
    rel.split(/[\\/]/).some((segment) => segment === ".." || segment === "");
  if (unsafe) {
    throw new SourceResolutionError(
      `source ref '${ref}' 呈遍历形态（绝对路径、'..' 或空路径段）——ref 必须位于其来源根内。`,
    );
  }
  return { kind, rel };
}

export interface ProfileSourceRoots {
  /** 所选项目的 tree 目录——来自配置。 */
  project?: string;
  /** 席位的 tree 目录（recap 与 lore 位于 LEARNED 旁）——来自配置。 */
  seat?: string;
  /** mission 的 tree 目录——来自配置。 */
  mission?: string;
}

/** 一次成功读取的字节出处记录（经 4a 评审加入的 r1 rider 1）：label 必须可检查，
 *  不能只是声明。有符号链接时，来源 label 对 ref 正确却可能对实际字节错误；
 *  即使是良性符号链接也会触发，并非只针对恶意链接。 */
export interface SourceReadRecord {
  ref: string;
  kind: SourceKind;
  /** 本次读取获准基于的根。 */
  base: string;
  /** 符号链接解析前的 base + rel。 */
  nominalPath: string;
  /** 字节的实际来源（成功读取后的 realpath）。 */
  realPath: string;
  /** realPath 位于 base 外时为 true。通过 path.relative 计算，绝不使用裸字符串前缀；
   *  否则 `startsWith` 会误称 /seat-evil 位于 /seat 内。 */
  escapesRoot: boolean;
}

/** 在 pack 目录与已配置 tree 根上构建 composer 的失败响亮 readFile。每次失败都点明
 *  来源 kind 和正在解析的对象——缺失根是 MISSING CONFIG 错误，绝不是静默空值；
 *  DANGLING 符号链接有自己的具名失败，因为这是现实语料状态，不是泛化的不可读。
 *  每次成功读取都通过 onRead 报告字节出处。 */
export function makeProfileReadFile(opts: {
  packDir: string;
  roots: ProfileSourceRoots;
  onRead?: (record: SourceReadRecord) => void;
}): (ref: string) => string {
  return (ref: string): string => {
    const { kind, rel } = parseSourceRef(ref);
    let base: string;
    if (kind === "library") {
      base = opts.packDir;
    } else {
      const configured = opts.roots[kind];
      if (!configured) {
        throw new SourceResolutionError(
          `source ref '${ref}' 需要 ${kind} tree 根，但本次 compose 未配置——` +
            `tree path 从配置解析，绝不使用字面量；请提供 ${kind} 根或删除归属 ${kind} 的 atom。`,
        );
      }
      base = configured;
    }
    const abs = normalize(join(base, rel));
    let text: string;
    try {
      text = readFileSync(abs, "utf-8");
    } catch (err) {
      // 精确点名悬空符号链接状态：路径作为链接存在，但目标不存在。泛化的“不可读”
      // 会让作者去寻找列表里明明存在的文件。
      let dangling = false;
      try {
        lstatSync(abs);
        dangling = true;
      } catch {
        /* 确实不存在 */
      }
      throw new SourceResolutionError(
        dangling
          ? `source ref '${ref}'（${kind}）是悬空符号链接：${abs} 存在，但其目标不存在——${(err as Error).message}`
          : `source ref '${ref}'（${kind}）解析失败：${abs} 不可读——${(err as Error).message}`,
      );
    }
    // 成功读取后再记录出处。对缺失文件执行 realpath 会抛错，该错误绝不能扰乱上方
    // 诚实的读取错误。
    if (opts.onRead) {
      let realPath = abs;
      try {
        realPath = realpathSync(abs);
      } catch {
        /* 读取后竞态消失；nominal 是当前最佳事实 */
      }
      let realBase = base;
      try {
        realBase = realpathSync(base);
      } catch {
        /* 根本身无法解析；改与 nominal base 比较 */
      }
      const relFromBase = relative(realBase, realPath);
      // 按路径段比较，绝不对路径形字符串做前缀测试。r1 round-3 F1 中，根内合法命名为
      // '..hidden-notes.md' 的文件会满足 startsWith('..')；这与 startsWith(base) 把
      // /seat-evil 判进 /seat 属于同一类错误，只是多下一层。
      const escapesRoot = relFromBase === ".." || relFromBase.startsWith(`..${sep}`) || isAbsolute(relFromBase);
      opts.onRead({ ref, kind, base, nominalPath: abs, realPath, escapesRoot });
    }
    return text;
  };
}

/** composer 的逐片来源标签（Q2 修订 1：每个组装片都标记来源），从 atom 完整地址派生。 */
export function sourceKindForAddress(address: string): SourceKind {
  return parseSourceRef(parseAddress(address).ref).kind;
}

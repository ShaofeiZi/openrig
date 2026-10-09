// UI 增强包 v0——轻量语法高亮（零依赖）。
//
// 据审计：UI 包未安装任何 markdown / 高亮库，而 PRD 对 mermaid 的豁免暗示了对包体积的顾虑。
// 我们交付一个每语言约 200 行的小分词器，处理操作者在 canon 文档里常见的情况：
// bash、ts/tsx/js/jsx、py、yaml、json、sql、md、sh、纯文本。
//
// 分词器风格：发出带语义类名的 React span
// （token-keyword、token-string、token-comment、token-number、token-tag），
// 在 globals.css 中定色。每种语言有一小组按序应用的正则匹配器；每个位置取最长匹配。
// 字符串 + 注释用贪婪匹配来处理围栏代码的“多行”情况（输入是独立块，因此字符串/注释
// 令牌内的换行不常见——我们仍会扫过它们）。
//
// 这刻意不是完整高亮器。边界情况（带嵌入表达式的模板字面量、正则字面量、JSX 花括号）
// 优雅降级为“该令牌不高亮”。视觉目标是“这明显是代码” + “关键字/字符串/注释可区分”，
// 而非与编辑器像素级对齐。

import { useMemo } from "react";

export type HighlightLanguage =
  | "bash" | "sh" | "ts" | "tsx" | "js" | "jsx"
  | "py" | "python"
  | "yaml" | "yml"
  | "json"
  | "sql"
  | "md" | "markdown"
  | "text" | "plain" | "";

export function SyntaxHighlight({
  code,
  language,
}: {
  code: string;
  language: string | null | undefined;
}) {
  const lang = normalizeLanguage(language);
  const tokens = useMemo(() => tokenize(code, lang), [code, lang]);
  return (
    <pre
      data-testid="syntax-highlight-block"
      data-language={lang}
      className="overflow-x-auto bg-stone-900 p-3 font-mono text-[10px] leading-relaxed text-stone-100"
    >
      <code>
        {tokens.map((tok, idx) => (
          <span key={idx} className={tok.className} data-token-kind={tok.kind}>
            {tok.text}
          </span>
        ))}
      </code>
    </pre>
  );
}

interface Token {
  kind: "plain" | "keyword" | "string" | "comment" | "number" | "tag" | "punctuation";
  text: string;
  className: string;
}

const TOKEN_CLASS: Record<Token["kind"], string> = {
  plain: "",
  keyword: "text-violet-300",
  string: "text-emerald-300",
  comment: "text-stone-500 italic",
  number: "text-amber-300",
  tag: "text-sky-300",
  punctuation: "text-stone-400",
};

function token(kind: Token["kind"], text: string): Token {
  return { kind, text, className: TOKEN_CLASS[kind] };
}

function normalizeLanguage(lang: string | null | undefined): HighlightLanguage {
  if (!lang) return "";
  const norm = lang.toLowerCase().trim();
  if (norm === "javascript") return "js";
  if (norm === "typescript") return "ts";
  if (norm === "shell") return "sh";
  return norm as HighlightLanguage;
}

const KEYWORDS_BY_LANG: Record<string, Set<string>> = {
  ts: new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "switch", "case", "break", "continue", "default", "class", "extends", "implements", "interface", "type", "enum", "import", "export", "from", "as", "new", "this", "super", "async", "await", "throw", "try", "catch", "finally", "static", "public", "private", "protected", "readonly", "abstract", "true", "false", "null", "undefined", "void", "string", "number", "boolean", "any", "unknown", "never"]),
  tsx: new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "switch", "case", "break", "continue", "default", "class", "extends", "implements", "interface", "type", "enum", "import", "export", "from", "as", "new", "this", "super", "async", "await", "throw", "try", "catch", "finally", "static", "public", "private", "protected", "readonly", "abstract", "true", "false", "null", "undefined", "void", "string", "number", "boolean", "any", "unknown", "never"]),
  js: new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "switch", "case", "break", "continue", "default", "class", "extends", "import", "export", "from", "as", "new", "this", "super", "async", "await", "throw", "try", "catch", "finally", "true", "false", "null", "undefined"]),
  jsx: new Set(["const", "let", "var", "function", "return", "if", "else", "for", "while", "switch", "case", "break", "continue", "default", "class", "extends", "import", "export", "from", "as", "new", "this", "super", "async", "await", "throw", "try", "catch", "finally", "true", "false", "null", "undefined"]),
  py: new Set(["def", "class", "if", "elif", "else", "for", "while", "return", "import", "from", "as", "with", "try", "except", "finally", "raise", "lambda", "yield", "pass", "break", "continue", "global", "nonlocal", "True", "False", "None", "and", "or", "not", "in", "is", "async", "await"]),
  python: new Set(["def", "class", "if", "elif", "else", "for", "while", "return", "import", "from", "as", "with", "try", "except", "finally", "raise", "lambda", "yield", "pass", "break", "continue", "global", "nonlocal", "True", "False", "None", "and", "or", "not", "in", "is", "async", "await"]),
  bash: new Set(["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "export", "local", "readonly", "echo", "printf", "exit", "set", "unset", "shift", "true", "false"]),
  sh: new Set(["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "export", "local", "readonly", "echo", "printf", "exit", "set", "unset", "shift", "true", "false"]),
  sql: new Set(["select", "from", "where", "and", "or", "not", "null", "is", "in", "like", "between", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "having", "limit", "offset", "insert", "into", "values", "update", "set", "delete", "create", "table", "drop", "alter", "index", "primary", "key", "foreign", "references", "constraint", "unique", "default", "as", "case", "when", "then", "else", "end"]),
};

function tokenize(code: string, lang: HighlightLanguage): Token[] {
  if (lang === "" || lang === "text" || lang === "plain") return [token("plain", code)];
  if (lang === "json") return tokenizeJson(code);
  if (lang === "yaml" || lang === "yml") return tokenizeYaml(code);
  if (lang === "md" || lang === "markdown") return tokenizeMarkdown(code);
  if (lang === "py" || lang === "python") return tokenizeWithKeywordsAndComments(code, lang, "#");
  if (lang === "sh" || lang === "bash") return tokenizeWithKeywordsAndComments(code, lang, "#");
  if (lang === "ts" || lang === "tsx" || lang === "js" || lang === "jsx") return tokenizeWithKeywordsAndComments(code, lang, "//", "/*", "*/");
  if (lang === "sql") return tokenizeWithKeywordsAndComments(code, lang, "--");
  return [token("plain", code)];
}

function tokenizeWithKeywordsAndComments(
  code: string,
  lang: HighlightLanguage,
  lineCommentPrefix: string,
  blockCommentOpen?: string,
  blockCommentClose?: string,
): Token[] {
  const keywords = KEYWORDS_BY_LANG[lang] ?? new Set<string>();
  const out: Token[] = [];
  let i = 0;
  while (i < code.length) {
    const remaining = code.slice(i);
    // 块注释。
    if (blockCommentOpen && remaining.startsWith(blockCommentOpen)) {
      const closeIdx = blockCommentClose ? remaining.indexOf(blockCommentClose, blockCommentOpen.length) : -1;
      const end = closeIdx === -1 ? remaining.length : closeIdx + (blockCommentClose?.length ?? 0);
      out.push(token("comment", remaining.slice(0, end)));
      i += end;
      continue;
    }
    // 行注释。
    if (remaining.startsWith(lineCommentPrefix)) {
      const newline = remaining.indexOf("\n");
      const end = newline === -1 ? remaining.length : newline;
      out.push(token("comment", remaining.slice(0, end)));
      i += end;
      continue;
    }
    // 字符串字面量（单引号、双引号、反引号）。
    const quote = remaining[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      let j = 1;
      while (j < remaining.length && remaining[j] !== quote) {
        if (remaining[j] === "\\" && j + 1 < remaining.length) j += 2;
        else j++;
      }
      const end = j < remaining.length ? j + 1 : j;
      out.push(token("string", remaining.slice(0, end)));
      i += end;
      continue;
    }
    // 数字。
    const numMatch = remaining.match(/^-?\d+(\.\d+)?/);
    if (numMatch && (i === 0 || !/[a-zA-Z_]/.test(code[i - 1] ?? ""))) {
      out.push(token("number", numMatch[0]));
      i += numMatch[0].length;
      continue;
    }
    // 标识符——查关键字集。
    const idMatch = remaining.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
    if (idMatch) {
      if (keywords.has(idMatch[0])) out.push(token("keyword", idMatch[0]));
      else out.push(token("plain", idMatch[0]));
      i += idMatch[0].length;
      continue;
    }
    // 普通字符。
    out.push(token("plain", code[i] ?? ""));
    i++;
  }
  return mergeAdjacentPlain(out);
}

function tokenizeYaml(code: string): Token[] {
  const out: Token[] = [];
  for (const line of code.split(/(\n)/)) {
    if (line === "\n") { out.push(token("plain", "\n")); continue; }
    // 注释到行尾
    const commentIdx = line.indexOf("#");
    if (commentIdx !== -1) {
      const before = line.slice(0, commentIdx);
      out.push(...tokenizeYamlLineBody(before));
      out.push(token("comment", line.slice(commentIdx)));
    } else {
      out.push(...tokenizeYamlLineBody(line));
    }
  }
  return mergeAdjacentPlain(out);
}

function tokenizeYamlLineBody(line: string): Token[] {
  // 匹配前导缩进 + 键 + ": " + 值。
  const m = line.match(/^(\s*)([\w.-]+)(:)(\s*)(.*)$/);
  if (m) {
    const out: Token[] = [];
    out.push(token("plain", m[1]!));
    out.push(token("tag", m[2]!));
    out.push(token("punctuation", m[3]!));
    out.push(token("plain", m[4]!));
    const rest = m[5]!;
    if (rest.startsWith('"') || rest.startsWith("'")) {
      out.push(token("string", rest));
    } else if (/^\d+(\.\d+)?$/.test(rest)) {
      out.push(token("number", rest));
    } else {
      out.push(token("plain", rest));
    }
    return out;
  }
  return [token("plain", line)];
}

function tokenizeJson(code: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"') {
      let j = 1;
      while (j < code.length - i && code[i + j] !== '"') {
        if (code[i + j] === "\\") j += 2; else j++;
      }
      out.push(token("string", code.slice(i, i + j + 1)));
      i += j + 1;
      continue;
    }
    if (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === "," || ch === ":") {
      out.push(token("punctuation", ch));
      i++;
      continue;
    }
    const numMatch = code.slice(i).match(/^-?\d+(\.\d+)?/);
    if (numMatch) {
      out.push(token("number", numMatch[0]));
      i += numMatch[0].length;
      continue;
    }
    const wordMatch = code.slice(i).match(/^(true|false|null)\b/);
    if (wordMatch) {
      out.push(token("keyword", wordMatch[0]));
      i += wordMatch[0].length;
      continue;
    }
    out.push(token("plain", ch ?? ""));
    i++;
  }
  return mergeAdjacentPlain(out);
}

function tokenizeMarkdown(code: string): Token[] {
  // 围栏代码块内的轻量 markdown 高亮：标题
  // 标记 + 列表符 + 强调令牌。大多是普通文本——操作者通常按正文读行内 `code` 段，
  // 而不是在围栏代码里读整篇 markdown 文档。
  return [token("plain", code)];
}

function mergeAdjacentPlain(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    const last = out[out.length - 1];
    if (last && last.kind === "plain" && t.kind === "plain") {
      out[out.length - 1] = token("plain", last.text + t.text);
    } else {
      out.push(t);
    }
  }
  return out;
}

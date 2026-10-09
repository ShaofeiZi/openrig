// 规范工作范围成员匹配器（VM-003 + VM-004）。
//
// 评审流水线曾用四种互不一致的方式回答“哪些 qitem 属于工作范围 X”
//（matchQitems 子串 > hasActiveQitem JSON-LIKE > attentionForTag JSON-LIKE >
// agentsForSlices 精确相等）。本模块提供所有消费者共享的唯一规范成员谓词：把已记录的
// matchQitems 契约规范化，即类型化 tag 权威、逐 JSON 元素处理，并兼容逗号分隔的旧格式。

export interface QitemScopeTags {
  slices: Set<string>;
  missions: Set<string>;
}

/** 从 qitem 原始 tags 列解析规范工作范围成员关系。
 * 类型化 tag 具有权威性：逐元素解析 JSON 数组；每个元素按逗号拆分（matchQitems 契约注释所述
 * 的旧版 CLI 形式）并 trim；每个 token 精确匹配 `slice:`/`mission:` 前缀。本函数不包含子串语义，
 * 旧版子串层仍是 matchQitems 在“零类型化行”条件后的局部职责。
 *
 * 两层原则：信号层（phase / band / attention）只从本函数的规范成员关系作答；展示层
 *（queue tab 的 qitemId）可携带受门控的旧版子串回退。绝不能把展示层匹配提升为信号。 */
export function parseScopeTags(rawTags: string | null | undefined): QitemScopeTags {
  const slices = new Set<string>();
  const missions = new Set<string>();
  if (rawTags == null) return { slices, missions };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawTags);
  } catch {
    // JSON 格式错误时返回空集合，与现有 catch 分支保持一致。
    return { slices, missions };
  }
  if (!Array.isArray(parsed)) return { slices, missions };

  for (const element of parsed) {
    if (typeof element !== "string") continue;
    // 按逗号拆分元素（matchQitems 注释所指的旧版 CLI 形式），并且只在元素/token 层 trim，
    // 绝不在前缀之后 trim。因此 `slice: X`（冒号后有空格）得到名称 ` X` 而非 `X`，不会形成
    // 成员关系。原因是未加引号的 SQL 预过滤 `LIKE '%slice:<name>%'` 不匹配原始字符串
    // `slice: X`；若在前缀后 trim，就会接受预过滤看不到的行，造成少选并破坏不变量。
    // 只 trim token 后，每个已接受元素都会从字面上包含预过滤 needle，从构造上保证绝不少选。
    // v1 不归一化大小写或名称漂移，仍采用精确、区分大小写的匹配。
    for (const rawToken of element.split(",")) {
      const token = rawToken.trim();
      if (token.startsWith("slice:")) {
        slices.add(token.slice("slice:".length));
      } else if (token.startsWith("mission:")) {
        missions.add(token.slice("mission:".length));
      }
    }
  }
  return { slices, missions };
}

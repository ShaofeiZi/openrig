// F1 排除台账——四条轨道的机制（PM 裁决：排除台账“带牙齿”）。
//
// 一个确实无法在裁剪前修好的基础健康套件可以被排除出闸门——但只能以“可见、有归属、
// 有收据、且机制化到期”的方式排除。本模块是纯逻辑（注入 `now`/`cutCeiling`），
// 以便各轨道可单测；闸门入口再把真实台账文件 + 时钟接上来。它随一份空种子发布：
// 那命名的 6 个套件是被“杀掉”而非“排除”，所以 main 是真绿的、没有常驻者。
// 这套机制是给未来某次裁剪准备的持久安全带。
//
//   轨道 1  带排除仍为绿——某个失败被一个生效中的常驻者覆盖 → 闸门 PASS，且在带内点名
//   轨道 2  机制化到期——超过有效期的常驻者 → 闸门 FAIL（迫使其移除；自我消亡）
//   轨道 3  收据+归属+到期——每个常驻者都带 A/B 收据、一个 owner 和一个到期日
//   轨道 4  裁剪上限——任何常驻者的到期日都不得晚于 0.5.2 裁剪

export const LEDGER_ENTRY_FIELDS = ["suite", "reason", "receipt", "owner", "expiry"];

// 轨道 4——0.5.2 裁剪上限：任何排除的到期日都不得晚于此刻。这是按真实 0.5.2 裁剪日期钉死的；
// 种子为空时这个近期占位值不起作用，机制本身无论具体取值都强制 `expiry <= ceiling`。
export const CUT_CEILING_ISO = "2026-09-30";

// 仅按日期的字典序比较：对 YYYY-MM-DD，字符串序就是时间序。
const day = (d) => String(d).slice(0, 10);

/**
 * 轨道 3 + 轨道 4 的静态校验：每个常驻者必须带完整字段，且到期日不得晚于裁剪上限。
 * 返回 { valid, errors }——非法台账是响亮的闸门失败，绝不是静默通过。
 */
export function validateLedger(ledger = [], { cutCeiling = CUT_CEILING_ISO } = {}) {
  const errors = [];
  ledger.forEach((entry, i) => {
    const tag = entry && entry.suite ? `"${entry.suite}"` : `entry[${i}]`;
    for (const field of LEDGER_ENTRY_FIELDS) {
      const v = entry ? entry[field] : undefined;
      if (v === undefined || v === null || String(v).trim() === "") {
        errors.push(`${tag}：缺少必填字段 "${field}"`);
      }
    }
    if (entry && entry.expiry && day(entry.expiry) > day(cutCeiling)) {
      errors.push(`${tag}：到期日 ${day(entry.expiry)} 晚于 0.5.2 裁剪上限 ${day(cutCeiling)}`);
    }
  });
  return { valid: errors.length === 0, errors };
}

/**
 * 轨道 1 + 轨道 2——依据台账裁决闸门结果。当且仅当：台账在 schema/上限上合法、每个失败都被一个
 * 生效中（未过期）的常驻者覆盖、且没有常驻者过期（超过有效期的常驻者无论该套件当前状态如何都
 * 强制 RED——它必须被移除或重新给出理由），才为 PASS；否则 FAIL。注入的 `now`/`cutCeiling` 保证确定性。
 */
export function resolveGateWithLedger({ failures = [], ledger = [], now, cutCeiling = CUT_CEILING_ISO }) {
  const today = day(now);
  const validity = validateLedger(ledger, { cutCeiling });

  const active = [];
  const expired = [];
  for (const entry of ledger) {
    if (entry && entry.expiry && day(entry.expiry) < today) expired.push(entry);
    else active.push(entry);
  }

  const activeSuites = new Set(active.map((e) => e.suite));
  const covered = failures.filter((f) => activeSuites.has(f));
  const uncovered = failures.filter((f) => !activeSuites.has(f));

  const gate = validity.valid && uncovered.length === 0 && expired.length === 0 ? "pass" : "fail";
  return {
    gate,
    covered,
    uncovered,
    expired: expired.map((e) => e.suite),
    activeExclusions: active,
    validity,
  };
}

/**
 * 带内响亮渲染（轨道 1）：带排除的绿必须逐一列出每个排除项；失败时必须点明哪些未被覆盖或已过期。
 * 空台账就直白说明。
 */
export function renderLedgerState(result) {
  const n = result.activeExclusions.length;
  const lines = [];
  if (n === 0) {
    lines.push("闸门台账：0 项排除（干净——无常驻者）。");
  } else {
    lines.push(`闸门台账：${n} 项生效排除——带排除仍为绿（逐项点名）：`);
    for (const e of result.activeExclusions) {
      lines.push(`  • ${e.suite} — 负责人 ${e.owner}，到期 ${day(e.expiry)}，收据 ${e.receipt}（${e.reason}）`);
    }
  }
  if (result.uncovered.length) {
    lines.push(`  ✗ 未覆盖的失败（无排除项覆盖）：${result.uncovered.join(", ")}`);
  }
  if (result.expired.length) {
    lines.push(`  ✗ 已过期的常驻者（机制化到期——请移除或重新说明）：${result.expired.join(", ")}`);
  }
  if (!result.validity.valid) {
    lines.push(`  ✗ 台账条目非法：${result.validity.errors.join("; ")}`);
  }
  lines.push(`gate: ${result.gate.toUpperCase()}`);
  return lines.join("\n");
}

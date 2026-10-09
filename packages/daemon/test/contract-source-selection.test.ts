// KI-5.3-2 后续（行 e69daaef；裁决 17dbf8ba 中确认 r1 A3）——证明契约的单一
// 来源选择位置及读取方一致性判别器。已确认的分裂：proof-add 从 SPEC 派生，而
// compose 的 DELIVERED 配对在函数层没有 SPEC 路径。（修复期间发现的接线事实在此记录：
// compose/audit 调用方传入按 SPEC 优先级解析的节点文件，因此在观察到的形态上，其
// 字节本已保持一致；本修复关闭的是残余的函数层分歧与来源标签真实性，并覆盖
// proof-add 缺少 README 节点文件的边界情况。）

import { describe, it, expect } from "vitest";
import { selectProofContractBody } from "../src/domain/scope/scaffold-placeholder.js";
import { extractProofContractSelected } from "../src/domain/review/compose.js";

const PRISTINE_BODY = "- [ ] [一个承诺的交付物，以可观察结果描述——已捕获。]";
const SPEC_BODY = "- [ ] ALPHA 门：alpha 自证\n- [ ] BETA 门：beta 自证\n- [ ] GAMMA 门：gamma 自证";
const AUTHORED_PRD_BODY = "- [ ] 真实事项一\n- [ ] 真实事项二";

const doc = (body: string) => `---\nid: x\n---\n# s\n\n## Proof contract\n\n${body}\n`;

describe("selectProofContractBody——唯一选择位置（scaffold-placeholder 双生实现）", () => {
  it("观察到的分裂形态：原始 PRD + 已编写 SPEC + 无 README 时选择 SPEC", () => {
    const sel = selectProofContractBody({ prdBody: PRISTINE_BODY, specBody: SPEC_BODY, readmeBody: null });
    expect(sel.source).toBe("spec");
    expect(sel.body).toBe(SPEC_BODY);
  });

  it("即使旁边仍有旧版已编写 PRD，SPEC 仍是标准来源", () => {
    const sel = selectProofContractBody({ prdBody: AUTHORED_PRD_BODY, specBody: SPEC_BODY, readmeBody: "- [ ] README 事项" });
    expect(sel.source).toBe("spec");
    expect(sel.body).toBe(SPEC_BODY);
  });

  it("SPEC 缺失时，已编写 PRD 仍是可读的旧版回退来源", () => {
    const sel = selectProofContractBody({ prdBody: AUTHORED_PRD_BODY, specBody: null, readmeBody: "- [ ] README 事项" });
    expect(sel.source).toBe("prd");
  });

  it("原始 PRD + 无 SPEC + 已编写 README 时保留发行版节点文件回退（README 槽位）", () => {
    const sel = selectProofContractBody({ prdBody: PRISTINE_BODY, specBody: null, readmeBody: "- [ ] README 事项" });
    expect(sel.source).toBe("readme");
  });

  it("所有内容均为原始状态或缺失：来源为 null——绝不选择占位符", () => {
    const sel = selectProofContractBody({ prdBody: PRISTINE_BODY, specBody: null, readmeBody: null });
    expect(sel.source).toBeNull();
    expect(sel.body).toBeNull();
  });

  it("两者均已编写时，SPEC 优先于 README 的顺序与 NODE_FILE_PRECEDENCE 一致", () => {
    const sel = selectProofContractBody({ prdBody: null, specBody: SPEC_BODY, readmeBody: "- [ ] README 事项" });
    expect(sel.source).toBe("spec");
  });
});

describe("读取方保持一致——分裂判别器", () => {
  it("在观察到的形态上，compose 的 DELIVERED 配对选择与单一位置相同的来源及索引", () => {
    const composed = extractProofContractSelected(doc(PRISTINE_BODY), null, doc(SPEC_BODY));
    expect(composed.source).toBe("spec");
    expect(composed.items.map((i) => i.text)).toEqual([
      "ALPHA 门：alpha 自证",
      "BETA 门：beta 自证",
      "GAMMA 门：gamma 自证",
    ]);
  });

  it("compose 的旧版双参数调用（节点文件位于 README 槽位）产生相同索引——接线兼容", () => {
    const composed = extractProofContractSelected(doc(PRISTINE_BODY), doc(SPEC_BODY));
    expect(composed.items.map((i) => i.text)).toEqual([
      "ALPHA 门：alpha 自证",
      "BETA 门：beta 自证",
      "GAMMA 门：gamma 自证",
    ]);
  });
});

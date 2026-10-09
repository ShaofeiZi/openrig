// Test-A 预检阻塞项 3（行 testa-provider）——锁定 `run-evals.mjs --provider rig` 背后的 CLI
// RigSeatSession。exec 边界可注入，因此无需 daemon 即可锁定运行机制（启动/附加 identity、跨 pane
// 换行与截断的 capture-since 锚定、稳定性轮询、超时、仅退役本会话启动的内容）；live 环节是由
// 非作者运行的冻结命令。

import { describe, it, expect, vi } from "vitest";
import { createRigCliSession, sliceAfterPrompt, type RigExec } from "./helpers/eval-rig-session.js";

const WHOAMI = JSON.stringify({ session: "ops-eval@evalrig", occupantGeneration: "gen-1234", nodeId: "01NODE" });
const UP = JSON.stringify({ status: "completed", rigId: "01RIG", attachCommand: "tmux attach -t ops-eval@evalrig" });

function scriptedExec(script: (args: string[]) => string | undefined): { exec: RigExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: RigExec = async (args) => {
    calls.push(args);
    const out = script(args);
    if (out === undefined) throw new Error(`unscripted exec: ${args.join(" ")}`);
    return out;
  };
  return { exec, calls };
}

/** 基于可变状态单元的第 6 轮伪当前 generation record reader：注入的 reader 返回当前
 *  { generationId, content }，因此测试可在读取之间增长 `content`（仅追加）或滚动
 *  `generationId`（re-prime），以验证边界与 generation tripwire。 */
function genReader(state: { generationId: string; content: string }): (seat: string) => Promise<{ generationId: string; content: string }> {
  return async () => ({ generationId: state.generationId, content: state.content });
}

describe("sliceAfterPrompt——从 prompt 开始的锚点", () => {
  it("换行 echo：跨 pane 行拆开的 prompt 仍可作为锚点，输出紧随其后", () => {
    const prompt = "What can I do here in this world?";
    const capture = "old scroll\n> What can I do\nhere in this world?\nI will check rig context profile now.\n";
    const since = sliceAfterPrompt(capture, prompt, "old scroll\n");
    expect(since).toContain("I will check rig context profile now.");
    expect(since).not.toContain("old scroll");
  });

  it("截断 echo：TUI 省略的 prompt 以 prompt 开头作为锚点", () => {
    const prompt = "What can I do here in this world? Please be thorough about it.";
    const capture = "> What can I do here in th…\nrunning rig context get now\n";
    expect(sliceAfterPrompt(capture, prompt, "")).toBe("running rig context get now\n");
  });

  it("重复 prompt（r2 QA finding 1）：更早用例中的同一 prompt 不会将其响应泄漏到当前用例", () => {
    // 真实语料会在 loading.yaml 与 selection.yaml 之间重复 prompt。较早用例的响应包含
    // `rig context get`，当前用例并未拉取 context。以当前 send 边界为锚点时，只能返回当前响应。
    const prompt = "the box rebooted and everything's gone — bring the whole fleet back";
    const earlier = `> ${prompt}\nI ran rig context get skills/core/rig-lifecycle first.\n`;
    const preSend = earlier; // 当前发送之前的 pane 保留着较早用例。
    const rawCapture = earlier + `> ${prompt}\nI'll just restart it directly, no context needed.\n`;
    const since = sliceAfterPrompt(rawCapture, prompt, preSend);
    expect(since).toContain("no context needed");
    expect(since).not.toContain("rig context get");
  });

  it("重绘 footer（r2 QA finding，redraw residual）：底部重复的 input/status footer 不是边界；响应会被保留", () => {
    // 交互式 TUI 会重绘 footer，而不是将其保留为历史。发送前 footer 会重新出现在发送后 capture
    // 的底部；以 lastIndexOf(footer) 为边界会跳过新响应，而 LCS diff 会保留它。
    const prompt = "What can I do here?";
    const footer = "────────\n> \n  esc to interrupt · gpt-5.6\n";
    const preSend = `prior scrollback line\n${footer}`;
    const rawCapture = `prior scrollback line\n> ${prompt}\nNEW RESPONSE: rig context get skills/x\n${footer}`;
    const since = sliceAfterPrompt(rawCapture, prompt, preSend);
    expect(since).toContain("NEW RESPONSE: rig context get skills/x");
    expect(since).not.toBe("");
  });

  // 永久 RED（review-r2 round-5 HIGH-1，第 6 轮替换前必需）：已发布的 `rig transcript` 是有界
  // 覆盖的 pane snapshot（transcript-rotation.ts 每次 tick 覆盖文件，默认为末尾 1000 行），并非仅追加。
  // 因此无法保证发送前文本是发送后文本的前缀：当较早的相同命令向末尾滚动或滚出时，LCS 会把当前
  // turn 重新输出的内容与较早出现项匹配，并删除当前 turn evidence。此测试模拟真实有界滚动（而非伪造
  // 的仅追加来源），并保持 RED，直至边界绑定到对准确 seat generation 真正单调的来源。
  it.fails("有界滚动下的重复命令（r2 HIGH-1）：当前 turn 的命令得以保留——使用单调边界来源前保持 RED", () => {
    const prompt = "the box rebooted — bring the fleet back";
    const command = "rig context get skills/core/rig-lifecycle";
    const preRotation = `${command}\n`;                 // 较早的出现项仍在有界尾部。
    const postRotation = `> ${prompt}\n${command}\n`;   // 当前 turn 再次输出该内容。
    expect(sliceAfterPrompt(postRotation, prompt, preRotation)).toContain(command);
  });

  it("仅追加 transcript（第 5 轮 custody）：较早的相同命令留在前缀中；当前 turn 的重新输出从 suffix 返回——无需 marker", () => {
    const prompt = "the box rebooted — bring the fleet back";
    // transcript 只追加——较早用例中的相同命令行会保留在发送前 transcript 中（永远不会滚出），
    // 因此 LCS 会匹配那个出现项，而当前 turn 的重新输出就是新 suffix。正因为这一仅追加性质，第 5 轮
    // 不需要带内 marker（第 4 轮的 marker 是被禁止的第二次发送）。
    const preSend = `> ${prompt}\nrig context get skills/core/rig-lifecycle\n`;
    const post = `${preSend}> ${prompt}\nrig context get skills/core/rig-lifecycle\n`;
    const since = sliceAfterPrompt(post, prompt, preSend);
    expect(since).toContain("rig context get skills/core/rig-lifecycle");
  });

  it("已滚出的 echo：回退到发送前 snapshot 尾部", () => {
    const pre = "line a\nline b\nline c\n";
    const capture = "line b\nline c\nfresh output only\n";
    const since = sliceAfterPrompt(capture, "a prompt that is entirely gone", pre);
    expect(since).toContain("fresh output only");
    expect(since).not.toContain("line b");
  });

  it("后续真实引用仍留在 transcript 中——锚点是第一次出现的 echo", () => {
    const prompt = "pull the lifecycle entry";
    const capture = '> pull the lifecycle entry\nthinking...\nyou asked "pull the lifecycle entry" so I ran it\n';
    expect(sliceAfterPrompt(capture, prompt, "")).toBe('thinking...\nyou asked "pull the lifecycle entry" so I ran it\n');
  });
});

// Harness 修正原子（door disposition qitem-20260825080716-ad2422ab；冻结标准 sha b0a426fc...）。
// dev-qa 的真实 Test-A 运行结果为 INDETERMINATE：capture 不感知 Claude JSONL schema，而是把
// conversation record 当成不透明字符串。这些 RED-FIRST 判别测试针对当前基于字符串的 captureSince
// 锁定三个必需属性；修复必须解析 JSONL
//（messages: {type,message:{role,model,content:[{type:"text",text}],stop_reason}}），并且：
// (1) 仅在当前 assistant turn 完成后返回（终止 stop_reason）；(2) 只为 assistant/tool 输出评分
//（排除 user prompt 与 envelope）；(3) 绝不为较早 turn 或只有 footer 的片段评分。
describe("captureSince——仅输出 Claude JSONL + 原生 turn 完成（RED-first，harness 修正）", () => {
  const userMsg = (text: string) => `{"type":"user","message":{"role":"user","content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;
  const asstMsg = (text: string, stop: string | null) => `{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":${JSON.stringify(stop)},"content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;

  async function driveOne(seed: string, promptText: string, appendOnSend: string, growTo?: string) {
    const state = { generationId: "g1", content: seed };
    let sent = false;
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { sent = true; state.content = state.content + appendOnSend; return "sent"; }
      return undefined;
    });
    const reader = async () => {
      const out = { generationId: state.generationId, content: state.content };
      if (sent && growTo && !state.content.includes(growTo)) state.content = state.content + growTo;
      return out;
    };
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, stablePolls: 2, timeoutMs: 200, sleep: async () => {}, readGenerationRecord: reader }).spawn();
    await session.sendPrompt(promptText);
    return { session, calls };
  }

  it("仅输出（input-echo-negative gate）：只为 assistant 文本评分，排除 user prompt 与 JSON envelope [GREEN——JSONL 感知修复]", async () => {
    const { session } = await driveOne(
      userMsg("earlier turn") + "\n",
      "the case prompt",
      userMsg("the case prompt") + "\n",
      asstMsg("rig context get skills/core/rig-lifecycle", "end_turn") + "\n" + '{"type":"system","subtype":"turn_duration","isMeta":false}' + "\n",
    );
    const since = await session.captureSince("the case prompt");
    expect(since).toContain("rig context get skills/core/rig-lifecycle"); // 保留 assistant 输出。
    expect(since).not.toContain("the case prompt");                       // 不为 user prompt 评分。
    expect(since).not.toContain('"role":"user"');                          // 不含 user-message envelope。
    expect(since).not.toContain('"role":"assistant"');                     // 也不含 assistant-message envelope——仅文本。
    expect(since).not.toContain('stop_reason');                            // 不含传输/回复 envelope。
  });

  it("原生 turn 完成：turn 仍打开时，不会因只有 footer 或 stop_reason:null 的片段而返回 [GREEN——JSONL 感知修复]", async () => {
    // assistant message 已存在但并未完成（stop_reason 为 null），且内容趋于稳定——基于字符串的
    // captureSince 会将其返回；感知 turn 的 capture 必须继续等待（此 fixture 永不完成，因此最终超时）。
    // 提前返回就是 generation 中途出现 80-byte-footer 的缺陷。
    const { session } = await driveOne(
      userMsg("earlier") + "\n",
      "p",
      userMsg("p") + "\n" + asstMsg("partial…", null) + "\n",
      undefined,
    );
    await expect(session.captureSince("p")).rejects.toThrow(/未在 .* 内完成原生 turn|不再以内容稳定/);
  });

  it("连续 turn 分离：用例 2 的 capture 返回用例 2 输出，绝不返回用例 1 已完成的 turn", async () => {
    const state = { generationId: "g1", content: userMsg("older") + "\n" + asstMsg("case ONE output", "end_turn") + "\n" };
    let n = 0;
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { const which = n++ === 0 ? "prompt-1" : "prompt-2"; state.content = state.content + userMsg(which) + "\n" + asstMsg(`case TWO output ${which}`, "end_turn") + "\n" + '{"type":"system","subtype":"turn_duration","isMeta":false}' + "\n"; return "sent"; }
      return undefined;
    });
    const reader = async () => ({ generationId: state.generationId, content: state.content });
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, stablePolls: 2, timeoutMs: 200, sleep: async () => {}, readGenerationRecord: reader }).spawn();
    await session.sendPrompt("prompt-1");
    await session.captureSince("prompt-1");
    await session.sendPrompt("prompt-2");
    const c2 = await session.captureSince("prompt-2");
    expect(c2).toContain("case TWO output prompt-2");
    expect(c2).not.toContain("case ONE output");     // 绝不包含较早的已完成 turn。
    expect(c2).not.toContain("case TWO output prompt-1");
  });

  // Desk custody 裁定 qitem-20260825082034-6fa281f1——pins 4-5，属于同一组 RED-first 测试，
  // 标准不变：二者从机制上强制冻结的“无中间输入”custody 规则。
  it("PIN 4——中间输入 FAIL-CLOSED：从 prompt 投递到原生 turn 完成之间，额外 user-role TEXT record 进入 generation 会显著使该用例作废 [GREEN——JSONL 感知修复]", async () => {
    // 作废运行中的污染形态：seat 遵循了可执行的回复提示，第二个 user turn 落入其自身 generation。
    // 这里负责检测而非预防——harness 必须拒绝为该用例评分（损失一个用例，而非整次运行），绝不返回
    // 可评分文本。
    const { session } = await driveOne(
      userMsg("earlier turn") + "\n",
      "the case prompt",
      userMsg("the case prompt") + "\n",
      userMsg("self-sent reply-hint contamination") + "\n" + asstMsg("answer text", "end_turn") + "\n" + '{"type":"system","subtype":"turn_duration","isMeta":false}' + "\n",
    );
    await expect(session.captureSince("the case prompt")).rejects.toThrow(/用例无效|中间 user input/i);
  });

  it("PIN 5——ENVELOPE 中和：探针投递会抑制 message envelope，不让可执行的回复提示到达空白 seat [GREEN——raw-send 修复]", async () => {
    // 冻结标准中的探针在原地作答；带有回复提示的 From/To envelope 是 harness 泄漏，会主动邀请
    // pin 4 随后必须捕捉的传输动作。探针以 raw 方式发送。
    const { calls } = await driveOne(
      userMsg("earlier") + "\n",
      "the case prompt",
      userMsg("the case prompt") + "\n",
      asstMsg("answer", "end_turn") + "\n",
    );
    const sends = calls.filter((c) => c[0] === "send");
    expect(sends).toEqual([["send", "--raw", "s@r", "the case prompt"]]);
  });

  it("TOOL-CYCLE：完整 capture 多步骤 turn（assistant tool_use -> tool_result -> assistant end_turn），且 tool_result record 绝不会触发中间输入 gate", async () => {
    // runtime 以 role "user" 写入 tool_result record——它们是 assistant 自身正在进行的 tool cycle，
    // 不是中间输入；stop_reason "tool_use" 也不是终止状态，因此 capture 必须继续等待闭合 assistant
    // message，并返回整个 turn。
    const toolUse = `{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"tool_use","content":[{"type":"tool_use","name":"Bash","input":{"command":"rig context get skills/core/rig-lifecycle"}}]}}`;
    const toolResult = `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"served 1618 tokens"}]}}`;
    const { session } = await driveOne(
      userMsg("earlier turn") + "\n",
      "the case prompt",
      userMsg("the case prompt") + "\n" + toolUse + "\n",
      toolResult + "\n" + asstMsg("done: the lifecycle entry is served", "end_turn") + "\n" + '{"type":"system","subtype":"turn_duration","isMeta":false}' + "\n",
    );
    const since = await session.captureSince("the case prompt");
    expect(since).toContain("rig context get skills/core/rig-lifecycle"); // DOOR grader 匹配的 tool 命令。
    expect(since).toContain("done: the lifecycle entry is served");        // 整个 turn，而非 tool 前的片段。
    expect(since).not.toContain("tool_result");                            // 不含 envelope。
    expect(since).not.toContain("the case prompt");                        // 依然仅含输出。
  });

  // 第 10 轮修复（r2 R9 NOT-CLEAR，行 e9d51ca6；artifact 69dfddb6）——两种形态均追溯自保留的
  // 真实 generation .../convergence-test-a-d99e44672-20260825T072921Z-dev-qa/runs/run-01/
  // transcripts/99-aborted-full-generation.jsonl，并非凭空构造。
  it("HIGH-1——原生 Skill continuation（tool_result record + 独立 isMeta/sourceToolUseID text record）不是中间输入 [GREEN——causal-field 分类]", async () => {
    // 样本行 43/47/48/49/40/41：prompt（STRING content）-> Skill tool_use -> user tool_result ->
    // 携带顶层 isMeta:true + sourceToolUseID 的 user TEXT record（已加载 skill body）-> assistant
    // end_turn text -> system turn_duration。按 role + content type 分类会把 skill body 算作第二条
    // user input，从而使合法 tool cycle 作废。
    const promptRec = `{"type":"user","message":{"role":"user","content":"the case prompt"}}`;
    const skillUse = `{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"tool_use","content":[{"type":"tool_use","name":"Skill","input":{"command":"forming-an-openrig-mental-model"}}]}}`;
    const toolResult = `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Launching skill"}]}}`;
    const skillBody = `{"type":"user","isMeta":true,"sourceToolUseID":"toolu_01QpK4","message":{"role":"user","content":[{"type":"text","text":"# Skill body — forming an openrig mental model"}]}}`;
    const finalText = `{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"end_turn","content":[{"type":"text","text":"final answer: rig whoami then rig context list"}]}}`;
    const turnEnd = `{"type":"system","subtype":"turn_duration","isMeta":false}`;
    const { session } = await driveOne(
      "",
      "the case prompt",
      promptRec + "\n" + skillUse + "\n",
      toolResult + "\n" + skillBody + "\n" + finalText + "\n" + turnEnd + "\n",
    );
    const since = await session.captureSince("the case prompt"); // 不得抛出“用例无效”。
    expect(since).toContain("final answer: rig whoami then rig context list");
  });

  it("HIGH-2——先出现终止 THINKING record 不会结束 turn：capture 等待 turn-closure record 并返回最终 TEXT [GREEN——closure-boundary 完成]", async () => {
    // 样本行 39/40/41：T 时刻出现 assistant end_turn（thinking），92ms 后出现 assistant end_turn
    //（text），随后是 system/turn_duration。在第一条终止 assistant record 上返回会产生 out:""，
    // grader 永远看不到用户可见答案。
    const promptRec = `{"type":"user","message":{"role":"user","content":"p"}}`;
    const terminalThinking = `{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"end_turn","content":[{"type":"thinking","thinking":"deciding what to answer"}]}}`;
    const terminalText = `{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"end_turn","content":[{"type":"text","text":"THE FINAL VISIBLE ANSWER"}]}}`;
    const turnEnd = `{"type":"system","subtype":"turn_duration","isMeta":false}`;
    const { session } = await driveOne(
      "",
      "p",
      promptRec + "\n" + terminalThinking + "\n",       // 首次读取只暴露终止 thinking chunk。
      terminalText + "\n" + turnEnd + "\n",             // text 与 closure 在下一次读取时到达。
    );
    const since = await session.captureSince("p");
    expect(since).toContain("THE FINAL VISIBLE ANSWER");
  });

  it("GUARD（r2 必需）：Skill continuation 有效时，第二条真实 prompt 仍以 fail-closed 方式使该用例失败", async () => {
    const promptRec = `{"type":"user","message":{"role":"user","content":"the case prompt"}}`;
    const skillBody = `{"type":"user","isMeta":true,"sourceToolUseID":"toolu_01QpK4","message":{"role":"user","content":[{"type":"text","text":"skill body"}]}}`;
    const secondPrompt = `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"a second actual prompt — contamination"}]}}`;
    const finalText = `{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"end_turn","content":[{"type":"text","text":"answer"}]}}`;
    const turnEnd = `{"type":"system","subtype":"turn_duration","isMeta":false}`;
    const { session } = await driveOne(
      "",
      "the case prompt",
      promptRec + "\n",
      skillBody + "\n" + secondPrompt + "\n" + finalText + "\n" + turnEnd + "\n",
    );
    await expect(session.captureSince("the case prompt")).rejects.toThrow(/用例无效|中间 user input/i);
  });
});

describe("createRigCliSession——启动/附加、轮询与退役", () => {
  it("CUSTODY（Test-A 无中间输入，第 6 轮）：sendPrompt 只提交一次 rig send——自然 prompt，绝不提交 marker", async () => {
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") return "sent";
      return undefined;
    });
    const session = await createRigCliSession({
      seat: "ops-eval@evalrig", exec,
      readGenerationRecord: genReader({ generationId: "g1", content: "prior record\n" }),
    }).spawn();
    await session.sendPrompt("the natural prompt");
    // 冻结的 custody 契约禁止 BASELINE 与 POST 之间出现任何中间输入。每个用例只提交一次 send，
    // 即自然 prompt——没有 eval-sync marker；边界读取通过带外进行。
    const sends = calls.filter((c) => c[0] === "send");
    expect(sends).toEqual([["send", "--raw", "ops-eval@evalrig", "the natural prompt"]]); // 按 PIN 5 使用 raw——抑制 envelope，仍只有一次 send。
    expect(calls.some((c) => c[0] === "send" && c.slice(1).some((a) => /eval-sync/.test(a ?? "")))).toBe(false);
  });

  it("启动：rig up -> 接管 attach session，从 whoami 取得 generation，退役时只拆除一次已启动 rig", async () => {
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "up") return UP;
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "down") return "torn down";
      return undefined;
    });
    const session = await createRigCliSession({ spec: "/tmp/eval-rig.yaml", exec }).spawn();
    expect(session.generation).toBe("gen-1234");
    await session.retire();
    // teardown 以 `rig up` 返回的 rigId 为目标（即使 attach 行无法解析，该值仍存在）。
    expect(calls.filter((c) => c[0] === "down")).toEqual([["down", "01RIG"]]);
  });

  it("附加：通过 whoami 验证具名 seat，退役时绝不拆除它", async () => {
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      return undefined;
    });
    const session = await createRigCliSession({ seat: "ops-eval@evalrig", exec }).spawn();
    expect(session.generation).toBe("gen-1234");
    await session.retire();
    expect(calls.some((c) => c[0] === "down")).toBe(false);
  });

  it("空 identity 清理（r2 QA finding 2）：whoami 成功但未返回 generation -> 拆除已启动 rig", async () => {
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "up") return JSON.stringify({ status: "completed", rigId: "01RIGX", attachCommand: "tmux attach -t p-s@evalx" });
      if (args[0] === "whoami") return JSON.stringify({ resolvedBy: "session", identity: {}, peers: [] }); // 无 generation。
      if (args[0] === "down") return "torn down";
      return undefined;
    });
    await expect(createRigCliSession({ spec: "/tmp/r.yaml", exec }).spawn()).rejects.toThrow(/稳定的 seat generation/);
    expect(calls.filter((c) => c[0] === "down")).toEqual([["down", "01RIGX"]]);
  });

  it("无法解析 attach 时清理（r2 QA finding 2）：rig up 已完成但无 attach session -> 按 rigId 拆除 rig", async () => {
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "up") return JSON.stringify({ status: "completed", rigId: "01RIGY", attachCommand: "" }); // 无 -t session。
      if (args[0] === "down") return "torn down";
      return undefined;
    });
    await expect(createRigCliSession({ spec: "/tmp/r.yaml", exec }).spawn()).rejects.toThrow(/未启动 seat/);
    expect(calls.filter((c) => c[0] === "down")).toEqual([["down", "01RIGY"]]);
  });

  it("必须且只能提供 seat/spec 之一，并显著报错", () => {
    expect(() => createRigCliSession({})).toThrow(/必须且只能提供/);
    expect(() => createRigCliSession({ seat: "a", spec: "b" })).toThrow(/必须且只能提供/);
  });

  it("记录发送前 generation record，随后 captureSince 等待原生 turn 完成，并返回已追加 suffix 中的 assistant 输出", async () => {
    const state = { generationId: "g1", content: '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"prior record line"}]}}\n' };
    let sent = false;
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { sent = true; state.content = state.content + '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"the natural prompt"}]}}\n'; return "sent"; }
      return undefined;
    });
    // 仅追加 record 会随读取增长：seat 追加其已完成 turn。
    const readGenerationRecord = async () => {
      const out = { generationId: state.generationId, content: state.content };
      if (sent && !state.content.includes("DONE")) state.content = state.content + '{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"end_turn","content":[{"type":"text","text":"DONE rig context get skills/x"}]}}\n{"type":"system","subtype":"turn_duration","isMeta":false}\n';
      return out;
    };
    const session = await createRigCliSession({ seat: "ops-eval@evalrig", exec, pollMs: 1, stablePolls: 2, sleep: async () => {}, readGenerationRecord }).spawn();
    await session.sendPrompt("the natural prompt");
    const since = await session.captureSince("the natural prompt");
    expect(since).toContain("DONE rig context get skills/x");
    expect(since).not.toContain("prior record line"); // 发送前内容是被切除的前缀，而非当前 turn。
  });

  it("始终无法完成原生 turn 的 seat 会以错误超时，绝不静默返回部分结果", async () => {
    const state = { generationId: "g1", content: "x\n" };
    let n = 0;
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") return "sent";
      return undefined;
    });
    const readGenerationRecord = async () => { state.content = state.content + `line ${n++}\n`; return { generationId: state.generationId, content: state.content }; }; // 持续增长，但 generation 不变。
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, timeoutMs: 30, sleep: async () => {}, readGenerationRecord }).spawn();
    await session.sendPrompt("p");
    await expect(session.captureSince("p")).rejects.toThrow(/未在 .* 内完成原生 turn/);
  });

  it("容忍短暂 record 读取失败——daemon 延迟超时时会重试，而非令用例失败", async () => {
    const state = { generationId: "g1", content: "idle\n" };
    let sent = false;
    let readCall = 0;
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { sent = true; state.content = state.content + "> the prompt\n"; return "sent"; }
      return undefined;
    });
    const readGenerationRecord = async () => {
      readCall++;
      // sendPrompt 的读取是第 1 次；让若干 capture 轮询短暂失败，随后完成 turn。
      if (readCall === 2 || readCall === 3) throw new Error("Daemon did not respond in time");
      if (sent && !state.content.includes("DONE")) state.content = state.content + '{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"end_turn","content":[{"type":"text","text":"DONE rig context get skills/x"}]}}\n{"type":"system","subtype":"turn_duration","isMeta":false}\n';
      return { generationId: state.generationId, content: state.content };
    };
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, stablePolls: 2, sleep: async () => {}, readGenerationRecord }).spawn();
    await session.sendPrompt("the prompt");
    const since = await session.captureSince("the prompt");
    expect(since).toContain("DONE rig context get skills/x");
  });

  it("持续 record 读取失败意味着 daemon 已失联——达到连续失败上限后显著报错", async () => {
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") return "sent";
      return undefined;
    });
    let first = true;
    const readGenerationRecord = async () => { if (first) { first = false; return { generationId: "g1", content: "seed\n" }; } throw new Error("Daemon did not respond in time"); };
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, timeoutMs: 60_000, sleep: async () => {}, readGenerationRecord }).spawn();
    await session.sendPrompt("p");
    await expect(session.captureSince("p")).rejects.toThrow(/连续 .* 次读取|daemon 无响应/);
  });

  it("GENERATION-CHANGE TRIPWIRE（desk 裁定约束 3）：观测中 re-prime 会显著失败，绝不跨切换读取", async () => {
    const state = { generationId: "g1", content: "gen-1 record\n" };
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { state.content = state.content + "> p\n"; return "sent"; }
      return undefined;
    });
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, stablePolls: 2, sleep: async () => {}, readGenerationRecord: genReader(state) }).spawn();
    await session.sendPrompt("p"); // 绑定 generation g1。
    // re-prime 在观测过程中滚动 generation，并启动新 record。
    state.generationId = "g2";
    state.content = "gen-2 fresh record\n";
    await expect(session.captureSince("p")).rejects.toThrow(/generation 在观测期间发生变化/);
  });

  it("SESSION-LIFETIME generation 绑定（r2 round-7 HIGH-1）：用例之间 re-prime 会在第二次发送前拒绝，绝不重新绑定", async () => {
    const state = { generationId: "g1", content: "gen-1 record\n" };
    let n = 0;
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { state.content = state.content + `{"type":"user","message":{"role":"user","content":[{"type":"text","text":${JSON.stringify(args[3])}}]}}\n{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"end_turn","content":[{"type":"text","text":"completed ${n++}"}]}}\n{"type":"system","subtype":"turn_duration","isMeta":false}\n`; return "sent"; }
      return undefined;
    });
    const session = await createRigCliSession({ seat: "s@r", exec, pollMs: 1, stablePolls: 2, sleep: async () => {}, readGenerationRecord: genReader(state) }).spawn();
    // 用例 1 绑定 session generation g1。
    await session.sendPrompt("case-1");
    expect(await session.captureSince("case-1")).toContain("completed");
    // re-prime 在用例之间滚动 generation（新的原生 session/JSONL）。
    state.generationId = "g2";
    state.content = "gen-2 fresh record\n";
    // 用例 2 必须在发送前拒绝——session 绑定为 g1，且永不覆盖。
    await expect(session.sendPrompt("case-2")).rejects.toThrow(/generation 在用例之间发生变化/);
    expect(calls.filter((c) => c[0] === "send").map((c) => c[3])).toEqual(["case-1"]); // argv：send --raw <seat> <prompt>。
  });

  it("显著拒绝（约束 2）：未接入 generation-record reader -> sendPrompt 拒绝执行，绝不回退到 pane", async () => {
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") return "sent";
      return undefined;
    });
    const session = await createRigCliSession({ seat: "s@r", exec, sleep: async () => {} }).spawn(); // 无 readGenerationRecord。
    await expect(session.sendPrompt("p")).rejects.toThrow(/要求注入 readGenerationRecord/);
  });

  it("显著拒绝（约束 2）：不支持的 runtime（reader 抛错）会显著向上传播，绝不静默降级", async () => {
    const { exec } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") return "sent";
      return undefined;
    });
    const readGenerationRecord = async () => { throw new Error("seat is a codex seat with no Claude generation JSONL — observation refused"); };
    const session = await createRigCliSession({ seat: "s@r", exec, sleep: async () => {}, readGenerationRecord }).spawn();
    await expect(session.sendPrompt("p")).rejects.toThrow(/no Claude generation JSONL|observation refused/);
  });
});

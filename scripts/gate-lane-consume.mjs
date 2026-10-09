#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function refuse(message) {
  throw new Error(`[gate-consume] 拒绝：${message}`);
}

/** 兑现一条确切的真实闸门裁决，随后删除它，使其不能被重复使用。 */
export function consumeGateVerdict({ verdictPath, headSha, log = console.log }) {
  if (!existsSync(verdictPath)) refuse(`裁决缺失：${verdictPath}`);
  let verdict;
  try {
    verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
  } catch (error) {
    refuse(`裁决不是合法 JSON：${error?.message ?? error}`);
  }
  if (typeof verdict?.candidateSha !== "string" || verdict.candidateSha.length === 0) {
    refuse("candidateSha 为必填");
  }
  if (verdict.candidateSha !== headSha) {
    refuse(`candidateSha 与当前 HEAD 不匹配（verdict=${verdict.candidateSha}，HEAD=${headSha}）`);
  }
  if (verdict.gate !== "pass") refuse(`gate 必须为 "pass"（收到 ${JSON.stringify(verdict.gate)}）`);
  if (verdict.smoke !== false) refuse("smoke 必须严格为 false；只能兑现真实闸门裁决");

  unlinkSync(verdictPath);
  if (existsSync(verdictPath)) refuse(`删除后裁决文件仍存在：${verdictPath}`);
  log(`[gate-consume] 已兑现并消耗候选 ${headSha}；已删除 ${verdictPath}`);
  return verdict;
}

function readHead(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) refuse(`无法取得当前 HEAD：${result.stderr.trim()}`);
  return result.stdout.trim();
}

function main() {
  const root = process.cwd();
  const verdictPath = resolve(process.argv[2] ?? process.env.OPENRIG_GATE_VERDICT ?? join(root, "gate-lane-verdict.json"));
  consumeGateVerdict({ verdictPath, headSha: readHead(root) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}

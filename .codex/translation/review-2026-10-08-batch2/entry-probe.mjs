#!/usr/bin/env node
// Entry probe: validate rig/zrig/openrig --version/--help/unknown --json.
// Exits 0 if all assertions pass, nonzero otherwise. ESM (.mjs).
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = '/Users/bytedance/openrig';
const WRAP = path.join(ROOT, 'packages/cli/dist/bin-wrapper.js');
const bins = ['rig', 'zrig', 'openrig'];
let fail = 0;

function run(bin, args) {
  try {
    const out = execFileSync('node', [WRAP, ...args], {
      env: { ...process.env, OPENRIG_INVOKED_AS: bin },
      encoding: 'utf8', timeout: 10000, stdio: ['pipe','pipe','pipe']
    });
    return { rc: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { rc: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

for (const bin of bins) {
  // version
  const v = run(bin, ['--version']);
  if (v.rc !== 0 || v.stderr !== '' || !/^\d+\.\d+\.\d+/.test(v.stdout.trim())) {
    console.error(`[FAIL] ${bin} --version rc=${v.rc} stderr=${v.stderr.trim()} out=${v.stdout.trim()}`);
    fail++;
  } else {
    console.error(`[OK] ${bin} --version = ${v.stdout.trim()}`);
  }
  // help: first line must be `用法： <bin>` (case-sensitive, exact bin)
  const h = run(bin, ['--help']);
  const first = h.stdout.split('\n')[0] ?? '';
  if (h.rc !== 0 || h.stderr !== '') {
    console.error(`[FAIL] ${bin} --help rc=${h.rc} stderr=${h.stderr.trim()}`);
    fail++;
  } else if (!first.includes(`用法： ${bin}`) && !first.includes(`用法: ${bin}`)) {
    console.error(`[FAIL] ${bin} --help first line missing "用法： ${bin}": ${first}`);
    fail++;
  } else {
    console.error(`[OK] ${bin} --help first: ${first}`);
  }
  // unknown: expect rc=1, stdout JSON {ok:false,error:{code,message中文}}, stderr empty
  const u = run(bin, ['__unknown__', '--json']);
  if (u.rc !== 1) {
    console.error(`[FAIL] ${bin} unknown rc=${u.rc} (expected 1)`);
    fail++;
  } else if (u.stderr !== '') {
    console.error(`[FAIL] ${bin} unknown stderr not empty: ${u.stderr.trim()}`);
    fail++;
  } else {
    try {
      const j = JSON.parse(u.stdout);
      if (j.ok !== false || j.error?.code !== 'commander.unknownCommand' ||
          typeof j.error?.message !== 'string' || !/\p{Script=Han}/u.test(j.error.message)) {
        console.error(`[FAIL] ${bin} unknown JSON wrong shape: ${u.stdout.trim()}`);
        fail++;
      } else {
        console.error(`[OK] ${bin} unknown code=${j.error.code} msg=${j.error.message.slice(0,40)}`);
      }
    } catch (e) {
      console.error(`[FAIL] ${bin} unknown not JSON: ${u.stdout.trim()}`);
      fail++;
    }
  }
}
process.exit(fail);

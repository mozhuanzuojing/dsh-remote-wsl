/**
 * assert-t60.ts —— T69：我对 T60 的**独立断言**（不含他们的任何判据代码）。
 *
 * 用法：node assert-t60.ts <prefix.json> <head.json>
 * exit：0 = 全部成立（缺陷可复现 + HEAD 已修）；1 = 有断言不成立；2 = 用法/读取错误
 *
 * 我断言的两件事（都打在 `WebHost.start()` 的"可用态判据"上，而不是工具层返回串）：
 *   ① 改动前：半死态（child 有/url 无）下同端口再 start() ⇒ **静默返回 null 且 0ms**、且**不自清**；
 *   ② HEAD  ：同一注入下 ⇒ **绝不返回 null**、且**把半死尝试真的丢掉**、且不是"卡死冒充修复"。
 */
import fs from 'node:fs';

type R = {
	tree: string;
	outcome: { kind: string; ms?: number; valueHead?: string; error?: string };
	childAfter: string;
	urlAfter: string;
	scriptAfter: string;
	injectedChildKilled: boolean;
	killCalls: number;
};

const [, , prefixPath, headPath] = process.argv;
if (!prefixPath || !headPath) {
	console.error('用法：node assert-t60.ts <prefix.json> <head.json>');
	process.exit(2);
}
const read = (p: string): R => JSON.parse(fs.readFileSync(p, 'utf8')) as R;
let pre: R, head: R;
try {
	pre = read(prefixPath);
	head = read(headPath);
} catch (e) {
	console.error('读不到读数：' + (e as Error).message);
	process.exit(2);
}

const out: { ok: boolean; name: string; detail: string }[] = [];
const ok = (n: string, d = '') => out.push({ ok: true, name: n, detail: d });
const bad = (n: string, d = '') => out.push({ ok: false, name: n, detail: d });

// A1 改动前必须能复现"静默假成功"（这正是 T60 要修的现象）
if (pre.outcome.kind === 'resolved_null' && (pre.outcome.ms ?? 1e9) < 200) {
	ok('A1 改动前复现：静默假成功（resolved null, 0ms 级）', `kind=${pre.outcome.kind} ms=${pre.outcome.ms}`);
} else {
	bad('A1 改动前复现：静默假成功', `kind=${pre.outcome.kind} ms=${pre.outcome.ms}（没复现出来 ⇒ 我验的对象可能不是改动前）`);
}

// A2 改动前还不自清（半死对象留着、注入 child 未被 kill）
if (pre.childAfter !== 'null' && pre.killCalls === 0) {
	ok('A2 改动前：半死对象被留着、未丢弃', `childAfter=${pre.childAfter} killCalls=${pre.killCalls}`);
} else {
	bad('A2 改动前：半死对象被留着', `childAfter=${pre.childAfter} killCalls=${pre.killCalls}`);
}

// A3 HEAD 绝不静默返回 null/undefined（"要么真起、要么明确报错"）
if (head.outcome.kind !== 'resolved_null' && head.outcome.kind !== 'resolved_undefined') {
	ok('A3 HEAD：不再静默假成功', `kind=${head.outcome.kind}${head.outcome.error ? ' err=' + String(head.outcome.error).slice(0, 70) : ''}`);
} else {
	bad('A3 HEAD：不再静默假成功', `kind=${head.outcome.kind} ⇒ 修复不成立`);
}

// A4 HEAD 必须把半死尝试真的丢掉（T60 的第二半）
if (head.injectedChildKilled === true && head.killCalls >= 1) {
	ok('A4 HEAD：半死尝试被丢弃（kill 真的调用）', `killCalls=${head.killCalls}`);
} else {
	bad('A4 HEAD：半死尝试被丢弃', `killed=${head.injectedChildKilled} killCalls=${head.killCalls}`);
}

// A5 HEAD 不留半死状态
if (head.childAfter === 'null' && head.scriptAfter === 'null' && head.urlAfter === 'null') {
	ok('A5 HEAD：不留半死状态（child/script/url 全回初始）', `child=${head.childAfter} script=${head.scriptAfter} url=${head.urlAfter}`);
} else {
	bad('A5 HEAD：不留半死状态', `child=${head.childAfter} script=${head.scriptAfter} url=${head.urlAfter}`);
}

// A6 不能是"卡死"冒充"修复"
if (head.outcome.kind !== 'timeout') ok('A6 HEAD：不是超时冒充修复', `kind=${head.outcome.kind} ms=${head.outcome.ms}`);
else bad('A6 HEAD：不是超时冒充修复', '出现 HARNESS_TIMEOUT（既没起来也没报错）');

for (const r of out) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
const fails = out.filter((r) => !r.ok);
console.log(`\nassert-t60: ${out.length - fails.length}/${out.length} PASS`);
process.exit(fails.length ? 1 : 0);

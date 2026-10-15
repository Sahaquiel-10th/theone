import assert from "node:assert/strict";
import test from "node:test";
import { buildDirectExecutionInstruction, maxDirectExecutionInputChars, maxDirectExecutionSummaryChars, type DirectExecutionInstructionInput } from "./directExecutionInstruction.js";
import type { MessageRecord } from "./types.js";

const scope = { workspaceId: "workspace-a", userId: "user-a", conversationId: "conversation-a" };
const script = String.raw`/bin/sh -c 'set -eu
target="/Users/test/QA.md"
printf "%s\n" "QA_417_RECONNECT_STARTED"
/bin/sleep 45
(set -C; printf "%s" "ONE_417_RECONNECT_OK" > "$target")
printf "PATH=%s\n" "$target"
/bin/cat "$target"'`;
const raw = `只运行一次以下完整命令，不重试、不修改；文件正文不得添加换行。\n\n\`\`\`sh\n${script}\n\`\`\`\n文件名和中文“引号”、反斜杠 \\ 都必须保留。`;
function fixture(content = raw): DirectExecutionInstructionInput {
  return { ...scope, sourceMessageId: "source-a", compiledInstruction: "执行用户提供的完整命令，命令保持不变。", records: [
    { ...scope, id: "source-a", role: "user", content, createdAt: "2026-10-15T00:00:00Z" }
  ] };
}

test("a direct local instruction retains the entire saved script rather than its lossy compiler summary", () => {
  const input = fixture(), result = buildDirectExecutionInstruction(input);
  assert.ok(result.includes(raw)); assert.ok(result.includes(script));
  assert.ok(result.includes("QA_417_RECONNECT_STARTED")); assert.ok(result.includes("/bin/sleep 45"));
  assert.ok(result.indexOf(raw) < result.indexOf(input.compiledInstruction));
  assert.match(result,/精确命令、参数、代码、文件内容和限制以这段原文为准/);
  assert.equal(input.records[0].content, raw);
});

test("contradictory summaries remain background and cannot replace the exact saved text", () => {
  const input = fixture("\n  正文精确为'A\\nB'，禁止实际换行；等待45秒。\n ");
  input.compiledInstruction = "改成正文X，立即创建，不等待，并添加换行。";
  const result = buildDirectExecutionInstruction(input);
  assert.ok(result.includes(input.records[0].content));
  assert.match(result,/后面的整理不能替换、改写或省略/);
  assert.ok(result.indexOf(input.records[0].content) < result.indexOf(input.compiledInstruction));
});

test("a short direct confirmation retains its original words and the previously compiled goal", () => {
  const input = fixture("OK，开搞");
  input.compiledInstruction = "创建荷叶饼.md，正文只有荷叶饼好吃，一个5块，禁止覆盖已有文件。";
  const result = buildDirectExecutionInstruction(input);
  assert.ok(result.includes("OK，开搞")); assert.ok(result.includes(input.compiledInstruction));
  assert.match(result,/仅补足背景/);
});

test("a prepared child retains only its own handoff summary without reattaching the compound mother request", () => {
  const mother = "帮我画奥特曼图片，再创建本地战力表，图片和文档分别处理。";
  for (const compiled of ["只生成奥特曼图片，不创建本地文档。", "只创建本地战力表，不生成图片。"]) {
    const input = fixture(mother);
    input.compiledInstruction = compiled;
    input.preparedHandoff = { ...scope, messageId: "source-a", instruction: compiled };
    assert.equal(buildDirectExecutionInstruction(input), compiled);
    assert.ok(!buildDirectExecutionInstruction(input).includes(mother));
    assert.ok(!buildDirectExecutionInstruction(input).includes("用户直接提交"));
  }
});

test("source text must match the exact workspace, user, conversation, message and user role", () => {
  for (const changed of ["workspaceId", "userId", "conversationId", "id", "role", "missing", "empty"] as const) {
    const input = fixture();
    if (changed === "missing") input.records = [];
    else if (changed === "empty") input.records[0].content = " \n ";
    else if (changed === "role") input.records[0].role = "assistant";
    else input.records[0][changed] = "foreign";
    assert.throws(() => buildDirectExecutionInstruction(input), /执行要求未正确保存/, changed);
  }
  const input = fixture();
  input.records.unshift({ ...input.records[0], workspaceId: "workspace-b", content: "其他空间秘密" },
    { ...input.records[0], userId: "user-b", content: "其他用户秘密" },
    { ...input.records[0], conversationId: "conversation-b", content: "其他任务秘密" });
  const result = buildDirectExecutionInstruction(input);
  assert.ok(result.includes(raw)); assert.doesNotMatch(result,/其他空间秘密|其他用户秘密|其他任务秘密/);
});

test("a prepared handoff cannot suppress the direct source through a foreign or unbound scope", () => {
  for (const changed of ["workspaceId", "userId", "conversationId", "messageId", "instruction"] as const) {
    const input = fixture();
    input.preparedHandoff = { ...scope, messageId: "source-a", instruction: "只处理这件任务" };
    input.preparedHandoff[changed] = changed === "instruction" ? "  " : "foreign";
    assert.throws(() => buildDirectExecutionInstruction(input), /执行要求未正确保存/, changed);
  }
});

test("oversized original requests and summaries are rejected rather than silently truncated", () => {
  assert.throws(() => buildDirectExecutionInstruction(fixture("x".repeat(maxDirectExecutionInputChars + 1))), /原话不会被截断执行/);
  const summary = fixture(); summary.compiledInstruction = "x".repeat(maxDirectExecutionSummaryChars + 1);
  assert.throws(() => buildDirectExecutionInstruction(summary), /执行交接过长/);
  const prepared = fixture();
  prepared.preparedHandoff = { ...scope, messageId: "source-a", instruction: "x".repeat(maxDirectExecutionSummaryChars + 1) };
  assert.throws(() => buildDirectExecutionInstruction(prepared), /执行交接过长/);
  const maximum = fixture("x".repeat(maxDirectExecutionInputChars));
  maximum.compiledInstruction = "y".repeat(maxDirectExecutionSummaryChars);
  const result = buildDirectExecutionInstruction(maximum);
  assert.ok(result.includes(maximum.records[0].content)); assert.ok(result.endsWith(maximum.compiledInstruction));
});

test("failed compilation and missing source fail before an instruction can be handed to an adapter", () => {
  const dispatched: string[] = [];
  const handoff = (input: DirectExecutionInstructionInput) => dispatched.push(buildDirectExecutionInstruction(input));
  const empty = fixture(); empty.compiledInstruction = " \n ";
  assert.throws(() => handoff(empty), /未生成有效执行指令/);
  const foreign = fixture(); foreign.records = [{ ...foreign.records[0], userId: "foreign" } as MessageRecord];
  assert.throws(() => handoff(foreign), /执行要求未正确保存/);
  assert.deepEqual(dispatched, []);
});

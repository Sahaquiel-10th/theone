import assert from "node:assert/strict";
import test from "node:test";
import type { Store } from "./db.js";
import type { Database, ModelConfig } from "./types.js";
import { accountProfile, completeOnboardingOnChat, updateAccountProfile } from "./betaProfile.js";
import { handbookInstruction, onboardingHandbookOffer, resolvedOnboardingHandbookProfile, startOnboardingHandbook, welcomeDelivery, type OnboardingImageInput } from "./onboardingHandbook.js";
import { defaultTaskValues, updateTaskConfig } from "./aiTaskConfig.js";

const scope = { workspaceId: "wa", userId: "a" };
const key = async () => {};
function fixture() {
  const model: ModelConfig = { id: "image-key", name: "public name", provider: "gateway", kind: "chat", protocol: "openai", baseUrl: "https://private-endpoint.example", apiKey: "SECRET_API_KEY", enabled: true, isDefault: true, model: "test-image-model", systemPrompt: "PRIVATE_MODEL_PROMPT", inputPowerPerMillion: 1, outputPowerPerMillion: 1, costInputPowerPerMillion: 1, costOutputPowerPerMillion: 1, createdAt: "today" };
  const db = {
    users: [{ id: "a", username: "PRIVATE_LOGIN_A", enabled: true, defaultWorkspaceId: "wa", role: "user", createdAt: "today" }, { id: "b", username: "PRIVATE_LOGIN_B", enabled: true, defaultWorkspaceId: "wb", role: "user", createdAt: "today" }],
    workspaces: [{ id: "wa", status: "active" }, { id: "wb", status: "active" }], workspaceMembers: [{ workspaceId: "wa", userId: "a", role: "owner" }, { workspaceId: "wb", userId: "b", role: "owner" }],
    knowledgeConnections: [], conversations: [], messages: [], models: [model], chatOperations: [], modelUsageRecords: [], powerAccounts: [{ ...scope, id: "power", balanceMicros: 1_000_000 }],
    settings: { aiTasks: { image_generation: { published: { ...defaultTaskValues("image_generation"), modelId: model.id, imagePowerPerCall: .012, costImagePowerPerCall: .02, version: 1 } } } },
  } as unknown as Database;
  const store: Store = { read: async () => db, mutate: async fn => fn(db) };
  const welcome = () => { updateAccountProfile(db, scope, { displayName: "小马" }); updateAccountProfile(db, scope, { onboardingAction: "knowledge_skipped" }); updateAccountProfile(db, scope, { onboardingAction: "complete", handbookChoice: "create", handbookBudgetPower: .012 }); };
  function accepted(input: OnboardingImageInput, taskId = "guide-task") {
    db.conversations.push({ ...scope, id: taskId } as never);
    db.chatOperations!.push({ ...scope, id: "welcome-job", operationId: `${input.operationId}_image`, requestId: "image-request", payloadHash: "fixture", status: "pending", conversationId: taskId, createdAt: "now", updatedAt: "now", workRun: { kind: "image", state: "queued" } as never });
    return taskId;
  }
  return { db, store, welcome, accepted };
}

test("an image published through the admin path is offered and queued without a coordinator enable flag", async () => {
  const f = fixture(); f.welcome();
  f.db.settings.aiTasks = {};
  updateTaskConfig(f.db.settings, f.db.models, "image_generation", { revision: 0, action: "draft", values: {
    ...defaultTaskValues("image_generation"), modelId: "image-key", imagePowerPerCall: .012, costImagePowerPerCall: .02,
  } }, "admin", "now");
  const config = updateTaskConfig(f.db.settings, f.db.models, "image_generation", { revision: 1, action: "publish" }, "admin", "now");
  assert.equal(config.published!.enabled, undefined);
  assert.deepEqual(onboardingHandbookOffer(f.db, true), { available: true, pricePower: .012 });
  assert.deepEqual(onboardingHandbookOffer(f.db, false), { available: false });
  let calls = 0;
  const result = await startOnboardingHandbook(f.store, scope, { storageAvailable: true, verifyKey: key,
    enqueueImage: async (_scope, input) => { calls++; return f.accepted(input); } });
  assert.equal(result.handbook?.status, "queued");
  assert.equal(calls, 1);
});

test("first explicit welcome choice creates one claim; existing, chat-skipped and opted-out accounts do not", () => {
  const f = fixture(); f.welcome();
  const operationId = accountProfile(f.db, scope).onboarding.handbook!.operationId;
  updateAccountProfile(f.db, scope, { onboardingAction: "complete", handbookChoice: "create", handbookBudgetPower: .5 });
  assert.equal(accountProfile(f.db, scope).onboarding.handbook!.operationId, operationId);
  assert.equal(accountProfile(f.db, scope).onboarding.handbook!.maxPower, .012);
  for (const previous of ["conversation", "complete", "chat", "skip"]) {
    const x = fixture(); updateAccountProfile(x.db, scope, { displayName: "A" }); updateAccountProfile(x.db, scope, { onboardingAction: "knowledge_skipped" });
    if (previous === "conversation") x.db.conversations.push({ ...scope, id: "old", archived: true } as never);
    if (previous === "complete") updateAccountProfile(x.db, scope, { onboardingAction: "complete" });
    if (previous === "chat") completeOnboardingOnChat(x.db, scope);
    updateAccountProfile(x.db, scope, { onboardingAction: "complete", handbookChoice: previous === "skip" ? "skip" : "create", ...(previous !== "skip" ? { handbookBudgetPower: .012 } : {}) });
    assert.equal(accountProfile(x.db, scope).onboarding.handbook, undefined, previous);
  }
  assert.throws(() => updateAccountProfile(f.db, scope, { displayName: "B", handbookChoice: "create" }), /首次引导/);
  assert.equal(accountProfile(f.db, scope).displayName, "小马");
});

test("welcome price cannot exceed the displayed consent; a cheaper price is accepted without reapplying multipliers", async () => {
  for (const price of [.4, .5, .006]) {
    const f = fixture(); f.welcome(); f.db.settings.aiTasks!.image_generation!.published!.imagePowerPerCall = price;
    let calls = 0, budget = 0;
    const result = await startOnboardingHandbook(f.store, scope, { storageAvailable: true, verifyKey: key, enqueueImage: async (_s, input) => { calls++; budget = input.budget; return f.accepted(input); } });
    assert.equal(calls, price > .012 ? 0 : 1);
    assert.equal(result.handbook?.status, price > .012 ? "skipped" : "queued");
    if (price > .012) assert.equal(result.handbook?.reason, "budget_required"); else assert.equal(budget, .006);
  }
  const f = fixture(); updateAccountProfile(f.db, scope, { displayName: "A" }); updateAccountProfile(f.db, scope, { onboardingAction: "knowledge_skipped" });
  for (const value of [undefined, 0, -1, .6, Infinity, "0.012"]) assert.throws(() => updateAccountProfile(f.db, scope, { onboardingAction: "complete", handbookChoice: "create", handbookBudgetPower: value }), /上限/);
  assert.equal(accountProfile(f.db, scope).onboarding.completedAt, undefined);
});

test("concurrent completion processing, refresh and a restarted helper enqueue exactly one fixed-priced image", async () => {
  const f = fixture(); f.welcome(); let calls = 0, release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const enqueueImage = async (_s: typeof scope, input: OnboardingImageInput) => { calls++; assert.equal(input.budget, .012); assert.equal(input.imageVersion, 1); await wait; return f.accepted(input); };
  const running = startOnboardingHandbook(f.store, scope, { storageAvailable: true, verifyKey: key, enqueueImage });
  await new Promise(resolve => setTimeout(resolve, 0));
  const refresh = await startOnboardingHandbook(f.store, scope, { storageAvailable: true, verifyKey: key, enqueueImage });
  assert.equal(refresh.handbook?.status, "preparing"); assert.equal(calls, 1);
  release(); assert.equal((await running).handbook?.status, "queued");
  await startOnboardingHandbook(f.store, scope, { storageAvailable: true, verifyKey: key, enqueueImage });
  assert.equal(calls, 1); assert.equal(f.db.chatOperations!.length, 1);
  assert.equal(accountProfile(f.db, { userId: "b", workspaceId: "wb" }).onboarding.handbook, undefined);
});

test("the image receives only nickname and exact permitted platform labels, not KB or provider credential fields", () => {
  const f = fixture(); f.welcome();
  f.db.knowledgeConnections.push({ id: "n", workspaceId: "wa", provider: "notion", status: "connected", providerSpaceName: "PRIVATE_PAGE_NAME", encryptedAccessToken: "SECRET_TOKEN" } as never, { id: "g", workspaceId: "wa", provider: "getnote", status: "connected" } as never, { id: "foreign", workspaceId: "wb", provider: "flowus", status: "connected" } as never, { id: "revoked", workspaceId: "wa", provider: "flomo", status: "revoked" } as never);
  const instruction = handbookInstruction(f.db, scope);
  assert.match(instruction, /小马/); assert.match(instruction, /Notion/); assert.match(instruction, /得到大脑/);
  assert.doesNotMatch(instruction, /PRIVATE_|SECRET_|private-endpoint|FlowUs|flomo/);
  f.db.workspaces[0].kind = "company"; f.db.workspaceMembers[0].role = "member"; f.db.workspaceMembers[0].permissions = { knowledgeConnectionIds: ["g"], featureIds: [] };
  assert.doesNotMatch(handbookInstruction(f.db, scope), /Notion/);
  assert.match(handbookInstruction(f.db, scope), /得到大脑/);
  const offer = onboardingHandbookOffer(f.db, true);
  assert.deepEqual(offer, { available: true, pricePower: .012 });
  assert.doesNotMatch(JSON.stringify(offer), /SECRET|model|prompt|https/);
});

test("foreign scope, disabled account and another workspace's profile cannot claim a welcome image", async () => {
  const f = fixture(); f.welcome(); let calls = 0;
  const deps = { storageAvailable: true, verifyKey: key, enqueueImage: async () => { calls++; return "bad"; } };
  await assert.rejects(() => startOnboardingHandbook(f.store, { userId: "a", workspaceId: "wb" }, deps), /无权/);
  assert.equal((await startOnboardingHandbook(f.store, { userId: "b", workspaceId: "wb" }, deps)).handbook, undefined);
  f.db.users[0].enabled = false;
  await assert.rejects(() => startOnboardingHandbook(f.store, scope, deps), /无权/);
  assert.equal(calls, 0);
});

test("missing image configuration, budget or allowance do not block onboarding or auto-retry", async () => {
  for (const scenario of ["not_configured", "insufficient_power", "budget_required"] as const) {
    const f = fixture(); f.welcome(); let calls = 0;
    if (scenario === "not_configured") f.db.settings.aiTasks!.image_generation!.published!.enabled = false;
    if (scenario === "insufficient_power") f.db.powerAccounts[0].balanceMicros = 11_999;
    if (scenario === "budget_required") f.db.settings.aiTasks!.image_generation!.published!.imagePowerPerCall = .6;
    const deps = { storageAvailable: true, verifyKey: key, enqueueImage: async () => { calls++; return "bad"; } };
    const result = await startOnboardingHandbook(f.store, scope, deps);
    assert.equal(result.handbook?.status, "skipped"); assert.equal(result.handbook?.reason, scenario); assert.ok(result.notice);
    assert.ok(accountProfile(f.db, scope).onboarding.completedAt);
    f.db.powerAccounts[0].balanceMicros = 1_000_000;
    await startOnboardingHandbook(f.store, scope, deps); assert.equal(calls, 0);
  }
});

test('an unrelated billing review keeps its hold without blocking a separately affordable welcome image',async()=>{
  const f=fixture();f.welcome();
  f.db.modelUsageRecords.push({...scope,id:'older-review',status:'needs_review',reservedMicros:500_000} as never);
  f.db.powerAccounts[0].reservedMicros=500_000;
  const before=structuredClone(f.db.modelUsageRecords[0]);
  const result=await startOnboardingHandbook(f.store,scope,{storageAvailable:true,verifyKey:key,enqueueImage:async(_scope,input)=>f.accepted(input)});
  assert.equal(result.handbook?.status,'queued');
  assert.deepEqual(f.db.modelUsageRecords[0],before);
  assert.equal(f.db.powerAccounts[0].reservedMicros,500_000);
});

test('welcome status survives read-only refresh, follows actual task results, and never leaks across owners',async()=>{
  const f=fixture();f.welcome();f.db.users[0].profile!.onboarding.journey={id:'journey_123456789012',launchId:'launch_123456789012',version:2,stage:'complete',startedAt:'now',featureIds:[],events:[]};
  const h=f.db.users[0].profile!.onboarding.handbook!;h.status='skipped';h.reason='billing_review';
  const before=JSON.stringify(f.db);assert.equal(welcomeDelivery(f.db,scope)?.canRetry,true);assert.equal(JSON.stringify(f.db),before);
  assert.equal(welcomeDelivery(f.db,{workspaceId:'wb',userId:'b'}),undefined);
  h.status='pending';
  const result=await startOnboardingHandbook(f.store,scope,{storageAvailable:true,verifyKey:key,enqueueImage:async(_s,input)=>f.accepted(input)});
  assert.equal(welcomeDelivery(f.db,scope)?.state,'queued');assert.equal(welcomeDelivery(f.db,scope)?.canRetry,false);
  const job=f.db.chatOperations!.find(o=>o.conversationId===result.handbook?.taskId)!;job.workRun!.state='running';
  assert.equal(welcomeDelivery(f.db,scope)?.state,'running');job.workRun!.state='completed';
  assert.equal(welcomeDelivery(f.db,scope)?.state,'completed');assert.doesNotMatch(JSON.stringify(welcomeDelivery(f.db,scope)),/SECRET|instruction|prompt/);
});

test("uncertain enqueue fails once without leaking errors; an already durable image receipt is preserved", async () => {
  for (const durable of [false, true]) {
    const f = fixture(); f.welcome(); let calls = 0;
    const deps = { storageAvailable: true, verifyKey: key, enqueueImage: async (_s: typeof scope, input: OnboardingImageInput) => { calls++; if (durable) f.accepted(input); throw new Error("SECRET provider detail"); } };
    const result = await startOnboardingHandbook(f.store, scope, deps);
    assert.equal(result.handbook?.status, durable ? "queued" : "failed");
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    await startOnboardingHandbook(f.store, scope, deps); assert.equal(calls, 1);
  }
});

test("a fake task id, foreign receipt, or an owned receipt pointing at a foreign task cannot be accepted", async () => {
  for (const foreignReceipt of [true, false]) {
    const f = fixture(); f.welcome();
    const result = await startOnboardingHandbook(f.store, scope, { storageAvailable: true, verifyKey: key, enqueueImage: async (_s, input) => { f.db.conversations.push({ ...scope, userId: "b", id: "foreign" } as never); f.db.chatOperations!.push({ ...scope, userId: foreignReceipt ? "b" : "a", operationId: `${input.operationId}_image`, conversationId: "foreign", workRun: { kind: "image" } } as never); return "foreign"; } });
    assert.equal(result.handbook?.status, "failed"); assert.equal(result.handbook?.taskId, undefined);
  }
});

test("a stale pre-queue claim reads as uncertain without mutation or automatic execution", () => {
  const f = fixture(); f.welcome();
  const original = f.db.users[0].profile!.onboarding.handbook!;
  original.status = "preparing"; original.updatedAt = "2026-10-14T01:00:00Z";
  const before = JSON.stringify(f.db);
  const early = resolvedOnboardingHandbookProfile(f.db, scope, Date.parse("2026-10-14T01:01:59Z"));
  assert.equal(early.profile.onboarding.handbook!.status, "preparing");
  const late = resolvedOnboardingHandbookProfile(f.db, scope, Date.parse("2026-10-14T01:02:00Z"));
  assert.equal(late.profile.onboarding.handbook!.status, "failed"); assert.match(late.notice!, /还没确认/);
  assert.equal(JSON.stringify(f.db), before);
});

test("read-only welcome projection restores only an exact owned durable image receipt", () => {
  const f = fixture(); f.welcome();
  const original = f.db.users[0].profile!.onboarding.handbook!; original.status = "preparing";
  const input = { operationId: original.operationId } as OnboardingImageInput;
  f.accepted(input);
  const before = JSON.stringify(f.db);
  assert.equal(resolvedOnboardingHandbookProfile(f.db, scope).profile.onboarding.handbook!.status, "queued");
  assert.equal(JSON.stringify(f.db), before);
  f.db.conversations[0].userId = "b";
  assert.equal(resolvedOnboardingHandbookProfile(f.db, scope).profile.onboarding.handbook!.status, "preparing");
  f.db.conversations[0].userId = "a"; f.db.chatOperations![0].workspaceId = "wb";
  assert.equal(resolvedOnboardingHandbookProfile(f.db, scope).profile.onboarding.handbook!.status, "preparing");
});

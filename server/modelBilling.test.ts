import assert from "node:assert/strict";
import test from "node:test";
import type { Database, ModelConfig } from "./types.js";
import type { Store } from "./db.js";
import { affordableDocumentOutput, modelReservationMicros, reconcileInterruptedBilling, resolveBillingReview, runBilledModel, settleBillingRecord } from "./modelBilling.js";
import { publicUsageRecord } from "./serializers.js";

test('document allowance fits existing budget headroom instead of reserving an unaffordable maximum',()=>{
 const f=fixture(),input={messages:[{role:'user',content:'合成长文'}]};
 const available=modelReservationMicros(f.model,input,6000);
 assert.equal(affordableDocumentOutput(f.model,input,available),6000);
 assert.equal(affordableDocumentOutput(f.model,input,modelReservationMicros(f.model,input,12000)+1),12000);
 assert.equal(affordableDocumentOutput(f.model,input,modelReservationMicros(f.model,input,3000)-1),undefined);
 for(const invalid of [-1,NaN,Infinity])assert.equal(affordableDocumentOutput(f.model,input,invalid),undefined);
 assert.equal(f.db().modelUsageRecords.length,0);assert.equal(f.db().powerLedger.length,0);
});
test('feature rates replace base rate once; independent 1 and 1.2 calls add, costs and history stay frozen',async()=>{
  const f=fixture();f.model.pricing={version:1,label:'base',publishedAt:'2026-01-01',multiplier:.6,referenceInput:2,referenceOutput:4};
  const price=(multiplier:number)=>({id:`feature-${multiplier}`,name:'测试功能',releaseId:'r1',version:1,multiplier});
  for(const multiplier of [.6,1,1.2])await runBilledModel(f.store,{...f.params,featurePrice:price(multiplier)},async model=>{assert.equal(model.inputPowerPerMillion,2*multiplier);return {usage};});
  assert.deepEqual(f.db().modelUsageRecords.map(r=>r.chargedMicros),[24,40,48]);
  assert.deepEqual(f.db().modelUsageRecords.map(r=>r.costMicros),[20,20,20]);
  assert.equal(f.db().powerAccounts[0].balanceMicros,1000000-112);
  const row=f.db().modelUsageRecords[1];f.model.pricing!.multiplier=9;
  settleBillingRecord(f.db(),scope(row.id),usage,0);
  assert.equal(row.chargedMicros,40);assert.equal(f.db().powerLedger.length,3);
  assert.equal(f.db().powerAccounts[1].balanceMicros,1000000);
  assert.equal(publicUsageRecord(row).featurePriceSnapshot?.multiplier,1);
});

test('feature long-context and cached prices use absolute rate; fixed images keep procurement unchanged',async()=>{
  const f=fixture();f.db().powerAccounts[0].balanceMicros=100e6;
  f.model.pricing={version:1,label:'base',publishedAt:'2026-01-01',multiplier:.6,referenceInput:2,referenceOutput:4,referenceCache:{read:.1,write:2.5,write1h:3},longContext:{thresholdInputTokens:272000,referenceInput:4,referenceOutput:8,referenceCache:{read:.2,write:5,write1h:6}}};
  f.model.cacheCostPrices={read:.01,write:.25,write1h:.3};f.model.longContextCostPrices={input:.4,output:.8,cache:{read:.02,write:.5,write1h:.6}};
  const featurePrice={id:'f',name:'f',releaseId:'r',version:1,multiplier:1.2};
  await runBilledModel(f.store,{...f.params,input:'x'.repeat(300000),featurePrice},async()=>({usage:{inputTokens:1,outputTokens:10,totalTokens:272011,source:'provider',cacheUsage:{read:272000,write:0,write5m:0,write1h:0}}}));
  const row=f.db().modelUsageRecords[0];assert.equal(row.chargedMicros,65381);assert.equal(row.costMicros,5449);assert.equal(row.contextPriceTier,'long');
  await runBilledModel(f.store,{...f.params,model:{...f.model,kind:'image',imagePowerPerCall:.01,costImagePowerPerCall:.002},featurePrice:{...featurePrice,multiplier:.6}},async()=>({}));
  assert.equal(f.db().modelUsageRecords[1].chargedMicros,6000);assert.equal(f.db().modelUsageRecords[1].costMicros,2000);
});

function fixture() {
  const model = { id: "model", kind: "chat", name: "Test", enabled: true, systemPrompt: "rule", inputPowerPerMillion: 2, outputPowerPerMillion: 4, costInputPowerPerMillion: 1, costOutputPowerPerMillion: 2 } as ModelConfig;
  let db = { users: [{ id: "a", enabled: true }, { id: "b", enabled: true }], workspaces: [{ id: "wa", status: "active" }, { id: "wb", status: "active" }], workspaceMembers: [{ userId: "a", workspaceId: "wa" }, { userId: "b", workspaceId: "wb" }], models: [model], modelUsageRecords: [], powerLedger: [], powerAccounts: [{ id: "pa", userId: "a", workspaceId: "wa", balanceMicros: 1_000_000 }, { id: "pb", userId: "b", workspaceId: "wb", balanceMicros: 1_000_000 }] } as unknown as Database;
  let queue: Promise<unknown> = Promise.resolve();
  const store: Store = { read: async () => db, mutate: <T>(change: (data: Database) => T) => {
    const next = queue.then(() => { const before = structuredClone(db); try { return change(db); } catch (error) { db = before; throw error; } });
    queue = next.catch(() => undefined); return next;
  } };
  const params = { workspaceId: "wa", userId: "a", conversationId: "conversation", model, input: "hello", activity: "chat", requestId: "server-request" };
  return { store, params, model, db: () => db };
}
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: "provider" };
const scope = (id: string) => ({ usageId: id, workspaceId: "wa", userId: "a" });
test('trusted larger output limits reserve the same ceiling before calling and preserve tenant/budget isolation',async()=>{
 const f=fixture();
 const ordinary=modelReservationMicros(f.model,f.params.input);
 const large=modelReservationMicros(f.model,f.params.input,10000);
 assert.ok(large>ordinary);
 let calls=0;
 await runBilledModel(f.store,{...f.params,maxOutputTokens:10000},async()=>{calls++;assert.equal(f.db().modelUsageRecords[0].reservedMicros,large);return {usage};});
 assert.equal(f.db().modelUsageRecords[0].chargedMicros,40);
 for(const maxOutputTokens of [0,12001,1.5,NaN])await assert.rejects(()=>runBilledModel(f.store,{...f.params,maxOutputTokens},async()=>{calls++;return {usage};}),/输出上限/);
 await assert.rejects(()=>runBilledModel(f.store,{...f.params,maxOutputTokens:10000,beforeReserve:()=>{throw Error('budget');}},async()=>{calls++;return {usage};}),/budget/);
 await assert.rejects(()=>runBilledModel(f.store,{...f.params,userId:'b',maxOutputTokens:10000},async()=>{calls++;return {usage};}),/账号或个人空间/);
 assert.equal(calls,1);assert.equal(f.db().modelUsageRecords.length,1);assert.equal(f.db().powerAccounts[1].balanceMicros,1000000);
});
test('welcome sponsorship is scoped, once-only and keeps procurement cost without a user hold or debit',async()=>{
 const f=fixture(),gift='welcome_gift_0123456789';
 f.model.kind='image';f.model.imagePowerPerCall=.012;f.model.costImagePowerPerCall=.02;
 f.db().users[0].defaultWorkspaceId='wa';f.db().users[0].profile={workspaceId:'wa',displayName:'',onboarding:{knowledgeChoice:'skipped',welcomeGiftOperationId:gift},updatedAt:'now'};
 f.db().chatOperations=[{...f.params,id:'job',operationId:gift+'_image',workRun:{kind:'image',state:'running',welcomeSponsored:true,welcomeOperationId:gift}}] as never;
 f.db().powerAccounts[0].balanceMicros=0;
 const params={...f.params,sponsorship:{kind:'welcome_gift' as const,operationId:gift}};
 let calls=0;
 await assert.rejects(()=>runBilledModel(f.store,{...params,userId:'b',workspaceId:'wb'},async()=>{calls++;return {};}),/资格/);
 await assert.rejects(()=>runBilledModel(f.store,{...params,sponsorship:{kind:'welcome_gift',operationId:'foreign'}},async()=>{calls++;return {};}),/资格/);
 f.model.costImagePowerPerCall=.51;
 await assert.rejects(()=>runBilledModel(f.store,params,async()=>{calls++;return {};}),/资格/);
 f.model.costImagePowerPerCall=.02;
 await runBilledModel(f.store,params,async()=>{calls++;assert.equal(f.db().modelUsageRecords[0].reservedMicros,0);return {};});
 assert.equal(calls,1);const row=f.db().modelUsageRecords[0];assert.equal(row.chargedMicros,0);assert.equal(row.costMicros,20000);assert.equal(row.status,'success');assert.equal(row.billingCapped,false);
 assert.equal(f.db().powerAccounts[0].balanceMicros,0);assert.equal(f.db().powerLedger.length,0);
 const restored=JSON.parse(JSON.stringify(f.db()));restored.modelUsageRecords[0].status='pending';
 reconcileInterruptedBilling(restored);assert.equal(restored.modelUsageRecords[0].status,'needs_review');assert.equal(restored.powerAccounts[0].reservedMicros,0);
 resolveBillingReview(restored,{...scope(row.id),action:'waive'});assert.equal(restored.powerLedger.length,0);
 await assert.rejects(()=>runBilledModel(f.store,params,async()=>{calls++;return {};}),/资格/);assert.equal(calls,1);
 f.db().powerAccounts[0].balanceMicros=1000000;
 await runBilledModel(f.store,f.params,async()=>({}));
 assert.equal(f.db().modelUsageRecords[1].chargedMicros,12000);assert.equal(f.db().powerAccounts[0].balanceMicros,988000);
});
test("tier snapshot survives price changes, manual review, owner isolation and duplicate settlement", async () => {
  const f = fixture();
  f.model.pricing = { version: 2, label: "test", publishedAt: new Date().toISOString(), multiplier: 1, referenceInput: 2, referenceOutput: 10, referenceCache: { read: .1, write: 2.5, write1h: 2.5 }, longContext: { thresholdInputTokens: 272000, referenceInput: 4, referenceOutput: 15, referenceCache: { read: .2, write: 5, write1h: 5 } } };
  f.model.cacheCostPrices = { read: .01, write: .25, write1h: .25 };
  f.model.longContextCostPrices = { input: .4, output: 1.5, cache: { read: .02, write: .5, write1h: .5 } };
  f.db().powerAccounts[0].balanceMicros = 10000000;
  f.params.input = "x".repeat(300000);
  await runBilledModel(f.store, f.params, async () => { f.model.pricing!.longContext!.referenceInput = 99; f.model.longContextCostPrices!.input = 99; return { usage: undefined }; });
  const row = f.db().modelUsageRecords[0];
  const cacheUsage = { read: 272000, write: 0, write5m: 0, write1h: 0 };
  assert.throws(() => resolveBillingReview(f.db(), { ...scope(row.id), userId: "b", workspaceId: "wb", action: "provider_usage", inputTokens: 1, outputTokens: 100, cacheUsage }), /不属于/);
  resolveBillingReview(f.db(), { ...scope(row.id), action: "provider_usage", inputTokens: 1, outputTokens: 100, cacheUsage });
  assert.equal(row.promptTokens, 272001); assert.equal(row.contextPriceTier, "long");
  assert.equal(row.chargedMicros, 55904); assert.equal(row.costMicros, 5591);
  assert.equal(row.pricingSnapshot?.version, 2);
  assert.ok(!JSON.stringify(publicUsageRecord(row)).includes("longContextCostPrices"));
  resolveBillingReview(f.db(), { ...scope(row.id), action: "provider_usage", inputTokens: 0, outputTokens: 0 });
  assert.equal(f.db().powerLedger.length, 1);
  assert.equal(f.db().powerAccounts[1].balanceMicros, 1000000);
});

test("cache buckets bill separately, freeze costs, isolate owners and survive replay", async () => {
  const f = fixture();
  Object.assign(f.model, { inputPowerPerMillion: 5, outputPowerPerMillion: 25, costInputPowerPerMillion: 1, costOutputPowerPerMillion: 5, cachePrices: { read: 0.5, write: 6.25, write1h: 10 }, cacheCostPrices: { read: 0.1, write: 1.25, write1h: 2 } });
  const cached = { inputTokens: 100, outputTokens: 20, totalTokens: 420, cacheUsage: { read: 200, write: 100, write5m: 80, write1h: 20 }, source: "provider" };
  await runBilledModel(f.store, f.params, async () => { f.model.cachePrices!.read = 99; return { usage: cached }; });
  const row = f.db().modelUsageRecords[0];
  assert.equal(row.chargedMicros, 1800); assert.equal(row.costMicros, 360);
  assert.equal(row.cachePricesSnapshot?.read, .5);
  const visible = publicUsageRecord(row);
  assert.deepEqual(visible.cacheUsage, cached.cacheUsage);
  assert.ok(!("cacheCostPricesSnapshot" in visible));
  assert.equal(f.db().powerAccounts[1].balanceMicros, 1000000);
  assert.throws(() => settleBillingRecord(f.db(), { ...scope(row.id), userId: "b", workspaceId: "wb" }, cached, 1), /不属于/);
  const restored = JSON.parse(JSON.stringify(f.db()));
  settleBillingRecord(restored, scope(row.id), cached, 1);
  assert.equal(restored.powerLedger.length, 1);
});
test("missing cache prices retain usage and a review hold, never charge standard input", async () => {
  const f = fixture();
  await runBilledModel(f.store, f.params, async () => ({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 115, source: "provider", cacheUsage: { read: 100, write: 0, write5m: 0, write1h: 0 } } }));
  const row = f.db().modelUsageRecords[0];
  assert.equal(row.status, "needs_review"); assert.equal(row.reviewReason, "cache_pricing_missing");
  assert.equal(row.cacheUsage?.read, 100); assert.equal(row.chargedMicros, 0);
  assert.throws(() => resolveBillingReview(f.db(), { ...scope(row.id), action: "provider_usage", inputTokens: 10, outputTokens: 5 }), /快照/);
  resolveBillingReview(f.db(), { ...scope(row.id), action: "waive" });
  assert.equal(f.db().powerAccounts[0].reservedMicros, 0);
});

test("durable billing charges once and freezes prices while the model runs", async () => {
  const f = fixture();
  await runBilledModel(f.store, f.params, async (model) => {
    assert.equal(model.inputPowerPerMillion, 2);
    f.model.inputPowerPerMillion = 100;
    return { usage, content: "done" };
  });
  const row = f.db().modelUsageRecords[0];
  assert.equal(row.chargedMicros, 40);
  assert.equal(row.costMicros, 20);
  assert.equal(row.inputPowerPerMillionSnapshot, 2);
  assert.equal(f.db().powerAccounts[0].reservedMicros, 0);
  settleBillingRecord(f.db(), scope(row.id), usage, 1);
  assert.equal(f.db().powerLedger.length, 1);
  assert.equal(f.db().powerAccounts[0].balanceMicros, 999_960);
});

test("simultaneous calls cannot both reserve the last available balance", async () => {
  const f = fixture(); const hold = modelReservationMicros(f.model, f.params.input);
  f.db().powerAccounts[0].balanceMicros = hold;
  let resume!: () => void; let entered!: () => void;
  const began = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { resume = resolve; });
  const first = runBilledModel(f.store, f.params, async () => { entered(); await wait; return { usage }; });
  await began;
  let secondCalled = false;
  await assert.rejects(runBilledModel(f.store, f.params, async () => { secondCalled = true; return { usage }; }), /电力不足/);
  assert.equal(secondCalled, false);
  resume(); await first;
  assert.equal(f.db().powerLedger.length, 1);
});

test("unknown usage retains a review hold; another tenant and duplicate resolution cannot spend it", async () => {
  const f = fixture();
  const result = await runBilledModel(f.store, f.params, async () => ({ content: "answer", usage: undefined }));
  assert.equal(result.content, "answer");
  const row = f.db().modelUsageRecords[0]; const held = row.reservedMicros!;
  assert.equal(row.status, "needs_review"); assert.ok(held > 0);
  assert.equal(f.db().powerLedger.length, 0);
  await runBilledModel(f.store, {...f.params,requestId:'next-step'}, async () => ({ usage }));
  assert.equal(row.status,'needs_review');assert.equal(row.reservedMicros,held);
  assert.equal(f.db().powerAccounts[0].reservedMicros,held);
  assert.throws(() => resolveBillingReview(f.db(), { ...scope(row.id), workspaceId: "wb", userId: "b", action: "waive" }), /不属于/);
  resolveBillingReview(f.db(), { ...scope(row.id), action: "provider_usage", inputTokens: 10, outputTokens: 5 });
  resolveBillingReview(f.db(), { ...scope(row.id), action: "provider_usage", inputTokens: 10, outputTokens: 5 });
  assert.equal(f.db().powerLedger.length, 2);
  assert.equal(f.db().powerAccounts[1].balanceMicros, 1_000_000);
});

test('an uncertain bill cannot spend reserved funds, but another workspace remains usable',async()=>{
  const f=fixture(),held=modelReservationMicros(f.model,f.params.input);f.db().powerAccounts[0].balanceMicros=held;
  await runBilledModel(f.store,f.params,async()=>({usage:undefined}));let called=false;
  await assert.rejects(runBilledModel(f.store,{...f.params,requestId:'next'},async()=>{called=true;return {usage};}),/电力不足/);assert.equal(called,false);
  await runBilledModel(f.store,{...f.params,workspaceId:'wb',userId:'b',requestId:'other'},async()=>({usage}));
  assert.equal(f.db().modelUsageRecords[0].reservedMicros,held);assert.equal(f.db().modelUsageRecords[0].chargedMicros,0);
});

test("provider failure records duration and releases its own reservation without charging", async () => {
  const f = fixture();
  await assert.rejects(runBilledModel(f.store, f.params, async () => { throw Error("upstream secret body"); }), /upstream/);
  assert.equal(f.db().modelUsageRecords[0].status, "failed");
  assert.equal(f.db().powerAccounts[0].reservedMicros, 0);
  assert.equal(f.db().powerLedger.length, 0);
  assert.ok(!JSON.stringify(f.db()).includes("secret body"));
});

test("a transient DB failure while releasing a failed call leaves a reviewable hold", async () => {
  const f = fixture();
  const mutate = f.store.mutate.bind(f.store);
  let writes = 0;
  f.store.mutate = async <T>(change: (db: Database) => T): Promise<T> => {
    if (++writes === 2) throw Error("transient storage failure");
    return mutate(change);
  };
  await assert.rejects(runBilledModel(f.store, f.params, async () => { throw Error("upstream failed"); }), /upstream failed/);
  const row = f.db().modelUsageRecords[0];
  assert.equal(row.status, "needs_review");
  assert.equal(row.reviewReason, "failure_release_storage_failed");
  assert.ok(f.db().powerAccounts[0].reservedMicros! > 0);
  resolveBillingReview(f.db(), { ...scope(row.id), action: "waive" });
  assert.equal(f.db().powerAccounts[0].reservedMicros, 0);
  assert.equal(f.db().powerAccounts[0].balanceMicros, 1_000_000);
});

test("a provider overrun returns the answer, caps retail and records full modeled cost", async () => {
  const f = fixture(); const hold = modelReservationMicros(f.model, f.params.input);
  const result = await runBilledModel(f.store, f.params, async () => ({ content: "done", usage: { inputTokens: 100_000, outputTokens: 100_000, totalTokens: 200_000, source: "provider" } }));
  const row = f.db().modelUsageRecords[0];
  assert.equal(result.content, "done"); assert.equal(row.chargedMicros, hold); assert.equal(row.billingCapped, true);
  assert.equal(row.costMicros, 300_000); assert.equal(f.db().powerAccounts[0].reservedMicros, 0);
});

test("restart preserves uncertain holds and explicit waiver releases them idempotently", async () => {
  const f = fixture();
  await runBilledModel(f.store, f.params, async () => ({ usage: undefined }));
  const row = f.db().modelUsageRecords[0]; row.status = "pending";
  const hold = row.reservedMicros;
  reconcileInterruptedBilling(f.db()); reconcileInterruptedBilling(f.db());
  assert.equal(row.status, "needs_review"); assert.equal(f.db().powerAccounts[0].reservedMicros, hold);
  resolveBillingReview(f.db(), { ...scope(row.id), action: "waive" });
  resolveBillingReview(f.db(), { ...scope(row.id), action: "waive" });
  assert.equal(f.db().powerAccounts[0].reservedMicros, 0); assert.equal(f.db().powerAccounts[0].balanceMicros, 1_000_000);
});

test("image calls require explicit fixed prices and do not silently become free", async () => {
  const f = fixture(); f.model.kind = "image";
  let called = false;
  await assert.rejects(runBilledModel(f.store, f.params, async () => { called = true; return { usage }; }), /尚未配置/);
  assert.equal(called, false);
  f.model.imagePowerPerCall = 0.2; f.model.costImagePowerPerCall = 0.1;
  await runBilledModel(f.store, f.params, async () => ({ usage: undefined }));
  assert.equal(f.db().modelUsageRecords[0].source, "fixed");
  assert.equal(f.db().modelUsageRecords[0].chargedMicros, 200_000);
  assert.equal(f.db().modelUsageRecords[0].costMicros, 100_000);
});

test("disabled accounts and forged workspace bindings never call the upstream", async () => {
  const f = fixture(); let called = false;
  const call = async () => { called = true; return { usage }; };
  await assert.rejects(runBilledModel(f.store, { ...f.params, workspaceId: "wb" }, call), /不可用/);
  f.db().users[0].enabled = false;
  await assert.rejects(runBilledModel(f.store, f.params, call), /不可用/);
  assert.equal(called, false); assert.equal(f.db().modelUsageRecords.length, 0);
});

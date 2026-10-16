import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import type { Store } from "./db.js";
import type { Database, ModelConfig } from "./types.js";
import { updateAccountProfile } from "./betaProfile.js";
import { defaultTaskValues } from "./aiTaskConfig.js";
import { installOnboardingProfileRoutes, type OnboardingProfileDependencies } from "./onboardingRoutes.js";
import type { OnboardingImageInput } from "./onboardingHandbook.js";

const scope = { workspaceId: "wa", userId: "a" };
function fixture() {
  const model = { id: "image-key", name: "Image", kind: "chat", protocol: "openai", enabled: true, apiKey: "SECRET_KEY", model: "test-image", baseUrl: "https://private-gateway.example", systemPrompt: "PRIVATE_PROMPT" } as ModelConfig;
  const db = {
    users: [{ id: "a", username: "a", enabled: true, defaultWorkspaceId: "wa", role: "user", createdAt: "today" }, { id: "b", username: "b", enabled: true, defaultWorkspaceId: "wb", role: "user", createdAt: "today" }],
    workspaces: [{ id: "wa", status: "active" }, { id: "wb", status: "active" }], workspaceMembers: [{ workspaceId: "wa", userId: "a", role: "owner" }, { workspaceId: "wb", userId: "b", role: "owner" }],
    knowledgeConnections: [], conversations: [], messages: [], models: [model], chatOperations: [], modelUsageRecords: [], powerAccounts: [{ ...scope, id: "power", balanceMicros: 1_000_000 }],
    settings: { aiTasks: { image_generation: { published: { ...defaultTaskValues("image_generation"), modelId: model.id, imagePowerPerCall: .012, costImagePowerPerCall: .02, version: 1 } } } },
  } as unknown as Database;
  const store: Store = { read: async () => db, mutate: async fn => fn(db) };
  let queued = 0, resumed = 0, verified = 0, keyLost = false;
  const auth: RequestHandler = (req, res, next) => {
    if (req.headers["x-fixture-deny"] === "yes") { res.status(428).json({ error: "Key required" }); return; }
    // Only this trusted test middleware establishes the request scope.
    req.user = db.users[0]; req.workspaceId = scope.workspaceId; next();
  };
  const deps: OnboardingProfileDependencies = {
    storageAvailable: true,
    verifyKey: async () => { verified++; if (keyLost) throw new Error("PRIVATE_KEY_ERROR"); },
    enqueueImage: async (s, input: OnboardingImageInput, verifyKey) => {
      await verifyKey(); queued++;
      assert.deepEqual(s, scope); assert.equal(input.budget, .012); assert.equal(input.imageVersion, 1); assert.doesNotMatch(input.instruction, /SECRET|PRIVATE/);
      db.conversations.push({ ...scope, id: "guide-task" } as never);
      db.chatOperations!.push({ ...scope, id: "welcome-op", operationId: `${input.operationId}_image`, requestId: "image-request", payloadHash: "fixture", status: "pending", conversationId: "guide-task", createdAt: "now", updatedAt: "now", workRun: { kind: "image", state: "queued" } as never });
      return "guide-task";
    },
    resume: async () => { resumed++; },
  };
  const ready = () => { updateAccountProfile(db, scope, { displayName: "小马" }); updateAccountProfile(db, scope, { onboardingAction: "knowledge_skipped" }); };
  return { db, store, auth, deps, ready, stats: () => ({ queued, resumed, verified }), loseKey: () => { keyLost = true; } };
}
async function server(t: TestContext, f: ReturnType<typeof fixture>) {
  const app = express(); app.use(express.json());
  installOnboardingProfileRoutes(app, [f.auth], f.store, f.deps);
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 400).json({ error: error.message }); });
  const listener = app.listen(0, "127.0.0.1"); await once(listener, "listening");
  t.after(() => { listener.closeAllConnections(); listener.close(); });
  const address = listener.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/me/profile`;
  const patch = (body: object, headers: Record<string, string> = {}) => fetch(url, { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { url, patch };
}
const completion = { onboardingAction: "complete", handbookChoice: "create", handbookBudgetPower: .012 };
test('four-step purpose setup finishes and queues once without a reveal page; repeat generation requires a paid choice',async t=>{
 const f=fixture(),http=await server(t,f),post=(body:object)=>fetch(http.url+'/onboarding',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const begin=await(await post({action:'begin',launchId:'purpose_0123456789abcdef',experience:3})).json(),id=begin.profile.onboarding.journey.id;
 for(const step of ['name','knowledge','device'])await post({action:'step',journeyId:id,step,choice:'skipped'});
 const input={action:'step',journeyId:id,step:'features',choice:'purposes',purposeIds:['work','writing'],createGuide:true};
 const result=await(await post(input)).json();assert.equal(result.profile.onboarding.journey.stage,'complete');assert.equal(result.welcomeDelivery.taskId,'guide-task');assert.equal(f.stats().queued,1);
 assert.deepEqual(result.profile.onboarding.journey.purposeIds,['work','writing']);assert.equal(result.profile.onboarding.handbook.funding,'one');
 assert.equal((await post(input)).status,200);assert.equal(f.stats().queued,1,'lost final response cannot duplicate a generation');
 const second=await(await post({action:'begin',launchId:'purpose_again_0123456789'})).json(),other=second.profile.onboarding.journey.id;
 for(const step of ['name','knowledge','device'])await post({action:'step',journeyId:other,step,choice:'skipped'});
 assert.equal((await post({...input,journeyId:other})).status,400);
 const decline=await(await post({...input,journeyId:other,createGuide:false})).json();assert.equal(decline.profile.onboarding.journey.stage,'complete');assert.equal(decline.welcomeDelivery,undefined);assert.equal(f.stats().queued,1);
});

test('welcome handoff retry accepts only a known unstarted attempt; refresh never queues it and cross-owner IDs cannot retry',async t=>{
 const f=fixture(),http=await server(t,f),url=http.url+'/onboarding';
 const post=(body:object)=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const b=await(await post({action:'begin',launchId:'launch_retry_0123456789'})).json(),id=b.profile.onboarding.journey.id;
 for(const step of ['name','knowledge','device','features'])await post({action:'step',journeyId:id,step,choice:'skipped'});
 f.db.powerAccounts[0].balanceMicros=0;f.deps.storageAvailable=false;
 const done=await(await post({action:'finish',journeyId:id,budgetPower:.012})).json();
 assert.equal(done.welcomeDelivery.state,'failed');assert.equal(done.welcomeDelivery.canRetry,true);assert.equal(f.stats().queued,0);
 assert.equal((await post({action:'retry_delivery',operationId:'foreign_welcome_0123456789'})).status,409);
 await fetch(http.url);assert.equal(f.stats().queued,0);
 f.deps.storageAvailable=true;
 await post({action:'begin',launchId:'reopen_retry_0123456789'});
 const reopened=await(await fetch(http.url)).json();assert.equal(reopened.welcomeDelivery.canRetry,true);
 const retry=await(await post({action:'retry_delivery',operationId:done.welcomeDelivery.operationId})).json();
 assert.equal(retry.welcomeDelivery.taskId,'guide-task');assert.equal(retry.welcomeDelivery.canRetry,false);assert.equal(f.stats().queued,1);
 assert.equal(retry.profile.onboarding.journey.stage,'name','retry preserves the separately reopened unfinished setup');
 assert.equal((await post({action:'retry_delivery',operationId:done.welcomeDelivery.operationId})).status,409);assert.equal(f.stats().queued,1);
});

test('unavailable image setup can complete without any undisclosed paid budget',async t=>{
 const f=fixture(),http=await server(t,f),url=http.url+'/onboarding';
 const post=(body:object)=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const b=await(await post({action:'begin',launchId:'launch_noimage_0123456789'})).json(),id=b.profile.onboarding.journey.id;
 for(const step of ['name','knowledge','device','features'])await post({action:'step',journeyId:id,step,choice:'skipped'});
 const done=await(await post({action:'finish',journeyId:id,choice:'without_image'})).json();
 assert.equal(done.profile.onboarding.journey.stage,'complete');assert.equal(done.profile.onboarding.handbook.maxPower,0);assert.equal(done.welcomeDelivery,undefined);assert.equal(done.handbookNotice,undefined);assert.equal(f.stats().queued,0);
});

test('comic journey HTTP accepts all skipped steps, queues once, ignores forged device capabilities and can explicitly reopen',async t=>{
 const f=fixture(),http=await server(t,f),url=http.url+'/onboarding';
 const post=(body:object)=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const b=await(await post({action:'begin',launchId:'launch_0123456789abcdef',workspaceId:'wb',userId:'b'})).json(),id=b.profile.onboarding.journey.id;
 for(const step of ['name','knowledge','device','features']) {
   const r=await post({action:'step',journeyId:id,step,choice:'skipped',local:{connected:true,folderSelected:true,executorReady:true},featureIds:['foreign']});assert.equal(r.status,200);
 }
 const finished=await Promise.all([post({action:'finish',journeyId:id,budgetPower:.012}),post({action:'finish',journeyId:id,budgetPower:.012})]);
 assert.deepEqual(finished.map(r=>r.status),[200,200]);assert.equal(f.stats().queued,1);
 const state=await(await fetch(http.url)).json();assert.equal(state.profile.displayName,'');assert.equal(state.profile.onboarding.handbook.taskId,'guide-task');assert.equal(state.profile.onboarding.journey.local,undefined);
 assert.equal(f.db.users[1].profile,undefined);
 const reopened=await(await post({action:'begin',launchId:'restart_0123456789abcdef'})).json();assert.notEqual(reopened.profile.onboarding.journey.id,id);
 assert.equal((await post({action:'finish',journeyId:id,budgetPower:.012})).status,409);assert.equal(f.stats().queued,1);
});

test('comic device step stores only server-inspected current-device state and degrades safely',async t=>{
 const f=fixture(),http=await server(t,f),url=http.url+'/onboarding';let scans=0;
 f.deps.inspectLocal=async()=>{scans++;return {connected:true,folderSelected:true,executorReady:true,checkedAt:'today'};};
 const post=(body:object)=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const b=await(await post({action:'begin',launchId:'launch_0123456789abcdef'})).json(),id=b.profile.onboarding.journey.id;
 for(const step of ['name','knowledge'])await post({action:'step',journeyId:id,step,choice:'skipped'});
 const checked=await(await post({action:'step',journeyId:id,step:'device',choice:'checked',local:{connected:false}})).json();assert.equal(checked.profile.onboarding.journey.local.executorReady,true);assert.equal(scans,1);
 await post({action:'step',journeyId:id,step:'features',choice:'skipped'});
 f.deps.inspectLocal=async()=>{throw new Error('PRIVATE_LOCAL_ERROR');};
 const finished=await(await post({action:'finish',journeyId:id,budgetPower:.012})).json();assert.equal(finished.profile.onboarding.journey.local.connected,false);assert.doesNotMatch(JSON.stringify(finished),/PRIVATE_LOCAL_ERROR/);
 assert.equal(f.stats().queued,1);
});

test("HTTP profile uses middleware scope, ignores foreign body IDs, and returns only public guide metadata", async t => {
  const f = fixture(), http = await server(t, f);
  const changed = await http.patch({ displayName: "小马", userId: "b", workspaceId: "wb", instruction: "steal another account" });
  assert.equal(changed.status, 200); assert.equal(changed.headers.get("cache-control"), "no-store");
  const result = await changed.json(); assert.equal(result.profile.workspaceId, "wa"); assert.equal(f.db.users[1].profile, undefined);
  const read = await fetch(http.url), body = await read.json();
  assert.equal(read.status, 200); assert.equal(read.headers.get("cache-control"), "no-store");
  assert.deepEqual(body.handbookOffer, { available: true, pricePower: .012, firstGift:true });
  assert.doesNotMatch(JSON.stringify(body), /SECRET|PRIVATE|private-gateway|apiKey|systemPrompt/);
  assert.equal(f.stats().queued, 0);
});

test("HTTP concurrent explicit completion plus refresh accepts only one image task", async t => {
  const f = fixture(); f.ready(); const http = await server(t, f);
  const responses = await Promise.all([http.patch(completion), http.patch({ ...completion, workspaceId: "wb" })]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  const bodies = await Promise.all(responses.map(r => r.json()));
  assert.ok(bodies.every(body => body.profile.onboarding.completedAt));
  assert.equal(f.stats().queued, 1); assert.equal(f.db.chatOperations!.length, 1);
  assert.equal((await (await fetch(http.url)).json()).profile.onboarding.handbook.taskId, "guide-task");
  await http.patch(completion); assert.equal(f.stats().queued, 1);
  assert.equal(f.db.users[1].profile, undefined);
});

test("HTTP guide key loss after saving does not block onboarding; GET never retries", async t => {
  const f = fixture(); f.ready(); f.loseKey(); const http = await server(t, f);
  const response = await http.patch(completion), body = await response.json();
  assert.equal(response.status, 200); assert.ok(body.profile.onboarding.completedAt); assert.match(body.handbookNotice, /先开始聊天/);
  assert.equal(body.profile.onboarding.handbook.status, "failed");
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_KEY_ERROR/);
  assert.equal(f.stats().queued, 0);
  const reread = await (await fetch(http.url)).json(); assert.equal(reread.profile.onboarding.handbook.status, "failed"); assert.match(reread.handbookNotice, /先开始聊天/);
  await fetch(http.url); assert.equal(f.stats().queued, 0); assert.equal(f.stats().verified, 1);
});

test("HTTP a failing sibling request cannot terminate another request's preparing welcome claim", async t => {
  const f = fixture(); f.ready(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const enqueue = f.deps.enqueueImage;
  f.deps.enqueueImage = async (...args) => { await gate; return enqueue(...args); };
  const http = await server(t, f), running = http.patch(completion);
  for (let attempt = 0; attempt < 100 && f.db.users[0].profile?.onboarding.handbook?.status !== "preparing"; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(f.db.users[0].profile?.onboarding.handbook?.status, "preparing");
  f.loseKey(); const sibling = await http.patch(completion), siblingBody = await sibling.json();
  assert.equal(sibling.status, 200); assert.equal(siblingBody.profile.onboarding.handbook.status, "preparing");
  // Finish with a controlled durable receipt; the sibling's catch must not
  // override it, independently of the Key state which is tested above.
  f.deps.verifyKey = async () => {};
  release(); const completed = await running, body = await completed.json();
  assert.equal(completed.status, 200); assert.equal(body.profile.onboarding.handbook.status, "queued");
  assert.equal(f.stats().queued, 1);
});

test("HTTP initial Key denial stays unauthorized and cannot save or generate anything", async t => {
  const f = fixture(); f.ready(); const http = await server(t, f);
  const response = await http.patch(completion, { "x-fixture-deny": "yes" });
  assert.equal(response.status, 428); assert.equal(f.db.users[0].profile!.onboarding.completedAt, undefined);
  assert.equal(f.stats().queued, 0); assert.equal(f.stats().verified, 0);
});

test("HTTP a changed price or absent storage skips the guide while the user can start", async t => {
  for (const reason of ["price", "storage"]) {
    const f = fixture(); f.ready();
    if (reason === "price") f.db.settings.aiTasks!.image_generation!.published!.imagePowerPerCall = .4;
    else f.deps.storageAvailable = false;
    const http = await server(t, f), response = await http.patch(completion), body = await response.json();
    assert.equal(response.status, 200); assert.ok(body.profile.onboarding.completedAt);
    assert.equal(body.profile.onboarding.handbook.status, "skipped"); assert.equal(f.stats().queued, 0); assert.ok(body.handbookNotice);
  }
});

test("HTTP old users, no guide choice and skip cannot trigger a welcome image", async t => {
  for (const kind of ["old", "implicit", "skip"]) {
    const f = fixture(); f.ready();
    if (kind === "old") updateAccountProfile(f.db, scope, { onboardingAction: "complete" });
    const http = await server(t, f), response = await http.patch(kind === "implicit" ? { onboardingAction: "complete" } : kind === "skip" ? { onboardingAction: "complete", handbookChoice: "skip" } : completion);
    assert.equal(response.status, 200); assert.equal(f.stats().queued, 0); assert.equal(f.db.users[0].profile!.onboarding.handbook, undefined);
  }
});

test("HTTP runner interruption keeps the accepted task and cannot create another one", async t => {
  const f = fixture(); f.ready(); f.deps.resume = async () => { throw new Error("PRIVATE_RUNNER_INTERRUPTION"); };
  const http = await server(t, f), response = await http.patch(completion), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.profile.onboarding.handbook.status, "queued"); assert.equal(body.profile.onboarding.handbook.taskId, "guide-task");
  await http.patch(completion); assert.equal(f.stats().queued, 1);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_RUNNER_INTERRUPTION/);
});

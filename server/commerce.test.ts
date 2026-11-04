import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMERCE_EDIT_AGENT_ID, COMMERCE_MAIN_AGENT_ID, CommerceService, commerceAttachments, commerceJobAccess, commerceJobUsesAttachment, normalizeCommerceBrief, publicCommerceJob } from './commerce.js';
import { commerceFixture, commerceOwner as owner, commerceOther as other, commercePeer as peer } from './commerce.fixture.js';
import { createIndustryUsageSession, IndustryStore } from './industryState.js';
import type { IndustryModelRunner } from './industryModel.js';
import { commercePlanningBrief, defaultComposition, mergeReferenceModules, parseCommerceReference, commerceVariantBrief } from './commerceComposition.js';
import { commerceTitleUnits, normalizeCommerceTitle } from './commercePrompts.js';

test('owned ready commerce attachments are isolated from other members, workspaces and teaching/chat uploads', async()=>{
  const f=commerceFixture(),db=await f.store.read();
  assert.equal(commerceAttachments(db,owner,['product'])[0].id,'product');
  for(const id of ['peer-image','other-workspace-image'])assert.throws(()=>commerceAttachments(db,owner,[id]));
  for(const state of ['uploading','parsing','failed'] as const){db.attachments[0].status=state;assert.throws(()=>commerceAttachments(db,owner,['product']));}
  db.attachments[0].status='ready';db.attachments[0].conversationId='teaching:private';assert.throws(()=>commerceAttachments(db,owner,['product']));
  db.attachments[0].conversationId='chat-conversation';assert.throws(()=>commerceAttachments(db,owner,['product']));
  db.attachments[0].conversationId='industry:commerce';f.db.workspaceMembers.find(m=>m.userId===owner.id&&m.workspaceId===owner.workspaceId)!.status='disabled';
  assert.throws(()=>commerceAttachments(db,owner,['product']));assert.equal(f.calls.length,0);
});

test('main planning is idempotent, validates budget tool, rejects payload changes, and emits a private DTO',async()=>{
  const f=commerceFixture(),key='main-request-idempotent';
  await assert.rejects(f.service.create(owner,COMMERCE_MAIN_AGENT_ID,f.brief,key,f.editSession.id),/不属于/);
  const first=await f.service.create(owner,COMMERCE_MAIN_AGENT_ID,f.brief,key,f.mainSession.id);await f.idle(first.id);
  assert.equal((await f.service.create(owner,COMMERCE_MAIN_AGENT_ID,f.brief,key,f.mainSession.id)).id,first.id);
  assert.equal(f.calls.length,2);assert.equal((await f.store.read()).commerceJobs.length,1);
  await assert.rejects(f.service.create(owner,COMMERCE_MAIN_AGENT_ID,{...f.brief,notes:'changed'},key,f.mainSession.id),e=>(e as {status:number}).status===409);
  const db=await f.store.read();for(const actor of [peer,other])assert.throws(()=>commerceJobAccess(db,actor,first.id));
  const dto=JSON.stringify(publicCommerceJob(commerceJobAccess(db,owner,first.id)));
  for(const field of ['requestHash','requestKey','imagePrompt','chatModelId','imageModelId','usageSessionId','workspaceId','userId','apiKey'])assert.ok(!dto.includes(`"${field}"`),field);
  assert.ok(f.calls.every(c=>c.usageSessionId===f.mainSession.id));assert.deepEqual(f.calls.map(c=>c.stepId),['analysis-0','plan-0']);
  assert.equal(f.db.modelUsageRecords.length,0,'domain does not append unbilled or double-counted usage rows');
});

test('selective generation uses only the chosen reference and immutable action receipts bind budget sessions',async()=>{
  const f=commerceFixture();const job=await f.service.create(owner,COMMERCE_MAIN_AGENT_ID,f.brief,'selective-main-request',f.mainSession.id);await f.idle(job.id);
  const variant=(await f.current(job.id)).variants[0];
  await f.service.generate(owner,job.id,variant.id,'ref-b','generate-request-0001',f.mainSession.id);await f.idle(job.id);
  const imageCalls=f.calls.filter(c=>c.kind==='image');assert.equal(imageCalls.length,1);assert.deepEqual(imageCalls[0].messages[0].inputImageDataUrls,['product','ref-b']);assert.equal(imageCalls[0].imageSize,'auto');
  assert.equal((await f.current(job.id)).variants.filter(v=>v.status==='pending').length,3);
  await f.service.generate(owner,job.id,variant.id,'ref-b','generate-request-0001',f.mainSession.id);assert.equal(f.calls.filter(c=>c.kind==='image').length,1);
  const nextSession=createIndustryUsageSession(f.db,owner,{confirmed:true,requestKey:'next-main-session-0001',tool:'product_creative',budgetMicros:1_000_000});
  await assert.rejects(f.service.generate(owner,job.id,variant.id,'ref-b','generate-request-0001',nextSession.id),e=>(e as {status:number}).status===409);
  await f.service.retry(owner,job.id,variant.id,'ref-b','retry-request-0000001',nextSession.id);await f.idle(job.id);
  const saved=await f.current(job.id);assert.equal(saved.usageSessionId,nextSession.id);assert.equal(saved.variants[0].previousImageIds?.length,1);
  assert.deepEqual(f.calls.filter(c=>c.kind==='image').map(c=>c.stepId),[`image-${variant.id}-1`,`image-${variant.id}-2`]);
});

test('portrait, revision and SKU preserve the selected source, separate SKU assets, and do not rerun planning',async()=>{
  const f=commerceFixture(),parent=await f.service.create(owner,COMMERCE_MAIN_AGENT_ID,f.brief,'derive-main-request',f.mainSession.id);await f.idle(parent.id);
  const variant=(await f.current(parent.id)).variants[0];await f.service.generate(owner,parent.id,variant.id,'ref-a','derive-generate-request',f.mainSession.id);await f.idle(parent.id);
  const source=(await f.current(parent.id)).variants[0].imageAttachmentId!;
  for(const kind of ['portrait','revision','sku'] as const){
    const input={kind,variantId:variant.id,requestKey:`derive-${kind}-request`,usageSessionId:f.mainSession.id,instruction:kind==='revision'?'删除左上角角标':undefined,items:kind==='sku'?[{name:'花香',specification:'250g',imageIds:['sku-a']},{name:'组合装',specification:'两件',imageIds:['sku-a','sku-b']}]:undefined};
    const job=await f.service.derive(owner,parent.id,input);await f.idle(job.id);assert.equal((await f.service.derive(owner,parent.id,input)).id,job.id);
    const saved=await f.current(job.id);assert.equal(saved.status,'completed');assert.ok(commerceJobUsesAttachment(saved,source));
    const images=f.calls.filter(c=>c.operationId===job.id&&c.kind==='image');assert.ok(images.every(c=>c.messages[0].inputImageDataUrls?.[0]===source));
    if(kind==='portrait')assert.equal(saved.variants[0].outputHeight,1920);
    if(kind==='revision')assert.match(images[0].messages[0].content,/删除左上角角标/);
    if(kind==='sku')assert.deepEqual(images.map(c=>c.messages[0].inputImageDataUrls),[[source,'sku-a'],[source,'sku-a','sku-b']]);
    assert.ok(!f.calls.some(c=>c.operationId===job.id&&c.stepId.startsWith('plan-')));
  }
});

test('batch edit retains successful images, retries one failed image with a new stable step, and preserves restart results',async()=>{
  const f=commerceFixture();let fail=true;
  const runModel:IndustryModelRunner=async(scope,input)=>{if(input.kind==='image'&&input.messages[0].inputImageDataUrls?.[0]==='detail'&&fail){f.calls.push(input);throw Error('synthetic failed image');}return f.dependencies.runModel(scope,input);};
  const service=new CommerceService(f.store,{...f.dependencies,runModel});
  const input={usageSessionId:f.editSession.id,instruction:'把79元改成69元',items:[{imageId:'product'},{imageId:'detail',instruction:'只删除右上角角标'}]};
  const created=await service.createEdit(owner,COMMERCE_EDIT_AGENT_ID,input,'batch-edit-request-0001');await f.idle(created.id);
  const first=await f.current(created.id);assert.equal(first.status,'partial');const completed=first.variants[0].imageAttachmentId;assert.ok(completed);
  assert.equal((await service.createEdit(owner,COMMERCE_EDIT_AGENT_ID,input,'batch-edit-request-0001')).id,created.id);assert.equal(f.calls.length,2);
  assert.deepEqual(f.calls.map(c=>c.messages[0].inputImageDataUrls),[['product'],['detail']]);
  assert.match(f.calls[0].messages[0].content,/把79元改成69元/);assert.doesNotMatch(f.calls[0].messages[0].content,/只删除右上角角标/);
  fail=false;await service.retry(owner,created.id,first.variants[1].id,undefined,'batch-retry-request-001',f.editSession.id);await f.idle(created.id);
  assert.equal((await f.current(created.id)).status,'completed');assert.equal((await f.current(created.id)).variants[0].imageAttachmentId,completed);assert.equal(f.calls.length,3);
  await f.store.mutate(db=>{const j=commerceJobAccess(db,owner,created.id);j.status='generating';j.variants[1].status='generating';});
  const snapshot=JSON.stringify(f.db),beforeCalls=f.calls.length;
  const persisted=JSON.parse(snapshot);const restarted=new IndustryStore({read:async()=>persisted,mutate:async fn=>fn(persisted)});
  const restored=new CommerceService(restarted,{...f.dependencies,autoSchedule:false});await restored.recover();await restored.tick();
  const job=commerceJobAccess(await restarted.read(),owner,created.id);assert.equal(job.status,'interrupted');assert.equal(job.variants[0].imageAttachmentId,completed);assert.equal(f.calls.length,beforeCalls);assert.equal(job.requestKey,'batch-edit-request-0001');
});

test('revocation during model work prevents generated output publication and no foreign saved image is attached',async()=>{
  const f=commerceFixture();let release:()=>void=()=>undefined;let started=false;
  const service=new CommerceService(f.store,{...f.dependencies,runModel:async()=>{started=true;await new Promise<void>(r=>{release=r;});return {content:'',imageUrl:'data:synthetic'};}});
  const created=await service.createEdit(owner,COMMERCE_EDIT_AGENT_ID,{usageSessionId:f.editSession.id,imageId:'product',instruction:'改背景'},'revocation-edit-request');
  while(!started)await new Promise(r=>setTimeout(r,1));
  f.db.workspaceMembers.find(m=>m.workspaceId===owner.workspaceId&&m.userId===owner.id)!.status='disabled';release();await new Promise(r=>setTimeout(r,20));
  assert.equal(f.db.attachments.filter(a=>a.id.startsWith('result-')).length,0);
  assert.ok(!f.db.users[0].industry!.commerceJobs.find(j=>j.id===created.id)!.variants[0].imageAttachmentId);
});

test('a second request key cannot rebind an in-flight generation budget and accepted pixels survive budget expiry',async()=>{
  const f=commerceFixture();let release:()=>void=()=>undefined;let started=false;
  const service=new CommerceService(f.store,{...f.dependencies,runModel:async(scope,input)=>{
    if(input.kind!=='image')return f.dependencies.runModel(scope,input);
    started=true;await new Promise<void>(r=>{release=r;});return {content:'',imageUrl:'data:synthetic'};
  }});
  const job=await service.create(owner,COMMERCE_MAIN_AGENT_ID,f.brief,'inflight-main-request-01',f.mainSession.id);await f.idle(job.id);const variant=(await f.current(job.id)).variants[0];
  await service.generate(owner,job.id,variant.id,'ref-a','inflight-generate-request',f.mainSession.id);while(!started)await new Promise(r=>setTimeout(r,1));
  const next=createIndustryUsageSession(f.db,owner,{confirmed:true,requestKey:'inflight-new-session-001',tool:'product_creative',budgetMicros:1_000_000});
  await assert.rejects(service.generate(owner,job.id,variant.id,'ref-a','another-generate-request',next.id),/正在进行/);
  assert.equal((await f.current(job.id)).usageSessionId,f.mainSession.id);
  const session=f.db.users.find(u=>u.id===owner.id)!.industry!.usageSessions.find(s=>s.id===f.mainSession.id)!;session.expiresAt='2000-01-01T00:00:00.000Z';
  release();await f.idle(job.id);assert.ok((await f.current(job.id)).variants[0].imageAttachmentId,'paid pixels stay available after the original budget session expires');
});

test('a storage adapter cannot attach another workspace\'s image to this job',async()=>{
  const f=commerceFixture(),service=new CommerceService(f.store,{...f.dependencies,saveImage:async()=>f.asset('wrong-owner-output',other)});
  const created=await service.createEdit(owner,COMMERCE_EDIT_AGENT_ID,{usageSessionId:f.editSession.id,imageId:'product',instruction:'改背景'},'foreign-output-request-01');
  const job=await f.idle(created.id);assert.equal(job.status,'failed');assert.ok(!job.variants[0].imageAttachmentId);assert.ok(!f.db.attachments.some(a=>a.id==='wrong-owner-output'));
});

test('reference changes drop inherited competitor geometry while retaining user facts and title limits',()=>{
  const f=commerceFixture(),ref=parseCommerceReference({overall:{layout:'左图右文',background:'粉色',palette:'粉',visualStyle:'柔光'},modules:[{type:'benefit',name:'卖点',location:'右边',appearance:'红字',texts:['竞品词']}]},'ref-a');
  const composition=mergeReferenceModules(defaultComposition(f.brief),ref);const benefit=composition.modules.find(m=>m.type==='benefit')!;benefit.enabled=true;benefit.content='保湿';benefit.appearance='用户指定蓝字';
  const changed=commerceVariantBrief({...f.brief,composition},{referenceImageId:'ref-b'} as never).composition!;
  assert.equal(changed.overall.layout,'');assert.equal(changed.modules.find(m=>m.type==='benefit')!.appearance,'用户指定蓝字');assert.equal(changed.modules.find(m=>m.type==='benefit')!.source,undefined);
  const brief=normalizeCommerceBrief({...f.brief,detailImageIds:['detail'],detailText:'未确认功效',keywordCandidates:[{text:'未勾选词',source:'report'}]});
  assert.doesNotMatch(JSON.stringify(commercePlanningBrief(brief)),/未确认功效|未勾选词/);
  const title=normalizeCommerceTitle('身体乳'+'保湿滋润'.repeat(30),brief);assert.ok(title.startsWith('品牌'));assert.ok(commerceTitleUnits(title)<=60);
});

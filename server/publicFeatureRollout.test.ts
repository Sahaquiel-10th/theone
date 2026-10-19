import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database} from './types.js';
import {openPublishedOfficialFeatures} from './publicFeatureRollout.js';
import {availableFeature,releaseFeature,startFeatureRun} from './featureRuns.js';
import {canReadKnowledge} from './enterprisePolicy.js';
import {routingCapabilities} from './capabilityCatalog.js';
import {requireFeatureApproval} from './featurePricing.js';

function fixture() {
  const values={name:'公开测试功能',author:'ONE',description:'整理当前输入',instructions:'PRIVATE_INSTRUCTIONS',limitations:'只用本人资料',integration:'question_answer' as const,modelId:'m',usageMultiplier:.6,knowledgeMode:'optional' as const};
  const version={version:1,values,evidence:'synthetic',approvedBy:'admin',approvedAt:'before'};
  const feature={id:'public',revision:2,status:'approved' as const,draft:{...values},current:version,history:[version],release:{id:'same-release',version:1,userIds:['admin'],publishedAt:'before',publishedBy:'admin'}};
  const db={users:[{id:'admin',enabled:true,role:'admin'},{id:'a',enabled:true,role:'user'},{id:'b',enabled:true,role:'user'}],
    workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[{workspaceId:'wa',userId:'a',role:'owner'},{workspaceId:'wb',userId:'b',role:'owner'}],
    models:[{id:'m',name:'测试模型',kind:'chat',enabled:true,apiKey:'SYNTHETIC_SECRET',systemPrompt:'PRIVATE_MODEL_PROMPT'}],
    knowledgeConnections:[{id:'ka',workspaceId:'wa',status:'connected',provider:'notion',encryptedAccessToken:'PRIVATE_TOKEN'}],
    attachments:[],conversations:[],chatOperations:[],modelUsageRecords:[],powerAccounts:[],powerLedger:[],auditLogs:[],settings:{safetyRules:'safe',officialFeatures:[feature]}} as unknown as Database;
  return {db,feature:db.settings.officialFeatures![0],scope:{workspaceId:'wa',userId:'a'}};
}

test('rollout opens existing and future members without changing version, prices, definitions or active jobs',()=>{
  const {db,feature,scope}=fixture(),before=structuredClone(feature);
  db.chatOperations=[{operationId:'running',workRun:{state:'running',skills:[{id:feature.id,releaseId:feature.release!.id,version:1,values:before.current!.values}]}}] as any;
  const jobs=structuredClone(db.chatOperations);
  assert.throws(()=>availableFeature(db,scope,feature.id));
  assert.deepEqual(openPublishedOfficialFeatures(db).opened,['public']);
  assert.equal(availableFeature(db,scope,feature.id,'same-release').version.values.usageMultiplier,.6);
  assert.equal(availableFeature(db,{workspaceId:'wb',userId:'b'},feature.id).record.release?.audience,'all');
  db.users.push({id:'future',enabled:true,role:'user'} as any);
  db.workspaces.push({id:'wf',status:'active'} as any);
  db.workspaceMembers.push({workspaceId:'wf',userId:'future',role:'owner'} as any);
  assert.equal(availableFeature(db,{workspaceId:'wf',userId:'future'},feature.id).record.release?.id,'same-release');
  assert.deepEqual(feature.history,before.history);assert.deepEqual(feature.draft,before.draft);
  assert.deepEqual(db.chatOperations,jobs);
  assert.equal(db.modelUsageRecords.length,0);assert.equal(db.powerLedger.length,0);
  assert.equal(db.auditLogs.length,1);assert.deepEqual(openPublishedOfficialFeatures(db).opened,[]);assert.equal(db.auditLogs.length,1);
});

test('rollout never publishes drafts, paused, unpublished, invalid versions or private company features',()=>{
  const {db,feature}=fixture();
  const variants=['draft','paused','unpublished','private','invalid'].map(id=>({...structuredClone(feature),id}));
  variants[0].status='draft';variants[1].status='paused';delete variants[2].release;variants[3].workspaceId='wb';variants[4].release!.version=999;
  db.settings.officialFeatures=variants;const before=structuredClone(variants);
  assert.deepEqual(openPublishedOfficialFeatures(db).opened,[]);assert.deepEqual(variants,before);
});

test('public catalog is callable but still requires live exact workspace membership and keeps secrets private',()=>{
  const {db,feature,scope}=fixture();openPublishedOfficialFeatures(db);
  const cards=routingCapabilities(db,scope);
  assert.ok(cards.some(c=>c.featureId===feature.id));
  assert.doesNotMatch(JSON.stringify(cards),/PRIVATE_|SYNTHETIC_SECRET/);
  assert.throws(()=>availableFeature(db,{workspaceId:'wb',userId:'a'},feature.id));
  db.users.find(u=>u.id==='a')!.enabled=false;assert.throws(()=>availableFeature(db,scope,feature.id));
  db.users.find(u=>u.id==='a')!.enabled=true;db.workspaceMembers[0].status='disabled';assert.throws(()=>availableFeature(db,scope,feature.id));
  db.workspaceMembers[0].status='active';db.workspaces[0].status='suspended';assert.throws(()=>availableFeature(db,scope,feature.id));
});

test('all-user release does not grant foreign knowledge or company-private skills',async()=>{
  const {db,feature}=fixture();openPublishedOfficialFeatures(db);
  const scope={workspaceId:'wb',userId:'b'};
  db.workspaces[1].kind='company';db.workspaceMembers[1].role='member';db.workspaceMembers[1].permissions={featureIds:[],knowledgeConnectionIds:[]};
  assert.equal(availableFeature(db,scope,feature.id).record.release?.audience,'all');
  assert.equal(canReadKnowledge(db,scope,'ka'),false);
  const privateFeature={...structuredClone(feature),id:'company-only',workspaceId:'wb',companyReleases:[{workspaceId:'wb',id:'private-release',version:1,publishedAt:'before',publishedBy:'admin'}]};
  db.settings.officialFeatures!.push(privateFeature);
  assert.throws(()=>availableFeature(db,scope,privateFeature.id));
  db.workspaceMembers[1].permissions!.featureIds=[privateFeature.id];
  assert.equal(availableFeature(db,scope,privateFeature.id).record.release?.id,'private-release');
  assert.throws(()=>availableFeature(db,{workspaceId:'wa',userId:'a'},privateFeature.id));
  const store={read:async()=>db,mutate:async<T>(fn:(value:Database)=>T)=>fn(db)};
  await assert.rejects(startFeatureRun(store,scope,feature.id,{operationId:'test_operation_12345',prompt:'只用测试资料',releaseId:'same-release',sourceIds:['ka'],budget:.1,confirmed:true},async()=>{}),/来源不可用|不属于你/);
  assert.equal(db.modelUsageRecords.length,0);assert.equal(db.chatOperations!.length,0);
});

test('future publication needs review and admin but no account list; price confirmation and unpublish still work',()=>{
  const {db,feature,scope}=fixture();
  assert.throws(()=>releaseFeature(db,feature.id,{revision:2,action:'publish',version:1,confirmed:true},'a'),/无权/);
  releaseFeature(db,feature.id,{revision:2,action:'publish',version:1,confirmed:true},'admin');
  assert.equal(availableFeature(db,scope,feature.id).record.release?.audience,'all');
  assert.deepEqual(feature.release!.userIds,[]);
  assert.equal(feature.current!.values.usageMultiplier,.6);
  assert.throws(()=>requireFeatureApproval(db,scope,[{id:feature.id,name:feature.current!.values.name,releaseId:feature.release!.id,version:1,multiplier:3}],[]),/超过/);
  releaseFeature(db,feature.id,{revision:feature.revision,action:'unpublish'},'admin');
  openPublishedOfficialFeatures(db);assert.throws(()=>availableFeature(db,scope,feature.id));
});

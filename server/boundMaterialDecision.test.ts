import test from 'node:test';
import assert from 'node:assert/strict';
import {needsBoundMaterialDecision} from './boundMaterialDecision.js';
const source={version:1 as const,workspaceId:'w',userId:'u',taskId:'task',inputMessageId:'message',contentDigest:'a'.repeat(64),attachmentIds:[]};
const input={workspaceId:'w',userId:'u',taskId:'task',run:{materialScope:'current' as const,materialSource:source}};
test('new attachments, structural blocks and long prose request semantic scope selection without choosing a replacement',()=>{
 for(const text of ['材料：蓝','正文如下：新正文','以下是新版本：蓝','我重新粘贴：蓝','```txt\n新材料\n```','继续沿用旧材料，同时补充这段。'.repeat(70)])assert.equal(needsBoundMaterialDecision({...input,text}),true,text.slice(0,50));
 assert.equal(needsBoundMaterialDecision({...input,text:'参考这份附件',attachmentIds:['owned-new-file']}),true);
 for(const text of ['继续','再详细分析一下这份材料','换个写法','把结尾写得温暖一点','解释一下上面的结论'])assert.equal(needsBoundMaterialDecision({...input,text}),false,text);
});
test('unbound, foreign, local, image and existing conversation-scope tasks retain their fixed entry paths',()=>{
 const text='新材料：蓝';
 for(const change of [{run:undefined},{run:{materialScope:'conversation' as const,materialSource:source}},{run:{...input.run,kind:'image' as const}},{run:{...input.run,executionMode:'local' as const}},{run:{...input.run,localExecution:{deviceId:'device'}}},{run:{...input.run,materialSource:{...source,userId:'foreign'}}},{run:{...input.run,materialSource:{...source,workspaceId:'foreign'}}},{run:{...input.run,materialSource:{...source,taskId:'other-task'}}}])assert.equal(needsBoundMaterialDecision({...input,text,...change} as Parameters<typeof needsBoundMaterialDecision>[0]),false);
});
test('an already selected appended lineage still requests a semantic decision for another material, but not a brief',()=>{
 const run={materialScope:'conversation' as const,materialSources:[source,{...source,inputMessageId:'second-message'}]};
 assert.equal(needsBoundMaterialDecision({...input,run,text:'新增原文：蓝'}),true);
 assert.equal(needsBoundMaterialDecision({...input,run,text:'把比较写得口语一点'}),false);
 for(const materialSources of [[],[source,{...source,userId:'foreign'}],null as never])assert.equal(needsBoundMaterialDecision({...input,run:{...run,materialSources},text:'新增原文：蓝'}),false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {coordinatorDialogue} from './coordinatorDialogue';
import {conversationTimeline} from './conversationTimeline';
import type {CoordinatorDraft} from './coordinatorDrafts';
import type {Message} from '../server/types';
const failure={code:'local_device_offline',stage:'accepting',outcome:'not_started'} as const;
const draft:CoordinatorDraft={operationId:'original-operation',text:'save the original file',createdAt:'2026-11-01T00:00:00.000Z',state:'failed',outputDestination:'local',rejection:{failure,requestId:'req-safe'}};
const input={userId:'user',messages:[] as Message[],drafts:[draft],outgoing:null,failureReply:null};
test('a pending ordinary send keeps its original position when an introduction starts before its receipt arrives',()=>{
 const pending=coordinatorDialogue({...input,drafts:[],outgoing:{id:'pending',text:'先发出的消息',priorIds:[],createdAt:'2026-11-04T01:00:00Z'}});
 const combined=conversationTimeline(pending,[{id:'intro',createdAt:'2026-11-04T01:00:01Z',content:'后来打开引导'}]);
 assert.equal(combined[0].kind,'message');assert.equal(pending[0].createdAt,'2026-11-04T01:00:00Z');
});
test('a known refused turn survives refresh and a later unrelated send, without pretending acceptance',()=>{
 const before=coordinatorDialogue(input);assert.equal(before.length,2);assert.equal(before[0].text,draft.text);assert.equal(before[0].featureName,'尚未开始 · 原话保留');assert.match(before[1].text,/连接|Key/);
 const after=coordinatorDialogue({...input,outgoing:{id:'new',text:'Why?',priorIds:[]}});assert.equal(after.length,3);assert.equal(after[0].text,draft.text);assert.equal(after[2].text,'Why?');
 assert.deepEqual(coordinatorDialogue({...input,messages:[{id:'later',role:'assistant',content:'later saved response',createdAt:'2026-11-01T00:00:01.000Z'}]}).map(item=>item.id),['outgoing_original-operation','feedback_original-operation','later']);
});
test('server refusal messages replace exactly one local pair by operation ID, not by matching text',()=>{
 const messages:Message[]=[{id:'durable-u',role:'user',content:draft.text,createdAt:draft.createdAt,rejectedSubmission:{operationId:draft.operationId,failure}},{id:'durable-a',role:'assistant',content:'尚未开始，请先插入 Key。',createdAt:draft.createdAt,rejectedSubmission:{operationId:draft.operationId,failure}}];
 const result=coordinatorDialogue({...input,messages,outgoing:{id:draft.operationId,text:draft.text,failed:true,notStarted:true,priorIds:[]},failureReply:{scope:'user',operationId:draft.operationId,text:'local duplicate'}});
 assert.deepEqual(result.map(item=>item.id),['durable-u','durable-a']);assert.equal(result[0].featureName,'尚未开始 · 原话保留');
 const repeated=coordinatorDialogue({...input,messages:[{id:'same-text',role:'user',content:draft.text,createdAt:draft.createdAt}]});assert.equal(repeated.filter(item=>item.role==='user').length,2);
});
test('unknown and partial drafts do not become fake refused/accepted history and foreign feedback stays isolated',()=>{
 for(const state of ['pending','review','missing'] as const)assert.equal(coordinatorDialogue({...input,drafts:[{...draft,state}]}).length,0);
 assert.equal(coordinatorDialogue({...input,drafts:[],failureReply:{scope:'another-user',operationId:'x',text:'private'}}).length,0);
});

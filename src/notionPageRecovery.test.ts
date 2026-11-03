import test from 'node:test';
import assert from 'node:assert/strict';
import type {api as Api} from './oneApi';
import {verifySelectedNotionPage} from './notionPageRecovery';
const id='0123456789abcdef0123456789abcdef';
const selection={sourceJobId:'original-job',expectedUpdatedAt:'2026-11-03T01:00:00.000Z',pageUrl:`https://www.notion.so/original-${id}`,selectionId:'selection-one'};
test('the visible original-page action targets the exact task, job and version on the read-only verification route',async()=>{
 const calls:{path:string;options:RequestInit}[]=[];
 const api=(async(path:string,options:RequestInit)=>{calls.push({path,options});return {state:'verified'};}) as typeof Api;
 assert.deepEqual(await verifySelectedNotionPage(api,'task-one',selection),{state:'verified'});
 assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/coordinator/tasks/task-one/notion/verify');
 assert.deepEqual(JSON.parse(calls[0].options.body as string),{...selection,pageUrl:`https://www.notion.so/${id}`});
 assert.doesNotMatch(calls[0].path,/messages|retry|create|write/);
});
test('invalid or incomplete recovery inputs do not submit, and the page URL is never fetched directly',async()=>{
 let calls=0;const api=(async()=>{calls++;return {};}) as typeof Api;
 for(const patch of [{pageUrl:'https://credential.invalid/'+id},{pageUrl:'file:///private/file'},{sourceJobId:''},{expectedUpdatedAt:'yesterday'},{selectionId:''}]){
  await assert.rejects(verifySelectedNotionPage(api,'task-one',{...selection,...patch}));
 }
 assert.equal(calls,0);
});

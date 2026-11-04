import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import express from 'express';
import type {Database,ModelUsageRecord} from './types.js';
import type {Store} from './db.js';
import {createTeachingCourse,teachingConversationId} from './teaching.js';
import {installTeachingAiRoutes} from './teachingAiRoutes.js';

test('course usage HTTP reads exact lifetime payer totals without executing or exposing another workspace',async t=>{
  const a={userId:'teacher-a',workspaceId:'wa'},b={userId:'teacher-b',workspaceId:'wa'},other={userId:'teacher-a',workspaceId:'wb'};
  const db={users:[{id:a.userId,enabled:true},{id:b.userId,enabled:true}],workspaceMembers:[a,b,other].map(scope=>({...scope,role:'owner'})),workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],knowledgeConnections:[],modelUsageRecords:[]} as unknown as Database;
  const course=createTeachingCourse(db,a,{title:'课程',budgetMicros:5_000_000});
  db.modelUsageRecords=[{...a,conversationId:teachingConversationId(course.id),chargedMicros:1_100_000,reservedMicros:0},{...a,conversationId:teachingConversationId(course.id),chargedMicros:0,reservedMicros:200_000},{...b,conversationId:teachingConversationId(course.id),chargedMicros:80_000_000},{...other,conversationId:teachingConversationId(course.id),chargedMicros:90_000_000},{...a,conversationId:'different-course',chargedMicros:99_000_000}] as ModelUsageRecord[];
  let mutations=0,models=0;const before=JSON.stringify(db),store={read:async()=>db,mutate:async()=>{mutations++;throw Error('read-only');}} as unknown as Store;
  const app=express();app.use(express.json());const auth:express.RequestHandler=(req,res,next)=>{const user=db.users.find(row=>row.id===req.get('x-user'));if(!user){res.sendStatus(401);return;}req.user=user;req.workspaceId=req.get('x-workspace')??'wa';next();};
  installTeachingAiRoutes(app,[auth],store,{verifyKey:async()=>{throw Error('usage reads do not execute');},modelCall:async()=>{models++;throw Error('never call');}});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/teaching/courses/${course.id}/usage`;
  const response=await fetch(url,{headers:{'x-user':a.userId,'x-workspace':a.workspaceId}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{usage:{spentMicros:1_100_000,reservedMicros:200_000,budgetMicros:5_000_000,remainingMicros:3_700_000}});
  for(const scope of [b,other])assert.equal((await fetch(url,{headers:{'x-user':scope.userId,'x-workspace':scope.workspaceId}})).status,404);
  assert.equal((await fetch(url)).status,401);assert.equal(mutations,0);assert.equal(models,0);assert.equal(JSON.stringify(db),before);
});

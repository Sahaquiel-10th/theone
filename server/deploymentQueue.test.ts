import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { reconcileInterruptedChatOperations } from './chatOperations.js';
import type { Database } from './types.js';

test('deployment preserves only unstarted durable queues; active, ordinary or unknown pending operations still block',()=>{
 const run=(rows:unknown[])=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`import {pendingWork} from './deploy/pending-work.mjs';console.log(JSON.stringify(pendingWork(${JSON.stringify(rows)})));`],{encoding:'utf8'}));
 assert.deepEqual(run([{state:'queued',total:2}]),{active:0,queued:2});
 assert.deepEqual(run([{state:'queued',total:2},{state:'running',total:1},{state:null,total:1},{state:'prepared',total:1},{state:'unknown',total:1}]),{active:4,queued:2});
 assert.deepEqual(run([]),{active:0,queued:0});
 const db={chatOperations:[{id:'q',status:'pending',workRun:{state:'queued'}},{id:'running',status:'pending',workRun:{state:'running'}},{id:'ordinary',status:'pending'}],conversations:[]} as unknown as Database;
 reconcileInterruptedChatOperations(db);assert.equal(db.chatOperations![0].status,'pending');assert.equal(db.chatOperations![0].workRun!.state,'queued');assert.equal(db.chatOperations![1].status,'interrupted');assert.equal(db.chatOperations![2].status,'interrupted');
});

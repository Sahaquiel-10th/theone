import test from 'node:test';
import assert from 'node:assert/strict';
import {billingDiagnostics} from './billingDiagnostics.js';
import type {Database,ModelUsageRecord} from './types.js';
test('Pareto attribution is scoped, sorted, no private content, and cache costs are not double-added to totals',()=>{
 const rows=[{id:'one',workspaceId:'wa',userId:'a',requestId:'r1',activity:'coordinator',chargedMicros:100000,cacheUsage:{read:1000,write:10000,write1h:2000},cachePricesSnapshot:{read:.3,write:3.75,write1h:6},inputProfile:{totalBytes:24000}},{id:'two',workspaceId:'wa',userId:'a',requestId:'r1',activity:'coordinator',chargedMicros:50000},{id:'three',workspaceId:'wa',userId:'a',requestId:'r2',activity:'task_worker',chargedMicros:30000},{id:'foreign',workspaceId:'wb',userId:'a',chargedMicros:999999},{id:'foreign-user',workspaceId:'wa',userId:'b',chargedMicros:999999}] as ModelUsageRecord[];
 const db={chatOperations:[{workspaceId:'wa',userId:'a',requestId:'r1',status:'failed',originalText:'PRIVATE_BODY'},{workspaceId:'wb',userId:'a',requestId:'r2',status:'completed'}]} as unknown as Database;
 const d=billingDiagnostics(db,{workspaceId:'wa',userId:'a'},rows);
 assert.equal(d.chargedMicros,180000);assert.equal(d.cacheWriteMicros,42000);assert.equal(d.cacheReadMicros,300);assert.equal(d.topRequests[0].requestId,'r1');assert.equal(d.topRequests[0].state,'failed');assert.equal(d.topRequests[1].state,'unknown');assert.equal(d.profiledCalls,1);assert.equal(d.byActivity[0].chargedMicros,150000);assert.doesNotMatch(JSON.stringify(d),/PRIVATE_BODY|foreign/);
});

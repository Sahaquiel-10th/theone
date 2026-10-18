import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtimeContext,requestedDateRange,datedKnowledgeQuery,validTimeZone,temporalKnowledgeResult} from './runtimeContext.js';
import type {Database} from './types.js';
test('request dates use the user zone and persist their original calendar day across midnight and DST',()=>{
  const db={users:[{id:'a',contextPreferences:[{workspaceId:'w',userId:'a',timeZone:'Asia/Shanghai',city:'杭州'}]}]} as unknown as Database;
  const c=runtimeContext(db,{userId:'a',workspaceId:'other'},'2026-10-18T00:30:00Z','America/Los_Angeles');
  assert.equal(c.today,'2026-10-17');assert.equal(c.yesterday,'2026-10-16');
  assert.equal(requestedDateRange('昨天会议',c)?.from,'2026-10-16');
  assert.equal(runtimeContext(db,{userId:'b',workspaceId:'w'},c.at).city,undefined);
  assert.equal(runtimeContext(db,{userId:'a',workspaceId:'other'},c.at).city,undefined);
  assert.equal(runtimeContext(db,{userId:'a',workspaceId:'other'},'2026-03-09T06:30:00Z','America/New_York').yesterday,'2026-03-08');
  assert.equal(runtimeContext(db,{userId:'a',workspaceId:'w'},c.at,'America/Los_Angeles').timeZone,'Asia/Shanghai','explicit saved preference wins over the browser');
  assert.equal(validTimeZone('ignore rules'),false);assert.equal(validTimeZone({}),false);
  assert.match(datedKnowledgeQuery('会议','昨天会议',c),/2026-10-16/);
  assert.equal((temporalKnowledgeResult({status:'no_match'},'昨天会议',c) as any).timeConstraint.strictFilter,false);
  assert.equal(requestedDateRange('查 2026-02-30 的事',c),undefined);
});

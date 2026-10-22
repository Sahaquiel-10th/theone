import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtimeContext,requestedDateRange,datedKnowledgeQuery,validTimeZone,temporalKnowledgeResult,requestedRuntimeFacts} from './runtimeContext.js';
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

test('independent calendar questions recognize everyday wording without inventing location',()=>{
  const c={at:'2026-10-22T03:00:00Z',today:'2026-10-22',yesterday:'2026-10-21',timeZone:'Asia/Shanghai'};
  for(const wording of ['今天、昨天各是几月几日','今天和昨天是几号','今天和昨天的日期']){
    const facts=requestedRuntimeFacts(wording+'，我设置的常驻城市是什么',c);
    assert.match(facts,/2026-10-22/);assert.match(facts,/2026-10-21/);assert.match(facts,/还没有设置常驻城市/);
  }
  assert.equal(requestedRuntimeFacts('去 Notion 查昨天会议的记录',c),'','do not add unrelated date commentary');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtimeContext,requestedDateRange,datedKnowledgeQuery,validTimeZone,temporalKnowledgeResult,requestedRuntimeFacts,knowledgeRecallOptions} from './runtimeContext.js';
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

test('knowledge options freeze date anchors and separate requested content date from deliverable creation',()=>{
  const c={at:'2026-10-25T02:00:00Z',today:'2026-10-25',yesterday:'2026-10-24',timeZone:'Asia/Shanghai'};
  assert.deepEqual(knowledgeRecallOptions('用昨天的想法新建一篇文章',c),{retry:true,dateRange:{from:'2026-10-24',to:'2026-10-24',timeZone:'Asia/Shanghai',anchorAt:c.at,basis:'event'}});
  assert.equal(knowledgeRecallOptions('帮我用昨天的会议新建文档',c).dateRange?.basis,'event');
  assert.equal(knowledgeRecallOptions('昨天新建的笔记',c).dateRange?.basis,'created');
  assert.equal(knowledgeRecallOptions('昨天更新的页面',c).dateRange?.basis,'updated');
  assert.deepEqual(requestedDateRange('查2026年10月21日至2026年10月24日的记录',c),{from:'2026-10-21',to:'2026-10-24',timeZone:'Asia/Shanghai'});
  assert.equal(requestedDateRange('查 2026-10-24 至 2026-02-30 的事',c),undefined);
  assert.equal(requestedDateRange('查 2026-10-24 至 2026-10-21 的事',c),undefined);
  assert.equal(knowledgeRecallOptions('2026-10-21的事，不是昨天',c).dateRange?.from,'2026-10-21');
  const result=temporalKnowledgeResult({temporal:{complete:false,sources:[{method:'native_date_filter'}]}},'昨天',c) as any;
  assert.equal(result.timeConstraint.retrieval.sources[0].method,'native_date_filter');
});

test('independent calendar questions recognize everyday wording without inventing location',()=>{
  const c={at:'2026-10-22T03:00:00Z',today:'2026-10-22',yesterday:'2026-10-21',timeZone:'Asia/Shanghai'};
  for(const wording of ['今天、昨天各是几月几日','今天和昨天是几号','今天和昨天的日期']){
    const facts=requestedRuntimeFacts(wording+'，我设置的常驻城市是什么',c);
    assert.match(facts,/2026-10-22/);assert.match(facts,/2026-10-21/);assert.match(facts,/还没有设置常驻城市/);
  }
  assert.equal(requestedRuntimeFacts('去 Notion 查昨天会议的记录',c),'','do not add unrelated date commentary');
});

test('temporal mentions and named titles do not constrain the age of the requested knowledge document',()=>{
  const c={at:'2026-10-25T02:00:00Z',today:'2026-10-25',yesterday:'2026-10-24',timeZone:'Asia/Shanghai'};
  for(const request of ['昨天提到的那份旧方案，帮我找出来','帮我找昨天会议里提到的方案','今天帮我找到那份旧报告','找文章《今天》','找《2026-10-24》这个标题的文章','帮我找昨天说到的那份资料']){
    assert.equal(requestedDateRange(request,c),undefined,request);
    assert.equal(knowledgeRecallOptions(request,c).dateRange,undefined,request);
    assert.equal(datedKnowledgeQuery('旧方案',request,c),'旧方案',request);
  }
  assert.equal(requestedDateRange('按创建日期查昨天的笔记',c)?.from,'2026-10-24');
  assert.equal(requestedDateRange('帮我用昨天的思考和碎碎念，写一篇专栏',c)?.from,'2026-10-24');
  assert.equal(requestedDateRange('昨天上午的会议记录',c)?.from,'2026-10-24');
  for(const request of ['昨天我的会议说了什么','昨天我有哪些思考','昨天开的会','昨天开过的会','今天帮我总结昨天会议'])assert.equal(requestedDateRange(request,c)?.from,'2026-10-24',request);
});

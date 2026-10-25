import assert from 'node:assert/strict';
import test from 'node:test';
import { datedKnowledgeChunks, dateSearchQuery, validKnowledgeDateRange, type KnowledgeDateRange } from './temporal.js';

const range: KnowledgeDateRange={from:'2026-10-24',to:'2026-10-24',timeZone:'Asia/Shanghai',anchorAt:'2026-10-25T02:00:00Z',basis:'event'};
test('event date evidence distinguishes old material, undated material and metadata-only candidates',()=>{
  const result=datedKnowledgeChunks([
    {id:'old',title:'旧会议',content:'AI门店的想法',createdAt:'2026-08-01T00:00:00Z'},
    {id:'unknown',title:'无日期',content:'一段想法'},
    {id:'candidate',title:'昨天新增',content:'讲的是去年的会议',createdAt:'2026-10-23T18:00:00Z'},
    {id:'body',title:'长期日记',content:'2026年10月24日：今天聊了社区计划',createdAt:'2026-01-01T00:00:00Z'},
    {id:'body-reference',title:'对照会议',content:'2026/10/24 是对照日期，实际会议发生在 2026-08-01'},
  ],range);
  assert.deepEqual(result.chunks.map(c=>c.id),['candidate','body','body-reference']);
  assert.equal(result.chunks[0].dateEvidence?.status,'metadata_candidate_only');
  assert.equal(result.chunks[1].dateEvidence?.status,'requires_content_verification');
  assert.equal(result.chunks[2].dateEvidence?.status,'requires_content_verification','mentioning a date alone is not proof that it is the event date');
  assert.equal(result.confirmed,2);assert.equal(result.candidates,1);assert.equal(result.outsideRange,1);assert.equal(result.unverified,1);
});
test('created and edited dates are filtered independently and never use the execution host timezone',()=>{
  const chunks=[{id:'a',title:'a',content:'正文',createdAt:'2026-10-23T17:00:00Z',updatedAt:'2026-10-25T00:00:00Z'},{id:'b',title:'b',content:'正文',createdAt:'2026-01-01 00:00:00',updatedAt:'2026-10-24 16:00:00'}];
  assert.deepEqual(datedKnowledgeChunks(chunks,{...range,basis:'created'}).chunks.map(c=>c.id),['a']);
  assert.deepEqual(datedKnowledgeChunks(chunks,{...range,basis:'updated'}).chunks.map(c=>c.id),['b']);
  assert.equal(datedKnowledgeChunks(chunks,{...range,basis:'updated'}).chunks[0].dateEvidence?.status,'metadata_match');
});
test('date search query is bounded, absolute and idempotent',()=>{
  const q=dateSearchQuery('昨天的思考和碎碎念',range);
  assert.equal(q,'2026-10-24 的思考和碎碎念');
  assert.equal(dateSearchQuery(q,range),q);
  assert.equal(dateSearchQuery('x'.repeat(2000),range).length,1200);
  assert.equal(validKnowledgeDateRange(range),true);
  for(const altered of [{from:'2026-02-30'},{to:'2026-01-01'},{timeZone:'not a timezone'},{anchorAt:'not a timestamp'},{basis:'surprise'}])assert.equal(validKnowledgeDateRange({...range,...altered}),false);
});

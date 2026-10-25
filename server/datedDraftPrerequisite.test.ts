import test from 'node:test';
import assert from 'node:assert/strict';
import {datedDraftPrerequisite} from './datedDraftPrerequisite.js';

const input={newDraft:true,requiredKnowledge:true,hasMaterials:false,instruction:'从Notion查昨天的会议笔记，写专栏并保存',originalRequest:'请从Notion查昨天会议，写专栏并保存。',time:{at:'2026-10-25T01:00:00Z',timeZone:'Asia/Shanghai',today:'2026-10-25',yesterday:'2026-10-24'}};
test('only a new dated knowledge-dependent draft without supplied material is gated',()=>{
  assert.ok(datedDraftPrerequisite(input));
  for(const variant of [{newDraft:false},{requiredKnowledge:false},{hasMaterials:true},{instruction:'写一份普通说明并保存'},{originalRequest:'昨天没找到素材时，请保存一份缺料说明。'}])assert.equal(datedDraftPrerequisite({...input,...variant}),undefined);
  assert.ok(datedDraftPrerequisite({...input,originalRequest:'没有素材时不要自行保存说明。'}));
});
test('placeholder writes are refused read-only until actual retrieval yields material; no-match is not an exhaustive absence claim',async()=>{
  const gate=datedDraftPrerequisite(input)!;let writes=0;
  const tool=gate.wrap({name:'save_notion_draft',effect:'external_write',run:async()=>{},structured:{schema:{},validate:v=>v,run:async()=>{writes++;return{state:'verified'};}}});
  assert.equal(tool.structured!.effect!({}),'read');assert.equal((await tool.structured!.run({}) as any).saved,false);
  gate.observe({status:'no_match',chunks:[]});assert.equal(gate.missing,true);assert.match(gate.message(),/这次检索还没找到/);assert.doesNotMatch(gate.message(),/当天没有资料|全部没有/);
  assert.equal((await tool.structured!.run({}) as any).status,'needs_input');assert.equal(writes,0);
  gate.observe({status:'used',chunks:[{content:'2026-10-24 会议原话'}]});assert.equal(gate.blocked,false);assert.equal(tool.structured!.effect!({}),'external_write');
  await tool.structured!.run({});assert.equal(writes,1);
});
test('failed source retrieval is distinguished from a genuine limited no-match',()=>{
  const gate=datedDraftPrerequisite(input)!;gate.observe({status:'failed',chunks:[]});
  assert.match(gate.message(),/资料来源这次没查成/);assert.doesNotMatch(gate.message(),/没有资料|这次检索还没找到/);
});

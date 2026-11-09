import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWorkflowModelOutcome} from './workflowModelResult.js';
import {parseTaskOutcome} from './dispatchPlan.js';
const title='撰写短文',body='# 标题\n\n正文含 **粗体**、`code`、链接 https://example.com/a。\n\n| A | B |\n| --- | --- |\n| 一 | 二 |\n\n自然结尾。';
const value={outcome:'completed' as const,content:body,summary:'正文已完成。'};
const wrap=(payload:unknown,prefix=`这是“${title}”步骤的结果，下面返回完整正文。`,fence='```')=>`${prefix}\n\n${fence}json\n${JSON.stringify(payload)}\n${fence}`;

test('a single exact guided result envelope tolerates its stage explanation and a valid fence without changing manuscript bytes',()=>{
 for(const raw of [JSON.stringify(value),' \n```json\n'+JSON.stringify(value)+'\n```\n ',wrap(value),wrap(value,`这是"${title}"步骤（model 步骤），我只需产出正文；保存与回读是后续 Notion 步骤，本步不执行。下面是本步成果。`),wrap(value,`本轮“${title}”阶段输出如下。`,'~~~~'),wrap(value,`This is the result of stage ${title}.`)])assert.deepEqual(parseWorkflowModelOutcome(raw,title),value);
 const raw=wrap(value);assert.equal(parseTaskOutcome(raw).content,raw,'generic article parsing is deliberately unchanged');
});

test('failed, needs-input and partial guided envelopes retain their real outcome rather than becoming returned success prose',()=>{
 for(const outcome of ['failed','needs_input','partial'] as const){const result={...value,outcome};assert.deepEqual(parseWorkflowModelOutcome(wrap(result),title),result);}
});

test('ordinary JSON teaching articles, unrelated explanations and multiple candidate envelopes are never heuristically stripped',()=>{
 const inputs=[
  wrap(value,'这篇文章讲解 JSON 示例：'),
  wrap(value,`这是“${title}”步骤中的 JSON 示例，不是最终输出。`),
  wrap(value,'这是“另一个步骤”步骤的结果。'),
  '# API 使用指南\n\n'+wrap(value,'下面是一个请求示例。'),
  wrap(value)+'\n\n'+wrap({...value,content:'另一篇内容'}),
  wrap(value)+'\n附加的重要文章段落。',
  '前面是不同文章正文。\n'+JSON.stringify(value),
  JSON.stringify({...value,example:true}),
  wrap({...value,workspaceId:'foreign'}),
  wrap({outcome:'completed',content:body}),
  wrap({...value,outcome:'invented'}),
 ];
 for(const raw of inputs){const result=parseWorkflowModelOutcome(raw,title);assert.equal(result.outcome,'returned');assert.equal(result.content,raw);}
});

test('JSON, code fences, braces and outcome keys authored inside content remain untouched after one normalization',()=>{
 const article='# JSON 协议文章\n\n```json\n'+JSON.stringify({outcome:'failed',content:'这是一段示例，不是执行失败',summary:'代码示例'})+'\n```\n\n最后一段仍是正文。';
 assert.equal(parseWorkflowModelOutcome(wrap({...value,content:article}),title).content,article);
 const jsonArticle=JSON.stringify({...value,example:true});assert.equal(parseWorkflowModelOutcome(JSON.stringify({...value,content:jsonArticle}),title).content,jsonArticle);
});

test('legacy exact duplicate prose and explicit unread results remain compatible',()=>{
 assert.deepEqual(parseWorkflowModelOutcome(body+'\n\n'+JSON.stringify(value),title),value);
 assert.equal(parseWorkflowModelOutcome(JSON.stringify({outcome:'not_completed',reason:'原文尚未读到。',read_performed:false}),title).outcome,'failed');
});

test('empty-content envelopes keep explicit failure/input states and empty completed output never becomes returned JSON',()=>{
 for(const outcome of ['failed','partial','needs_input','completed'] as const)for(const wrapped of [false,true]){
  const envelope={outcome,content:'',summary:outcome==='needs_input'?'请补充文章主题。':'正文生成失败。'},raw=wrapped?wrap(envelope):JSON.stringify(envelope),result=parseWorkflowModelOutcome(raw,title);
  assert.equal(result.outcome,outcome==='completed'?'failed':outcome);assert.equal(result.content,'');assert.notEqual(result.outcome,'returned');
 }
});

test('a malformed reserved three-field result never becomes an ordinary successful JSON manuscript',()=>{
 for(const outcome of ['failed','needs_input','partial','completed'] as const)for(const content of [{message:'生成失败'},null,42,['正文'],true])for(const wrapped of [false,true]){
  const value={outcome,content,summary:'正文没有产生'},raw=wrapped?wrap(value):JSON.stringify(value),result=parseWorkflowModelOutcome(raw,title);
  assert.equal(result.outcome,'failed');assert.ok(result.content.includes('"outcome"'));assert.notEqual(result.content,'[object Object]');
 }
 for(const summary of [null,{},42])assert.equal(parseWorkflowModelOutcome(JSON.stringify({...value,summary}),title).outcome,'failed');
});

test('literal newlines and tabs in an exact guided JSON result decode to manuscript bytes',()=>{
 const content='# 合成文章\n\n段落含中文、"引号"、反斜线 \\ 与制表\t符。\r\n\n自然结尾。';
 const expected={outcome:'completed' as const,content,summary:'正文完成。'};
 const raw=JSON.stringify(expected).replaceAll('\\n','\n').replaceAll('\\r','\r').replaceAll('\\t','\t');
 for(const input of [raw,'```json\n'+raw+'\n```',`这是“${title}”步骤的结果。\n\n\`\`\`json\n${raw}\n\`\`\``]){
  assert.deepEqual(parseWorkflowModelOutcome(input,title),expected);
 }
 for(const outcome of ['failed','partial','needs_input'] as const){
  const result={...expected,outcome};
  assert.deepEqual(parseWorkflowModelOutcome(JSON.stringify(result).replaceAll('\\n','\n'),title),result);
 }
});

test('ambiguous malformed guided envelopes cannot become a completed manuscript',()=>{
 for(const raw of [
  '{"outcome":"completed","content":"段落\n这里有"未转义引号"。","summary":"完成"}',
  '{"outcome":"completed","content":"段落\n缺少结尾","summary":"完成"',
  '{"outcome":"completed","content":"段落\n非法转义\\q","summary":"完成"}',
  '{"outcome":"completed","content":"正文\n出现"不完整}引号"。","summary":"完成"}',
  '{"outcome":"completed","content":"正文\n出现"不完整]引号"。","summary":"完成"}',
  '{"outcome":"completed","content":"正文甲","content":"正文乙","summary":"完成"}',
  '{"outcome":"completed","content":"正文甲","\\u0063ontent":"正文乙","summary":"完成"}',
 ]){
  const parsed=parseWorkflowModelOutcome(raw,title);
  assert.equal(parsed.outcome,'failed');
  assert.equal(parsed.content,raw,'retain the returned data for review');
 }
 const article='# 教程\n\n以下 JSON 示例有未转义换行\n\n{"outcome":"completed","content":"甲\n乙","summary":"例子"}';
 assert.equal(parseWorkflowModelOutcome(article,title).content,article);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {checkNotionContentIntegrity,type NotionContentIntegrityInput} from './notionContentIntegrity.js';

const check=(source:string,remote:string,extra:Partial<NotionContentIntegrityInput>={})=>checkNotionContentIntegrity({source,remote,remoteComplete:true,...extra});

test('the normal checker entry accepts complete ordered content with extra blocks, title decoration and platform styling',()=>{
 const source='# 方案方法\n\n项目「甲」：金额 -3200.50 元，完成率 32%。\n\n- 准备。\n- 执行。\n\n**保留代码 `KEEP_42`** 与 **[格式说明](https://example.test/a_b?x=1&y=2)**。\n\n|阶段|结果|\n|---|---|\n|写稿|完整正文|\n|保存|同一稿件|\n\n自然结尾 END_42。';
 const remote='保存时间 2026-11-10。\n\n# ⭐方案方法 · 2026-11-10\n\n项目“甲”: 金额 -3,200.5 元, 完成率 32％.\n\n1. 准备.\n2. 执行.\n\n<b>保留代码 </b><b><code>KEEP_42</code></b> 与 [<b>格式说明</b>](https://example.test/a_b?x=1&y=2).\n\n额外说明段落。\n\n|阶段|结果|\n| --- | --- |\n|写稿|完整正文|\n|人工备注|稍后查看|\n|保存|同一稿件|\n\n自然结尾 END\\_42.\n\n附加备注保持在原稿之后。';
 const result=check(source,remote,{sourceTitle:'覆盖验收',remoteTitle:'2026-11-10 · 覆盖验收（草稿）'});
 assert.equal(result.state,'covered');assert.equal(result.matchedBlockCount,result.sourceBlockCount);
 assert.equal(result.missingBlockCount,0);assert.deepEqual(result.missingBlockIndexes,[]);
 assert.equal(result.sourceChars,source.length);assert.equal(result.remoteChars,remote.length);
});

test('every complete source paragraph is required and missing indexes include an explicit projected title',()=>{
 const source='第一段。\n\n金额 3200 元。\n\n最后一段。';
 const result=check(source,'前言。\n\n第一段。\n\n最后一段。\n\n后记。',{sourceTitle:'原文标题',remoteTitle:'原文标题'});
 assert.equal(result.state,'missing');assert.equal(result.sourceBlockCount,4);assert.equal(result.matchedBlockCount,3);
 assert.equal(result.missingBlockCount,1);assert.deepEqual(result.missingBlockIndexes,[3]);
});

for(const [label,source,remote] of [
 ['changed amount','金额 3200 元。','金额 3201 元。'],
 ['lost negative sign','结余 -3200 元。','结余 3200 元。'],
 ['lost positive sign','变化 +3200 元。','变化 3200 元。'],
 ['changed decimal','比例 3.20。','比例 3.21。'],
 ['lost percent','完成率 32%。','完成率 32。'],
 ['changed percent','完成率 32%。','完成率 33%。'],
 ['decimal becomes integer','比例 3.2。','比例 32。'],
 ['numeric suffix','金额3200','金额32000'],
 ['numeric prefix','金额32','金额132'],
 ['code bytes','保留 `KEEP_42`。','保留 <code>KEEP_43</code>。'],
 ['code escapes','保留 `a\\_b`。','保留 `a_b`。'],
 ['code newline','```text\n甲\n乙\n```','```text\n甲乙\n```'],
 ['code literal punctuation','```text\n甲：乙，3200\n```','```text\n甲:乙,3200\n```'],
 ['link destination','[资料](https://example.test/a?amount=3200)','[资料](https://example.test/a?amount=3201)'],
 ['link destination escapes','[资料](https://example.test/a_b)','[资料](https://example.test/a\\_b)'],
 ['link label','[原始资料](https://example.test/a)','[其他资料](https://example.test/a)'],
 ['negated sentence','已经批准这个项目。','没有批准这个项目。'],
 ['reordered paragraphs','甲段。\n\n乙段。','乙段。\n\n甲段。'],
 ['reordered list items','- 准备。\n- 执行。','- 执行。\n- 准备。'],
 ['checkbox meaning','- [x] 已核对','- [ ] 已核对'],
] as const)test(`complete coverage rejects ${label}`,()=>{
 const result=check(source,remote);
 assert.equal(result.state,'missing');assert.ok(result.missingBlockCount>0);
});

for(const [source,remote] of [
 ['金额 3200 元。','金额 3,200.00 元.'],
 ['金额 −3200.50 元。','金额 -3，200.5 元.'],
 ['完成率 32%。','完成率 32.00％.'],
 ['测量值 1e3。','测量值 1000.0.'],
 ['测量值 0.001。','测量值 1e-3.'],
 ['编号 ００３２。','编号 32.'],
] as const)test(`numeric display remains exact without floating-point rounding for ${source}`,()=>{
 assert.equal(check(source,remote).state,'covered');
});

test('ordinary punctuation presentation may vary while JSON field and word boundaries remain present',()=>{
 assert.equal(check('他说「先做」：准备甲，准备乙。','他说“先做”: 准备甲,准备乙.').state,'covered');
 assert.notEqual(check('{"a":"bc"}','{"ab":"c"}').state,'covered');
 assert.equal(check('甲乙。','甲丙。').state,'missing');
});

test('one remote occurrence cannot satisfy repeated source paragraphs or list items',()=>{
 for(const marker of ['重复段落。','- 重复项目']){
  const source=marker.startsWith('-')?marker+'\n'+marker:marker+'\n\n'+marker;
  const one=check(source,marker),two=check(source,source);
  assert.equal(one.state,'missing');assert.equal(one.matchedBlockCount,1);assert.equal(one.missingBlockCount,1);
  assert.deepEqual(one.missingBlockIndexes,[2]);assert.equal(two.state,'covered');assert.equal(two.matchedBlockCount,2);
 }
});

test('table rows and cells retain their separate ordered identities',()=>{
 const source='|项目|金额|\n|---|---|\n|甲|3200|\n|乙|4200|';
 assert.equal(check(source,'|项目|金额|\n|---|---|\n|备注|0|\n|甲|3200|\n|其他|1|\n|乙|4200|').state,'covered');
 for(const remote of [
  '|项目|金额|\n|---|---|\n|甲|3201|\n|乙|4200|',
  '|金额|项目|\n|---|---|\n|3200|甲|\n|4200|乙|',
  '|项目|金额|\n|---|---|\n|乙|4200|\n|甲|3200|',
  '|项目|金额|\n|---|---|\n|甲3200|乙4200|',
 ])assert.equal(check(source,remote).state,'missing');
 const merged='|合并列|\n|---|\n|项目 金额|\n|甲 3200|\n|乙 4200|';
 assert.equal(check(source,merged).state,'inconclusive');
 const duplicate='|项目|金额|\n|---|---|\n|甲|3200|\n|甲|3200|';
 assert.equal(check(duplicate,'|项目|金额|\n|---|---|\n|甲|3200|').state,'missing');
});

test('title decoration requires a safe boundary and cannot invert or change its numeric claim',()=>{
 assert.equal(check('正文。','正文。',{sourceTitle:'批准计划',remoteTitle:'⭐批准计划 · 2026-11-10（草稿）'}).state,'covered');
 for(const remoteTitle of ['不批准计划','未批准计划','批准计划失败'])assert.equal(check('正文。','正文。',{sourceTitle:'批准计划',remoteTitle}).state,'missing');
 for(const [sourceTitle,remoteTitle] of [['金额3200','金额32000'],['3200','-3200'],['完成率32%','完成率32%0']] as const)assert.equal(check('正文。','正文。',{sourceTitle,remoteTitle}).state,'missing');
 assert.equal(check('正文。','正文。',{sourceTitle:'原题'}).reason,'title_unavailable');
});

test('inline additions and merged paragraphs remain inconclusive when exact whole-block coverage is ambiguous',()=>{
 for(const [source,remote] of [['批准','不批准'],['第一段。','前缀说明。第一段。后缀说明。'],['第一段。\n\n第二段。','第一段。第二段。'],['甲乙丙丁','甲乙\n\n丙丁'],['甲乙\n\n丙丁','甲乙丙丁'],['甲，乙。','甲乙']] as const){
  const result=check(source,remote);assert.equal(result.state,'inconclusive');assert.equal(result.reason,'ambiguous_layout');
  assert.equal(result.missingBlockCount,0);assert.deepEqual(result.missingBlockIndexes,[]);
 }
});

test('layout uncertainty can include actual title properties without guessing or declaring source coverage',()=>{
 const source='# 原稿标题\n\n完整正文。';
 assert.equal(check(source,'完整正文。',{remoteTitle:'原稿标题'}).state,'inconclusive');
 assert.equal(check('完整正文。','# 原稿标题\n\n完整正文。',{sourceTitle:'原稿标题',remoteTitle:'平台标题'}).state,'inconclusive');
 assert.equal(check('重复\n\n重复','重复').state,'missing');
 assert.equal(check('甲乙\n\n丙丁','丙丁\n\n甲乙').state,'missing');
});

test('the checker never unwraps authored JSON or an unproven transport envelope',()=>{
 const authored='{"amount":3200,"content":"原样保留"}';
 assert.equal(check(authored,authored).state,'covered');
 assert.equal(check(authored,'原样保留').state,'missing');
 assert.notEqual(check('原样保留',JSON.stringify({text:'原样保留'})).state,'covered');
});

test('incomplete reads and unknown platform syntax are inconclusive even if the source is visibly present',()=>{
 assert.equal(check('完整原文。','完整原文。',{remoteComplete:false}).reason,'remote_incomplete');
 assert.equal(check('完整原文。','完整原文。\n\n<unknown url="https://example.test/block" />').reason,'unsupported_remote');
 assert.equal(check('<custom-block definition-id="x"/>','原文').reason,'unsupported_source');
 assert.equal(check('```text\n代码','```text\n代码').state,'inconclusive');
});

test('missing diagnostics are bounded one-based indexes and never contain private source text',()=>{
 const source=Array.from({length:31},(_,index)=>`PRIVATE_ALPHA_BODY ${index}。`).join('\n\n');
 const result=check(source,'');
 assert.equal(result.state,'missing');assert.equal(result.missingBlockCount,31);assert.equal(result.missingBlockIndexes.length,20);
 assert.deepEqual(result.missingBlockIndexes,Array.from({length:20},(_,index)=>index+1));
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_ALPHA_BODY/);
});

test('comparison limits produce an explicit inconclusive result',()=>{
 assert.equal(check('a'.repeat(250001),'a').reason,'comparison_limit');
 const body=Array.from({length:1100},(_,index)=>`段落 ${index}。`).join('\n\n');
 assert.equal(check(body,body).reason,'comparison_limit');
 assert.equal(check('','正文。').reason,'source_empty');
});


test('appended link-label text is layout uncertainty while its exact URL, numeric values and code remain required',()=>{
 const source='[原资料 3200 `KEEP_42`](https://example.test/source)';
 const remote='[原资料 3200 `KEEP_42`（补充说明）](https://example.test/source)';
 const result=check(source,remote);assert.equal(result.state,'inconclusive');assert.equal(result.reason,'ambiguous_layout');assert.equal(result.missingBlockCount,0);assert.deepEqual(result.missingBlockIndexes,[]);
 for(const changed of [remote.replace('/source)','/other)'),remote.replace('3200','3201'),remote.replace('KEEP_42','KEEP_43')])assert.equal(check(source,changed).state,'missing');
});

test('splitting a complete table is inconclusive without allowing missing values, changed cells or row reordering',()=>{
 const source='|项目|金额|\n|---|---|\n|甲|3200|\n|乙|4200|';
 const remote='|项目|金额|\n|---|---|\n|甲|3200|\n\n|项目|金额|\n|---|---|\n|乙|4200|';
 const result=check(source,remote);assert.equal(result.state,'inconclusive');assert.equal(result.reason,'ambiguous_layout');assert.equal(result.missingBlockCount,0);assert.deepEqual(result.missingBlockIndexes,[]);
 for(const changed of [remote.replace('3200','3201'),remote.replace('|乙|4200|','|乙4200||'),remote.replace('|甲|3200|','|乙|4200|').replace(/\|乙\|4200\|$/,'|甲|3200|')])assert.equal(check(source,changed).state,'missing');
});

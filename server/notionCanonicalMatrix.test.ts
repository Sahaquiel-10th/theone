import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalNotionDigest,notionHash,type NotionCanonicalVersion} from './notionCanonical.js';

const digest=(body:string)=>canonicalNotionDigest(body,10);

test('v10 compares every CommonMark punctuation escape only after parsing it as text',()=>{
 const punctuation='!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
 for(const character of punctuation){
  const original=`左 ${character} Right`,serialized=`左 \\${character} Right`;
  assert.equal(digest(original),digest(serialized),character);
  assert.notEqual(digest(original),digest(`左 Right`),`a visible ${character} cannot disappear`);
 }
});

const equivalentFormats:[string,string,string][]=[
 ['Chinese and English punctuation','方法 {开始}、[第二步]、价格 $3000、a|b、a~b、a^b。','方法 \\{开始\\}、\\[第二步\\]、价格 \\$3000、a\\|b、a\\~b、a\\^b。'],
 ['named entities','甲 & 乙 < 丙 > 丁。','甲 &amp; 乙 &lt; 丙 &gt; 丁。'],
 ['numeric entities','编号 {甲}、猫 🐱、不换行\u00a0空格。','编号 &#123;甲&#x7D;、猫 &#x1F431;、不换行&nbsp;空格。'],
 ['heading','## 方法 {开始}\n\n正文。','## 方法 \\{开始\\}\n\n正文。'],
 ['bulleted list','- [第一项] {甲}\n- 费用 $3000','- \\[第一项\\] \\{甲\\}\n- 费用 \\$3000'],
 ['numbered list','1. 第一项 {甲}\n2. 第二项 [乙]','1. 第一项 \\{甲\\}\n2. 第二项 \\[乙\\]'],
 ['task list','- [ ] 核对 {甲}\n- [x] 核对 [乙]','- [ ] 核对 \\{甲\\}\n- [x] 核对 \\[乙\\]'],
 ['table','|项目|说明|\n|---|---:|\n|测试|{值} & 更多|','|项目|说明|\n| --- | --- |\n|测试|\\{值\\} &amp; 更多|'],
 ['quote','> 先做 {甲}\n>\n> 再做 [乙]','<quote>\n先做 \\{甲\\}\n\n再做 \\[乙\\]\n</quote>'],
 ['plain inline code','`one_qa` 与正文 {甲}。','<code>one_qa</code> 与正文 \\{甲\\}。'],
 ['code beside escaped text','```json\n{"amount":3000}\n```\n\n正文 {甲}。','```json\n{"amount":3000}\n```\n\n正文 \\{甲\\}。'],
 ['link label','[资料 {中文} & More](https://example.test/a_b?x=1&y=2)','[资料 \\{中文\\} &amp; More](https://example.test/a_b?x=1&y=2)'],
 ['literal unmatched backtick','正文 ` 是一个字符。','正文 \\` 是一个字符。'],
 ['bold text with escapes','**标签 {甲} [乙]**','<b>标签 \\{甲\\} \\[乙\\]</b>'],
 ['italic entity text','*A & More*','<i>A &amp; More</i>'],
 ['strikethrough text','~~旧步骤 {甲}~~','<s>旧步骤 \\{甲\\}</s>'],
 ['underlined text','<u>下划线 {甲}</u>','<u>下划线 \\{甲\\}</u>'],
 ['bold inline code','**正文 {甲}与 `one_qa`**','<b>正文 \\{甲\\}与 <code>one_qa</code></b>'],
 ['bold link','**正文与 [资料 {甲}](https://example.test/a_b)**','<b>正文与 [资料 \\{甲\\}](https://example.test/a_b)</b>'],
 ['nested italic bold','***第一层 {甲}***','<i><b>第一层 \\{甲\\}</b></i>'],
 ['nested bold italic order','**_第一层 {甲}_**','<i><b>第一层 \\{甲\\}</b></i>'],
 ['paragraph spacing','第一段。\n\n第二段。','第一段。\n\n\n第二段。'],
 ['v1 empty paragraph','第一段。\n\n第二段。','第一段。\n<empty-block/>\n第二段。'],
 ['v2 empty paragraph','第一段。\n\n第二段。','第一段。\n<p />\n第二段。'],
 ['empty paragraph variants','第一段。\n\n第二段。','第一段。\n<empty-block />\n<p/>\n第二段。'],
];

for(const [label,original,serialized] of equivalentFormats)test(`v10 common format matrix preserves ${label}`,()=>{
 assert.equal(digest(original),digest(serialized));
 assert.notEqual(digest(original),digest(serialized+'\n\n新增内容。'),
  'a real content mutation remains different');
});

test('v10 recognizes escaped braces around literal envelope text while preserving its exact values and structure',()=>{
 // The comparator may encounter an old saved envelope. Deciding whether a
 // model envelope is valid remains the workflow parser's separate contract.
 const original='{\n"outcome":"completed",\n"content":"第一段。\n\n第二段。",\n"amount":3000,\n"summary":"摘要"\n}';
 const serialized='\\'+original.slice(0,-1)+'\\}';
 assert.equal(digest(original),digest(serialized));
 assert.notEqual(canonicalNotionDigest(original,9),canonicalNotionDigest(serialized,9));
 for(const changed of [
  serialized.replace('3000','3001'),
  serialized.replace('第二段','第三段'),
  serialized.replace('"summary"','"summaries"'),
  serialized.replace('"outcome":"completed",\n',''),
  serialized.slice(1,-2),
  serialized.replace('第一段。\n\n第二段。','第一段。\n第二段。'),
 ])assert.notEqual(digest(original),digest(changed));
});

const distinctFormats:[string,string,string][]=[
 ['real strong style','**加粗**','\\*\\*加粗\\*\\*'],
 ['real emphasis style','*斜体*','\\*斜体\\*'],
 ['real strike style','~~删除~~','\\~\\~删除\\~\\~'],
 ['real link','[资料](https://example.test)','\\[资料\\](https://example.test)'],
 ['link target escape','[资料](https://example.test/a_b)','[资料](https://example.test/a\\_b)'],
 ['link target entity','[资料](https://example.test/?a=1&b=2)','[资料](https://example.test/?a=1&amp;b=2)'],
 ['link label changed','[资料 & More](https://example.test)','[资料 &amp; Other](https://example.test)'],
 ['code escapes','`{value}`','`\\{value\\}`'],
 ['code entities','`&`','`&amp;`'],
 ['fenced code whitespace','```text\nx \n```','```text\nx\n```'],
 ['fenced code empty marker','```text\n<empty-block/>\n```','```text\n\n```'],
 ['indented code empty marker','    <p />','    '],
 ['inline code empty marker','`<p />`','` `'],
 ['raw HTML empty marker','<pre><empty-block/></pre>','<pre></pre>'],
 ['link empty marker','[资料](https://example.test/<p/>)','[资料](https://example.test/)'],
 ['inline empty marker','第一段<empty-block/>第二段','第一段\n\n第二段'],
 ['escaped empty marker','第一段\n\\<empty-block/>\n第二段','第一段\n\n第二段'],
 ['attributed empty marker','第一段\n<p color="red" />\n第二段','第一段\n\n第二段'],
 ['attributed v1 marker','第一段\n<empty-block color="red"/>\n第二段','第一段\n\n第二段'],
 ['heading level','## 标题 {甲}','### 标题 \\{甲\\}'],
 ['list order','1. 甲\n2. 乙','1. 乙\n2. 甲'],
 ['list check state','- [ ] {甲}','- [x] \\{甲\\}'],
 ['table cell value','|项目|金额|\n|---|---|\n|甲|3000|','|项目|金额|\n|---|---|\n|甲|3001|'],
 ['table structure','|项目|金额|\n|---|---|\n|甲|3000|','项目 金额\n\n甲 3000'],
 ['quote structure','> {甲}','\\{甲\\}'],
 ['paragraph boundary','第一段\n\n第二段','第一段\n第二段'],
 ['visible unknown entity','&notAnEntity;','notAnEntity'],
 ['nonbreaking space','甲&nbsp;乙','甲 乙'],
 ['unknown escape','甲\\z乙','甲z乙'],
 ['HTML structure','<span>甲</span>','甲'],
 ['underline style','<u>甲</u>','甲'],
 ['strikethrough style','<s>甲</s>','甲'],
 ['styled code target','**正文 `one_qa`**','<b>正文 <code>one_qb</code></b>'],
 ['styled link target','**[资料](https://example.test/a)**','<b>[资料](https://example.test/b)</b>'],
 ['nested style missing','***甲***','<b>甲</b>'],
 ['nested style range','***甲***乙','<b>甲<i>乙</i></b>'],
 ['mismatched style tags','***甲***','<i><b>甲</i></b>'],
 ['unclosed style tag','**甲**','<b>甲'],
 ['attributed style tag','**甲**','<b color="red">甲</b>'],
 ['escaped style tag','**甲**','\\<b>甲</b>'],
 ['Unicode punctuation','甲，乙','甲,乙'],
];

for(const [label,original,changed] of distinctFormats)test(`v10 common format matrix retains ${label}`,()=>{
 assert.notEqual(digest(original),digest(changed));
});

test('v2 through v9 stored digest semantics remain stable after v10',()=>{
 const samples=[
  '普通 {价格} [标签] $3000 a|b a~b a^b。',
  '普通 \\{价格\\} \\[标签\\] \\$3000 a\\|b a\\~b a\\^b。',
  'A &amp; B &#123; &#x7D;',
  '<b>标题</b>与 `one_qa`',
  '正文\n<empty-block/>\n下一段',
  '正文\n<p />\n下一段',
  '[资料](https://example.test/a_b?q=1&amp;x=2)',
  '```text\n{literal} &amp;\n```',
 ];
 const versions:NotionCanonicalVersion[]=[2,3,4,5,6,7,8,9];
 const rows=samples.flatMap(sample=>versions.map(version=>canonicalNotionDigest(sample,version)));
 assert.equal(rows.length,64);
 assert.equal(notionHash(JSON.stringify(rows)),'e9c460b776444fadea72c6312de8ab2c23eb57d3b0a2c6dbb6fb138b2caaddc7');
});

const acceptedQaSource='一个假设小组把工作拆成准备、执行和验收，每一步留下可以回读的成果。\n\n原样标记 {紫色_42}，金额 3200 元。\n\n**保留代码 `KEEP_紫色42`**，以及 **[格式说明](https://developers.notion.com/guides/data-apis/enhanced-markdown)**。\n\n| 阶段 | 结果 |\n| --- | --- |\n| 写稿 | 完整正文 |\n| 保存 | 同一稿件 |\n\n自然结尾 END_青色42。';
const acceptedQaReadback='一个假设小组把工作拆成准备、执行和验收，每一步留下可以回读的成果。\n\n原样标记 \\{紫色\\_42\\}，金额 3200 元。\n\n<b>保留代码 </b><b><code>KEEP_紫色42</code></b>，以及 [<b>格式说明</b>](https://developers.notion.com/guides/data-apis/enhanced-markdown)。\n\n| 阶段 | 结果 |\n| --- | --- |\n| 写稿 | 完整正文 |\n| 保存 | 同一稿件 |\n\n自然结尾 END\\_青色42。';
const latestDigest=(body:string)=>canonicalNotionDigest(body,11);

test('v11 verifies the recorded synthetic Notion rich-text split and link-label style placement',()=>{
 assert.equal(latestDigest(acceptedQaSource),latestDigest(acceptedQaReadback));
 // This v10 receipt already exists. Its comparison meaning remains exact.
 assert.equal(canonicalNotionDigest(acceptedQaSource,10),'411198a215fbfd922dc53457f0bb993d027862616ca76732b4d5baec92a4cec9');
 assert.equal(canonicalNotionDigest(acceptedQaReadback,10),'2a5ddc6ae1aef8a9b334cf9042109bee649c986985601bf28a7742e7087c2d2a');
 for(const changed of [
  acceptedQaReadback.replace('3200','3201'),
  acceptedQaReadback.replace('KEEP_紫色42','KEEP_紫色43'),
  acceptedQaReadback.replace('/enhanced-markdown','/another-document'),
  acceptedQaReadback.replace('<b><code>KEEP_紫色42</code></b>','<code>KEEP_紫色42</code>'),
  acceptedQaReadback.replace('[<b>格式说明</b>]','[<b>格式</b>说明]'),
  acceptedQaReadback.replace('| 写稿 | 完整正文 |','| 写稿 | 部分正文 |'),
  acceptedQaReadback.replace('END\\_青色42','END\\_青色43'),
 ])assert.notEqual(latestDigest(acceptedQaSource),latestDigest(changed));
});

function stylePermutations(prefix:string[]=[],remaining=['b','i','s','u']):string[][]{
 return remaining.flatMap((style,index)=>{
  const current=[...prefix,style],rest=remaining.filter((_item,at)=>at!==index);
  return [current,...stylePermutations(current,rest)];
 });
}
const wrapStyles=(body:string,styles:readonly string[])=>styles.reduceRight((content,style)=>`<${style}>${content}</${style}>`,body);

test('v11 style coverage matrix preserves 320 independent rich-text split and link-boundary presentations',()=>{
 const styles=stylePermutations();assert.equal(styles.length,64);
 let checks=0;
 for(const selected of styles){
  const reverse=[...selected].reverse(),target='https://example.test/a_b?x=1&y=2';
  const pairs:[string,string][]=[
   [wrapStyles('前段 {甲} 与 后段 [乙]',selected),wrapStyles('前段 \\{甲\\} 与 ',selected)+wrapStyles('后段 \\[乙\\]',reverse)],
   [wrapStyles('保留代码 `KEEP_42`',selected),wrapStyles('保留代码 ',selected)+wrapStyles('<code>KEEP_42</code>',reverse)],
   [wrapStyles(`[资料 {甲}](${target})`,selected),`[${wrapStyles('资料 \\{甲\\}',reverse)}](${target})`],
   [wrapStyles(`[资料 \`KEEP_42\`](${target})`,selected),`[${wrapStyles('资料 ',selected)}${wrapStyles('<code>KEEP_42</code>',reverse)}](${target})`],
   [wrapStyles('前段 '+wrapStyles('后段 {甲}',['u']),selected),wrapStyles('前段 ',selected)+wrapStyles('后段 \\{甲\\}',[...reverse,'u'])],
  ];
  for(const [source,serialized] of pairs){assert.equal(latestDigest(source),latestDigest(serialized),JSON.stringify({selected,source,serialized}));checks++;}
 }
 assert.equal(checks,320);
});

test('v11 style coverage matrix retains changed code, link targets, numbers and partial ranges',()=>{
 let checks=0;
 for(const selected of stylePermutations()){
  const target='https://example.test/a_b?x=1&y=2';
  const pairs:[string,string][]=[
   [wrapStyles('保留代码 `KEEP_42`',selected),wrapStyles('保留代码 ',selected)+wrapStyles('<code>KEEP_43</code>',selected)],
   [wrapStyles(`[资料](${target})`,selected),`[${wrapStyles('资料',selected)}](https://example.test/a_b?x=1&y=3)`],
   [wrapStyles('金额 3200 元。',selected),wrapStyles('金额 3201 元。',selected)],
   [wrapStyles('前段 `KEEP_42`',selected),wrapStyles('前段 ',selected)+wrapStyles('<code>KEEP_42</code>',selected.slice(1))],
   [wrapStyles(`[资料](${target})`,selected),`[${wrapStyles('资',selected)}${wrapStyles('料',selected.slice(1))}](${target})`],
  ];
  for(const [source,changed] of pairs){assert.notEqual(latestDigest(source),latestDigest(changed),JSON.stringify({selected,source,changed}));checks++;}
 }
 assert.equal(checks,320);
});

test('v11 nested link-label code proof keeps exact bytes, tag closure and code style coverage',()=>{
 const target='https://example.test/a_b';
 const source=`**[资料 \`KEEP_42\`](${target})**`;
 const serialized=`[<b>资料 </b><b><code>KEEP_42</code></b>](${target})`;
 assert.equal(latestDigest(source),latestDigest(serialized));
 for(const changed of [
  serialized.replace('KEEP_42','KEEP_43'),
  serialized.replace('KEEP_42','KEEP\\_42'),
  serialized.replace('KEEP_42','KEEP&#95;42'),
  serialized.replace('<code>','<code class="x">'),
  serialized.replace('KEEP_42','KEEP_\n42'),
  serialized.replace('<b><code>KEEP_42</code></b>','<code>KEEP_42</code>'),
  serialized.replace('</code></b>','</b></code>'),
  serialized.replace('KEEP_42</code>','KEEP_42</code>tail</code>'),
 ])assert.notEqual(latestDigest(source),latestDigest(changed),changed);
 const fakeClosingSource=`**[资料 \`KEEP_42</code>tail\`](${target})**`;
 assert.notEqual(latestDigest(fakeClosingSource),latestDigest(serialized.replace('KEEP_42</code>','KEEP_42</code>tail</code>')));
});

test('v11 retains the prior common-format and conservative structure matrix',()=>{
 for(const [label,source,serialized] of equivalentFormats)assert.equal(latestDigest(source),latestDigest(serialized),label);
 for(const [label,source,changed] of distinctFormats)assert.notEqual(latestDigest(source),latestDigest(changed),label);
});

test('v2 through v10 persisted digest meanings remain unchanged after leaf-style coverage',()=>{
 const samples=[
  '普通 {价格} [标签] $3000 a|b a~b a^b。',
  '普通 \\{价格\\} \\[标签\\] \\$3000 a\\|b a\\~b a\\^b。',
  'A &amp; B &#123; &#x7D;',
  '<b>标题</b>与 `one_qa`',
  '正文\n<empty-block/>\n下一段',
  '正文\n<p />\n下一段',
  '[资料](https://example.test/a_b?q=1&amp;x=2)',
  '```text\n{literal} &amp;\n```',
 ];
 const versions:NotionCanonicalVersion[]=[2,3,4,5,6,7,8,9,10];
 const rows=samples.flatMap(sample=>versions.map(version=>canonicalNotionDigest(sample,version)));
 assert.equal(rows.length,72);
 assert.equal(notionHash(JSON.stringify(rows)),'7a64f465293f8106234c649af8fb1f6df2a9a4a7aa25081b62f6f6decab0ce76');
});

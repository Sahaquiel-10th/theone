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

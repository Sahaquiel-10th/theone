import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalNotionDigest,legacyNotionNormalized,notionHash} from './notionCanonical.js';
test('only proven bold, blockquote and typed table separator formatting is equivalent',()=>{
 const expected='# 项目\n**名称**\n\n> 第一段\n>\n> 第二段\n\n|人|事|物|\n|---|---|---|\n|甲|乙|丙|';
 const actual='# 项目\n<b>名称</b>\n<quote>\n第一段\n\n第二段\n</quote>\n|人|事|物|\n| --- | --- | --- |\n|甲|乙|丙|';
 assert.notEqual(notionHash(legacyNotionNormalized(expected)),notionHash(legacyNotionNormalized(actual)));
 assert.equal(canonicalNotionDigest(expected),canonicalNotionDigest(actual));
 for(const changed of [actual.replace('第二段','别的段'),actual.replace('|甲|乙|丙|','|乙|甲|丙|'),actual.replace('<b>','<b class="x">'),actual.replace('</b>',''),actual.replace('<quote>','<quote color="red">')])assert.notEqual(canonicalNotionDigest(expected),canonicalNotionDigest(changed));
});
test('literal code, links, list order, cells and unknown markup are never stripped',()=>{
 for(const [a,b] of [
  ['`<b>x</b>`','`**x**`'],['```html\n<b>x</b>\n```','```html\n**x**\n```'],
  ['    <b>x</b>','    **x**'],['[a](https://a.example)','[a](https://b.example)'],
  ['1. 甲\n2. 乙','1. 乙\n2. 甲'],['|甲 |乙|','|甲|乙|'],
  ['<span>x</span>','x'],['\\<b>x</b>','**x**'],['<quote>\n> x\n</quote>','> x'],
  ['|---|---|','| --- | --- |'],
  ['|a|b|\n|---|---|\n|x|y|','|a|b|\n| --- | --- | --- |\n|x|y|'],
  ['> |a|b|\n> |---|---|\n> |x|y|','> |a|b|\n> | --- | --- |\n> |x|y|'],
  ['```\nx \n\n```','```\nx\n```'],
 ])assert.notEqual(canonicalNotionDigest(a),canonicalNotionDigest(b),a);
});
test('v4 treats only typed delimiter alignment as presentation and retains older versions',()=>{
 const table=(delimiter:string)=>`|项目|费用|备注|\n${delimiter}\n|场地：A|-100|+200:结余|`;
 const plain=table('| --- | --- | --- |');
 for(const delimiter of ['|:---|---:|:---:|','|---:|:----|:------:|','|---|---|---:|']){
  const expected=table(delimiter);
  assert.equal(canonicalNotionDigest(expected,4),canonicalNotionDigest(plain,4));
  assert.notEqual(canonicalNotionDigest(expected,2),canonicalNotionDigest(plain,2));
  assert.notEqual(canonicalNotionDigest(expected,3),canonicalNotionDigest(plain,3));
 }
 for(const changed of [
  plain.replace('场地：A','场地A'),plain.replace('-100','100'),plain.replace('+200:结余','+200结余'),
  plain.replace('|项目|费用|备注|','|费用|项目|备注|'),plain.replace('| --- | --- | --- |','| --- | --- |'),
  plain.replace('| --- | --- | --- |','| --: | --- | --- |'),
  plain+'\n|---:|:----|:-----:|',
 ])assert.notEqual(canonicalNotionDigest(plain,4),canonicalNotionDigest(changed,4));
 assert.notEqual(canonicalNotionDigest('|---:|:---|',4),canonicalNotionDigest('|---|---|',4));
 assert.notEqual(canonicalNotionDigest('```\n'+table('|---:|:---|:---:|')+'\n```',4),canonicalNotionDigest('```\n'+plain+'\n```',4));
 assert.notEqual(canonicalNotionDigest(table('|---|---|---|')+'\n|---:|:---|:---:|',4),canonicalNotionDigest(table('|---|---|---|')+'\n|---|---|---|',4));
});
test('v3 canonicalizes only typed table delimiter hyphen lengths while preserving v2 digests',()=>{
 const table=(delimiter:string)=>`|项目|费用|备注|\n${delimiter}\n|场地|100|不变|`;
 const expected=table('|---|----|------|'),actual=table('| --- | --- | --- |');
 assert.notEqual(canonicalNotionDigest(expected,2),canonicalNotionDigest(actual,2));
 assert.equal(canonicalNotionDigest(expected,3),canonicalNotionDigest(actual,3));
 for(const [left,right] of [
  ['|:----|----:|:------:|','| :--- | ---: | :---: |'],
  ['|------|---|----|','|---|------|---|'],
 ])assert.equal(canonicalNotionDigest(table(left),3),canonicalNotionDigest(table(right),3));
 for(const changed of ['|---|---:|:---:|','|:---|---|:---:|','|:---|---:|---|'])
  assert.notEqual(canonicalNotionDigest(table('|:----|----:|:------:|'),3),canonicalNotionDigest(table(changed),3));
 assert.notEqual(canonicalNotionDigest(table('|---|---|---|')+'\n|----|----|----|',3),canonicalNotionDigest(table('|---|---|---|')+'\n|---|---|---|',3));
 assert.notEqual(canonicalNotionDigest('|----|----|',3),canonicalNotionDigest('|---|---|',3));
 assert.notEqual(canonicalNotionDigest('|a|b|\n\n|----|----|\n|x|y|',3),canonicalNotionDigest('|a|b|\n\n|---|---|\n|x|y|',3));
});

test('v5 recognizes only proven attribute-free plain italic serialization and preserves v2-v4 meaning',()=>{
 const expected='# 专栏\n\n**保留加粗**\n\n*这篇文章保留最初的主题，不换成其他素材。*';
 const actual='# 专栏\n<b>保留加粗</b>\n<i>这篇文章保留最初的主题，不换成其他素材。</i>';
 assert.equal(canonicalNotionDigest(expected,5),canonicalNotionDigest(actual,5));
 for(const version of [2,3,4] as const)assert.notEqual(canonicalNotionDigest(expected,version),canonicalNotionDigest(actual,version));
 assert.equal(canonicalNotionDigest(expected),canonicalNotionDigest(actual,5));
 for(const changed of [actual.replace('最初','别的'),actual.replace('<i>','<i class="x">'),actual.replace('</i>',''),actual.replace('<i>','<em>').replace('</i>','</em>')])assert.notEqual(canonicalNotionDigest(expected,5),canonicalNotionDigest(changed,5));
 const table='|项目|费用|\n|:----|-----:|\n|场地|100|';
 assert.equal(canonicalNotionDigest(table,5),canonicalNotionDigest(table,4),'v5 retains v4 table alignment meaning');
});

test('v5 italic keeps code, literal escapes, edge whitespace and nested Markdown or HTML conservative',()=>{
 for(const [expected,actual] of [
  ['`*文字*`','`<i>文字</i>`'],['```\n*文字*\n```','```\n<i>文字</i>\n```'],
  ['    *文字*','    <i>文字</i>'],['\\<i>文字</i>','*文字*'],
  ['* 文字*','<i> 文字</i>'],['*文字 *','<i>文字 </i>'],['*第一行\n第二行*','<i>第一行\n第二行</i>'],
  ['***文字***','<i><b>文字</b></i>'],['***文字***','<i>**文字**</i>'],
  ['*a_b*','<i>a_b</i>'],['*[文字](https://a.example)*','<i>[文字](https://a.example)</i>'],
  ['*a\\b*','<i>a\\b</i>'],['*a~b*','<i>a~b</i>'],['*文字*','<strong>文字</strong>'],
 ])assert.notEqual(canonicalNotionDigest(expected,5),canonicalNotionDigest(actual,5),actual);
 assert.notEqual(canonicalNotionDigest('<i>文字</i>',4),canonicalNotionDigest('*文字*',5),'an old literal-tag digest is not proof for a new Markdown body');
});

test('v6 protects exact code segments while proven rich formatting elsewhere remains comparable',()=>{
 const expected='# 专栏\n\n**重点**与 `ONE` 同在一篇。\n\n> 第一段\n>\n> 第二段\n\n|项目|费用|\n|:----|-----:|\n|场地|-100|\n\n\\*\\*可见的星号\\*\\*\n[资料\\_名称](https://example.test/source_a)';
 const actual='# 专栏\n<b>重点</b>与 `ONE` 同在一篇。\n<quote>\n第一段\n\n第二段\n</quote>\n|项目|费用|\n| --- | --- |\n|场地|-100|\n\n\\*\\*可见的星号\\*\\*\n[资料\\_名称](https://example.test/source_a)';
 assert.equal(canonicalNotionDigest(expected,6),canonicalNotionDigest(actual,6));
 assert.notEqual(canonicalNotionDigest(expected,5),canonicalNotionDigest(actual,5),'persisted v5 meaning stays opaque');
 for(const literal of ['```html\n<b>原样</b>\n\n```\n','~~~text\n|原文|不变|\n~~~\n','    <b>原样</b>\n    第二行\n','<pre><b>原样</b></pre>\n','``a ` b``']){
  assert.equal(canonicalNotionDigest(literal+'\n**重点**',6),canonicalNotionDigest(literal+'\n<b>重点</b>',6),literal);
  assert.notEqual(canonicalNotionDigest(literal+'\n**重点**',6),canonicalNotionDigest(literal.replace('原样','变化').replace('原文','变化').replace('a ` b','a ` c')+'\n<b>重点</b>',6),literal);
 }
 for(const changed of [actual.replace('`ONE`','`TWO`'),actual.replace('|场地|-100|','|场地|100|'),actual.replace('第二段','别的段'),actual.replace('source_a','source_b'),actual.replace('可见的星号','别的文字')])assert.notEqual(canonicalNotionDigest(expected,6),canonicalNotionDigest(changed,6));
});

test('v6 never erases visible escaped Markdown or confuses it with real emphasis',()=>{
 for(const [expected,actual] of [
  ['\\*\\*可见星号\\*\\*','**可见星号**'],['\\*\\*可见星号\\*\\*','<b>可见星号</b>'],
  ['\\*可见星号\\*','<i>可见星号</i>'],['**真正加粗**','\\*\\*真正加粗\\*\\*'],
  ['[source_a](https://example.test)','[source_b](https://example.test)'],
  ['`<b>代码</b>`\n**加粗**','`**代码**`\n<b>加粗</b>'],
  ['```\nx \n\n```\n**加粗**','```\nx\n```\n<b>加粗</b>'],
  ['未闭合 `代码\n**加粗**','未闭合 `代码\n<b>加粗</b>'],
  ['***嵌套格式***','<i><b>嵌套格式</b></i>'],
 ])assert.notEqual(canonicalNotionDigest(expected,6),canonicalNotionDigest(actual,6),actual);
});

test('v6 never canonicalizes Markdown link targets, bare URLs or unknown HTML attributes',()=>{
 for(const [expected,actual] of [
  ['[资料](https://example.test/<b>x</b>)','[资料](https://example.test/**x**)'],
  ['[资料](../<i>x</i>)','[资料](../*x*)'],
  ['[资料](https://example.test/a_(<b>x</b>))','[资料](https://example.test/a_(**x**))'],
  ['https://example.test/<b>x</b>','https://example.test/**x**'],
  ['[资料]: https://example.test/<b>x</b>','[资料]: https://example.test/**x**'],
  ['<span data-value="<b>x</b>">正文</span>','<span data-value="**x**">正文</span>'],
  ['<input\n data-value="<b>x</b>">','<input\n data-value="**x**">'],
  ['<!-- <b>x</b> -->','<!-- **x** -->'],
 ])assert.notEqual(canonicalNotionDigest('引用 `ONE`\n'+expected,6),canonicalNotionDigest('引用 `ONE`\n'+actual,6),actual);
 assert.equal(canonicalNotionDigest('`ONE`\n**重点**\n[原标签](https://example.test/raw_a)',6),canonicalNotionDigest('`ONE`\n<b>重点</b>\n[原标签](https://example.test/raw_a)',6));
});

test('v6 compares CommonMark literal punctuation without erasing visible stars or changing active markup',()=>{
 const source='动作。**“碰”是一个需要被教的动作，“把手机放在某个地方”是一个已经存在的动作。**笔记里';
 const actual='动作。\\*\\*“碰”是一个需要被教的动作，“把手机放在某个地方”是一个已经存在的动作。\\*\\*笔记里';
 assert.equal(canonicalNotionDigest(source,6),canonicalNotionDigest(actual,6),'the quoted punctuation prevents a strong closing delimiter; both contain visible stars');
 assert.notEqual(canonicalNotionDigest(source,5),canonicalNotionDigest(actual,5),'old digests keep their old meaning');
 assert.equal(canonicalNotionDigest('**真正粗体**\n'+source+'\n[资料_name](https://example.test/source_a)',6),canonicalNotionDigest('<b>真正粗体</b>\n'+actual+'\n[资料\\_name](https://example.test/source_a)',6));
 for(const [left,right] of [
  ['**真正粗体**','\\*\\*真正粗体\\*\\*'],['*真正斜体*','\\*真正斜体\\*'],
  [source,actual.replace('\\*\\*','')],['[资料](https://example.test/a_b)','[资料](https://example.test/a\\_b)'],
  ['[_强调_](https://example.test)','[\\_强调\\_](https://example.test)'],
  ['动作。<b>“句子。”</b>笔记','动作。\\*\\*“句子。”\\*\\*笔记'],
  ['动作。<i>“句子。”</i>笔记','动作。\\*“句子。”\\*笔记'],
  ['`a\\_b`','`a_b`'],['- 第一项\n- 第二项','- 第二项\n- 第一项'],['&amp;','&'],
  ['**第一段\n\n第二段**','**第一段\n第二段**'],
  ['|项目|费用|\n|---|---|\n|场地|100|\n\n普通段落','|项目|费用|\n|---|---|\n|场地|100|\n普通段落'],
 ])assert.notEqual(canonicalNotionDigest(left,6),canonicalNotionDigest(right,6),right);
});

test('v6 recognizes exact GFM bare URL serialization as an explicit same-label link without changing URL bytes',()=>{
 const source='- 官方资料：https://example.test/reference/source_a?view=1\n- 第二份：https://example.test/a_(b)';
 const actual='- 官方资料：[https://example.test/reference/source_a?view=1](https://example.test/reference/source_a?view=1)\n- 第二份：[https://example.test/a_(b)](https://example.test/a_(b))';
 assert.equal(canonicalNotionDigest(source,6),canonicalNotionDigest(actual,6));
 assert.notEqual(canonicalNotionDigest(source,5),canonicalNotionDigest(actual,5),'old receipts keep their own target syntax');
 for(const changed of [
  actual.replace('](https://example.test/reference/source_a?view=1)','](https://example.test/reference/source_b?view=1)'),
  actual.replace('[https://example.test/reference/source_a?view=1]','[不同标签]'),
  actual.replace('](https://example.test/reference/source_a?view=1)','](https://example.test/reference/source\\_a?view=1)'),
  actual.replace('](https://example.test/reference/source_a?view=1)','](https://example.test/reference/source_a?view=1 "新增标题")'),
 ])assert.notEqual(canonicalNotionDigest(source,6),canonicalNotionDigest(changed,6),changed);
 assert.notEqual(canonicalNotionDigest('https://example.test/<b>x</b>',6),canonicalNotionDigest('[https://example.test/**x**](https://example.test/**x**)',6),'URL markup bytes are never interpreted as presentation');
});

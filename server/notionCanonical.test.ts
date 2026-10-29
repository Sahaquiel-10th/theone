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

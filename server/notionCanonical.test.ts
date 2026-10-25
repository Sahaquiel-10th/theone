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
  ['|---|---|','| --- | --- |'],['|a|b|\n|:---|---|\n|x|y|','|a|b|\n|---:|---|\n|x|y|'],
  ['|a|b|\n|---|---|\n|x|y|','|a|b|\n| --- | --- | --- |\n|x|y|'],
  ['> |a|b|\n> |---|---|\n> |x|y|','> |a|b|\n> | --- | --- |\n> |x|y|'],
  ['```\nx \n\n```','```\nx\n```'],
 ])assert.notEqual(canonicalNotionDigest(a),canonicalNotionDigest(b),a);
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

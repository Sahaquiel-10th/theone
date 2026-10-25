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

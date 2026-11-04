import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { extractCommerceKeywordRows, parseCommerceKeywordFile, readCommerceLibrary, saveCommerceProduct, saveCommerceTemplate, commerceLibraryUsesAttachment } from './commerceMaterials.js';
import { commerceFixture, commerceOwner as owner, commercePeer as peer, commerceOther as other } from './commerce.fixture.js';
import { COMMERCE_MAIN_AGENT_ID } from './commerce.js';
import { defaultComposition } from './commerceComposition.js';

test('keyword CSV preserves real heat, deduplicates rows, and ignores unrelated numeric metrics',()=>{
  const parsed=parseCommerceKeywordFile(Buffer.from('报表日期,2026-10-01\n关键词,搜索人气,点击率\n身体乳,100~200,10%\n润肤乳,88,9%\n身体乳,100~200,11%\n合计,288,10%\n'),'report.csv');
  assert.deepEqual(parsed.keywords,[{text:'身体乳',source:'report',heat:'100~200'},{text:'润肤乳',source:'report',heat:'88'}]);
  assert.match(parsed.note,/搜索热度列/);
});
test('keyword XLSX accepts shifted headings and caps imported rows without inventing heat',()=>{
  const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['搜索词报表'],['关键词','','点击率'],['','搜索人气',''],['保湿身体乳','200','10%'],['250','300','20%']]),'运营词表');
  const parsed=parseCommerceKeywordFile(XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}),'运营词表.xlsx');assert.deepEqual(parsed.keywords,[{text:'保湿身体乳',source:'report',heat:'200'}]);
  assert.throws(()=>extractCommerceKeywordRows([{name:'numbers',rows:[['搜索人气','点击率'],[123,'10%']]}]),/没有识别到关键词列/);
  assert.throws(()=>parseCommerceKeywordFile(Buffer.alloc(10*1024*1024+1),'large.csv'),/10MB/);
});
test('saved materials and templates isolate workspace and owner and preserve only reusable product facts',async()=>{
  const f=commerceFixture(),db=await f.store.read(),brief={...f.brief,detailImageIds:['detail'],detailText:'已确认250g',offer:'本次活动满100减50',composition:defaultComposition(f.brief)};
  const product=saveCommerceProduct(db,owner,{agentId:COMMERCE_MAIN_AGENT_ID,name:'身体乳资料',brief});
  const template=saveCommerceTemplate(db,owner,{agentId:COMMERCE_MAIN_AGENT_ID,name:'固定模板',composition:defaultComposition(f.brief),referenceImageIds:['ref-a']});
  assert.equal(product.brief.offer,'');assert.equal(product.brief.composition,undefined);assert.equal(product.brief.detailText,'已确认250g');
  assert.equal(commerceLibraryUsesAttachment(db,'detail'),true);assert.equal(commerceLibraryUsesAttachment(db,'ref-a'),true);
  for(const actor of [peer,other]){assert.equal(readCommerceLibrary(db,actor).products.length,0);assert.equal(readCommerceLibrary(db,actor).templates.length,0);assert.throws(()=>saveCommerceProduct(db,actor,{id:product.id,brief}));assert.throws(()=>saveCommerceTemplate(db,actor,{id:template.id,name:'篡改',composition:defaultComposition(f.brief),referenceImageIds:['ref-a']}));}
  const publicLibrary=JSON.stringify(readCommerceLibrary(db,owner));assert.doesNotMatch(publicLibrary,/workspaceId|userId/);
  db.attachments.find(a=>a.id==='product')!.status='failed';assert.equal(readCommerceLibrary(db,owner).products.length,0);assert.throws(()=>saveCommerceProduct(db,owner,{brief}));
});

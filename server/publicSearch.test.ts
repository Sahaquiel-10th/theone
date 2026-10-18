import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPublicSearch,safePublicUrl,reviewedPublicQuery,publicSearchOutcome,explicitlyNeedsPublicSearch} from './publicSearch.js';
test('public search blocks credentials and verbatim private paragraphs and reports unavailable separately from no match',async()=>{
  assert.throws(()=>reviewedPublicQuery('api_key: sk-test-test-test'),/私人/);
  assert.throws(()=>reviewedPublicQuery('联系 test@example.com'),/私人/);
  const privateText='这是一段不应发到公网的私人会议记录，包含项目的完整讨论与决定。';assert.throws(()=>reviewedPublicQuery(privateText,[privateText]),/个人资料/);
  assert.equal(reviewedPublicQuery('公开新闻'), '公开新闻');
  assert.equal((await publicSearchOutcome(async()=>[], '公开新闻')).status,'no_match');
  assert.equal((await publicSearchOutcome(async()=>({status:'unavailable'}),'公开新闻')).status,'unavailable');
  assert.equal((await publicSearchOutcome(async()=>{throw Error('secret');},'公开新闻')).status,'failed');
  assert.equal(explicitlyNeedsPublicSearch('先讨论如何做最新新闻搜索功能'),false);
});
test('search uses a fixed HTTPS upstream, bounded public references and real page text, never provider errors',async()=>{
  let calls=0;
  const search=createPublicSearch({enabled:()=>true,apiKey:()=> 'TEST_SECRET',sleep:async()=>{},fetch:async(url,init)=>{
    calls++;assert.equal(url,'https://api.tavily.com/search');assert.equal(init?.redirect,'error');assert.equal(JSON.parse(init!.body as string).include_raw_content,'text');
    if(calls===1)return new Response('TEST_SECRET',{status:503});
    return Response.json({results:[{title:'来源',url:'https://example.com/page',content:'摘要',raw_content:'正文'},{title:'bad',url:'javascript:alert(1)',content:'bad'}]});
  }});
  const found=await search('公开测试');assert.equal(calls,2);assert.equal(found.length,1);assert.match(found[0].snippet,/正文/);assert.doesNotMatch(JSON.stringify(found),/TEST_SECRET/);
  assert.equal(safePublicUrl('https://name:password@example.com'), '');
});
test('search retries only bounded reads and exposes a safe failure, including missing credentials and oversized responses',async()=>{
  let calls=0;const search=createPublicSearch({enabled:()=>true,apiKey:()=> 'TEST_SECRET',sleep:async()=>{},fetch:async()=>{calls++;throw Error('private upstream TEST_SECRET');}});
  await assert.rejects(search('天气'),e=>e instanceof Error&&/重试后仍没查成/.test(e.message)&&!e.message.includes('TEST_SECRET'));assert.equal(calls,2);
  const off=createPublicSearch({enabled:()=>false,apiKey:()=>undefined,fetch:async()=>{throw Error('must not fetch');}});await assert.rejects(off('test'),/没有查询公开网页/);
  const huge=createPublicSearch({enabled:()=>true,apiKey:()=> 'x',sleep:async()=>{},fetch:async()=>new Response('x',{headers:{'content-length':'99999999'}})});await assert.rejects(huge('test'),/没查成/);
});

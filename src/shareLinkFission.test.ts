import test from 'node:test';
import assert from 'node:assert/strict';
import {publicationShareUrl,publishWithReceipt,shareLinkFissionFrame,SHARE_LINK_FISSION_MS} from './shareLinkFission';

test('a real server slug is kept on ONE and encoded as one path segment',()=>{
  assert.equal(publicationShareUrl('https://one.example','published-123'),'https://one.example/s/published-123');
  assert.equal(publicationShareUrl('https://one.example','https://other.example/a?b'),'https://one.example/s/https%3A%2F%2Fother.example%2Fa%3Fb');
  assert.throws(()=>publicationShareUrl('https://one.example',' '),/尚未返回分享链接/);
});
test('a confirmed publication survives a subsequent refresh failure without another POST',async()=>{
  const events:string[]=[];let posts=0;
  const result=await publishWithReceipt({publish:async()=>{posts++;events.push('published');return {slug:'real-slug'};},onConfirmed:response=>events.push(`receipt:${response.slug}`),refresh:async()=>{events.push('refresh');throw new Error('offline');}});
  assert.equal(posts,1);assert.deepEqual(events,['published','receipt:real-slug','refresh']);assert.equal(result.response.slug,'real-slug');assert.match(String(result.refreshError),/offline/);
});
test('a failed publish never presents a share receipt or refreshes as though it succeeded',async()=>{
  let receipts=0,refreshes=0;
  await assert.rejects(()=>publishWithReceipt({publish:async()=>{throw new Error('permission denied');},onConfirmed:()=>{receipts++;},refresh:async()=>{refreshes++;}}),/permission denied/);
  assert.equal(receipts,0);assert.equal(refreshes,0);
});
test('a link body keeps its final dimensions; only the neck and bounded translation move',()=>{
  assert.equal(SHARE_LINK_FISSION_MS,1080);
  const start=shareLinkFissionFrame(0),middle=shareLinkFissionFrame(.5),end=shareLinkFissionFrame(1);
  assert.equal(start.offset,-42);assert.ok(start.neck.length>0);assert.ok(middle.neck.length>0);assert.equal(end.neck,'');assert.equal(end.offset,0);
  let previous=start.offset;
  for(let i=0;i<=760;i++) {const frame=shareLinkFissionFrame(i/1000);assert.ok(frame.offset>=previous-.001);assert.ok(!/NaN|Infinity/.test(frame.neck));previous=frame.offset;}
  for(let i=760;i<=1000;i++) {const frame=shareLinkFissionFrame(i/1000);assert.ok(frame.offset>=0&&frame.offset<=2.3);assert.ok(!/NaN|Infinity/.test(frame.neck));}
  assert.deepEqual(shareLinkFissionFrame(Number.NaN),end);
  assert.deepEqual(shareLinkFissionFrame(5),end);
});

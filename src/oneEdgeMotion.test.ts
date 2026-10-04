import test from 'node:test';
import assert from 'node:assert/strict';
import {edgeJourney,directJourney,eyeRoute,overheadJourney,eyeDistance,resolveEyeRoute,isConversationShelfMove} from './oneEdgeMotion';
test('adjacent conversation shelf stays direct, but home and settings retain their routes',()=>{
 assert.equal(isConversationShelfMove('chat','features',false),true);
 assert.equal(isConversationShelfMove('features','chat',false),true);
 assert.equal(isConversationShelfMove('chat','features',true),false);
 assert.equal(isConversationShelfMove('features','account',false),false);
});
const left={left:90,top:140,width:74,height:74},right={...left,left:1100};
test('cross-screen moves leave the near edge and peek in from the opposite edge',()=>{
 const forward=edgeJourney(left,right,1440)!;
 assert.match(forward.departure[1].transform,/-1174px/);
 assert.match(forward.arrival[0].transform,/340px/);
 assert.equal(forward.arrival.at(-1)?.opacity,1);
 const reverse=edgeJourney(right,left,1440)!;
 assert.match(reverse.arrival[0].transform,/-164px/);
});
test('ordinary paths stay between endpoints, optionally pausing without a detour',()=>{
 for(const pause of [true,false]){
  const frames=directJourney(left,right,pause);
  assert.match(String(frames[0].transform),/90px/);
  assert.match(String(frames.at(-1)?.transform),/1100px/);
  assert.equal(frames.at(-1)?.offset,1);
  assert.equal(frames.length,pause?4:3);
 }
});
test('ordinary nearby moves and mobile layouts retain the short transition',()=>{
 assert.equal(edgeJourney(left,{...left,left:200},1440),null);
 assert.equal(edgeJourney(left,right,390),null);
});
test('fixed page routes cannot fall back to traversing the screen at narrow widths',()=>{
 assert.equal(eyeRoute('features','account'),'edge');
 assert.equal(eyeRoute('account','features'),'edge');
 assert.ok(edgeJourney(left,{...right,left:300},390,true));
 assert.equal(eyeRoute('chat','features',true),'overhead');
 assert.equal(eyeRoute('chat','account',true),'direct');
 assert.equal(eyeRoute('chat','features',false),'direct');
 const upward=overheadJourney(left,right);
 assert.match(upward.departure.at(-1)!.transform,/-214px/);
 assert.match(upward.arrival[0].transform,/-214px/);
 assert.ok(upward.departure.length>2&&upward.arrival.length>3);
});
test('every page pair is bounded by the actual home to settings distance',()=>{
 const pages={home:{left:592,top:108,width:96,height:96},settings:{left:846.56,top:92,width:54,height:54},features:{left:52,top:92,width:54,height:54},workbench:{left:846.56,top:92,width:54,height:54},things:{left:216,top:97,width:42,height:42}};
 const limit=eyeDistance(pages.home,pages.settings);
 for(const a of Object.values(pages))for(const b of Object.values(pages)){
  const route=resolveEyeRoute('direct',a,b,limit,1280);
  if(eyeDistance(a,b)>limit+.5)assert.notEqual(route,'direct');
  else assert.equal(route,'direct');
 }
 assert.equal(resolveEyeRoute('direct',pages.features,pages.workbench,limit,1280),'edge');
 assert.equal(resolveEyeRoute('direct',pages.home,pages.features,limit,1280),'overhead');
 assert.equal(resolveEyeRoute('edge',pages.features,pages.settings,Infinity,1280),'edge');
});

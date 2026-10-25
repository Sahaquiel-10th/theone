import test from 'node:test';
import assert from 'node:assert/strict';
import {featureSelectionTransition,featureHandoffFrame,handoffMaterialNeck} from './featureHandoffMotion';
const source={left:840,top:260,width:112,height:36},target={left:230,top:650,width:880,height:92};
test('feature selection is next-message intent; toggles and a full batch never imply execution',()=>{
 const a={id:'a',name:'研究'},b={id:'b',name:'写作'};
 assert.deepEqual(featureSelectionTransition([],a),{features:[a],action:'added'});
 assert.deepEqual(featureSelectionTransition([a,b],a),{features:[b],action:'removed'});
 const full=Array.from({length:8},(_,id)=>({id:String(id)})),snapshot=JSON.stringify(full);
 assert.deepEqual(featureSelectionTransition(full,{id:'ninth'}),{features:full,action:'limit'});assert.equal(JSON.stringify(full),snapshot);
 assert.equal(featureSelectionTransition([...full,full[0]],{id:'0'}).features.length,7);
});
test('selection feedback is a tiny local drop, independent of the distant composer position',()=>{
 const connected=featureHandoffFrame(source,target,.18),absorbing=featureHandoffFrame(source,target,.60);
 assert.equal(connected.phase,'gathering');assert.match(connected.sourceNeck,/^M .* C /);
 assert.equal(absorbing.phase,'absorbing');assert.equal(absorbing.departed,true);
 assert.ok(connected.bubble.width<=12);assert.ok(absorbing.bubble.width<connected.bubble.width);
 assert.deepEqual(connected,featureHandoffFrame(source,{left:-1000,top:-2000,width:1,height:1},.18));
});
test('local absorption completes and never creates a capsule or travels across the workspace',()=>{
 const done=featureHandoffFrame(source,target,1);
 assert.equal(done.phase,'complete');assert.equal(done.bubbleOpacity,0);assert.equal(done.sourceNeck,'');assert.equal(done.haloOpacity,0);assert.equal(done.arrived,true);
 for(const progress of [-1,0,.12,.26,.5,.76,.9,1,2,NaN]){
  const frame=featureHandoffFrame(source,target,progress);assert.doesNotMatch(JSON.stringify(frame),/NaN|Infinity/);assert.ok(frame.bubble.width<=12);assert.ok(frame.bubbleOpacity>=0&&frame.bubbleOpacity<=1);
  const x=frame.bubble.left+frame.bubble.width/2,y=frame.bubble.top+frame.bubble.height/2;
  assert.ok(Math.hypot(x-frame.origin.x,y-frame.origin.y)<16);assert.ok(frame.haloRadius<=19);
 }
 assert.equal(handoffMaterialNeck(source,source,.5),'');
});
test('eight rapid selections and replacement decoration cannot lose chosen intent',()=>{
 let selected:{id:string}[]=[];for(let index=0;index<8;index++)selected=featureSelectionTransition(selected,{id:String(index)}).features;
 assert.equal(selected.length,8);assert.equal(featureSelectionTransition(selected,{id:'9'}).action,'limit');
 const cancelled=featureSelectionTransition(selected,{id:'3'});assert.equal(cancelled.action,'removed');assert.equal(cancelled.features.length,7);
 const replacement=featureSelectionTransition(cancelled.features,{id:'9'});assert.equal(replacement.features.length,8);assert.equal(replacement.features.some(item=>item.id==='3'),false);
});
test('local +1 is legible briefly, stays by its button and leaves no lingering receipt',()=>{
 const start=featureHandoffFrame(source,target,0),middle=featureHandoffFrame(source,target,.4),end=featureHandoffFrame(source,target,1);
 assert.equal(start.receiptOpacity,0);assert.equal(middle.receiptOpacity,1);assert.equal(end.receiptOpacity,0);
 for(const p of [-1,0,.1,.3,.7,.95,1,2,NaN]){
  const frame=featureHandoffFrame(source,target,p);
  assert.ok(frame.receiptLift>=5&&frame.receiptLift<=17);
  assert.ok(frame.receiptScale>=.84&&frame.receiptScale<=1);
  assert.ok(frame.receiptOpacity>=0&&frame.receiptOpacity<=1);
 }
});

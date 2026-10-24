import test from 'node:test';
import assert from 'node:assert/strict';
import {availableRight, flowTextExtent} from './fluid/contentFlow';
import {getFluidLayout} from './fluid/geometry';
import {fissionOrder} from './fluid/motionOrder';

test('paragraph exclusion reserves whole line boxes instead of a changing glyph-height float',()=>{
  const line=26.6;
  assert.equal(flowTextExtent(20,line),line);
  assert.equal(flowTextExtent(46.6,line),line*2);
  assert.equal(flowTextExtent(73.2,line),line*3);
  // Descenders/font ink can vary without changing the occupied line count.
  assert.equal(flowTextExtent(70,line),flowTextExtent(75,line));
  assert.equal(flowTextExtent(0,line),line);
  assert.equal(flowTextExtent(20,NaN),27);
});

test('upper fission yields only the upper reading region; input and lower region recover full width',()=>{
  const layout=getFluidLayout(1180,776),idle=availableRight(layout,{},100,150);
  assert.ok(idle-availableRight(layout,{activity:1},100,150)>250);
  assert.equal(availableRight(layout,{activity:1},450,490),idle);
  assert.equal(availableRight(layout,{activity:1},650,740),idle);
});

test('lower fission preserves upper reading width and shortens only lower region and input',()=>{
  const layout=getFluidLayout(1180,776),idle=availableRight(layout,{},100,150);
  assert.equal(availableRight(layout,{local:1},100,150),idle);
  assert.ok(idle-availableRight(layout,{local:1},600,730)>250);
  assert.equal(availableRight(layout,{},600,730),idle);
});

test('two open panels make one continuous dock with no tongue of conversation between them',()=>{
  for(const width of [1000,1180,1500]){
    const layout=getFluidLayout(width,876,{paired:true}),phases={activity:1,local:1};
    assert.ok(availableRight(layout,phases,120,180)<width-250);
    assert.ok(availableRight(layout,phases,680,740)<width-250);
    assert.ok(availableRight(layout,phases,400,450)<width-250);
  }
});

test('coincident visual starts prioritize direct attention; a visible bubble is not restarted',()=>{
  assert.deepEqual(fissionOrder({activity:true,local:true},{activity:0,local:0},'local'),['local','activity']);
  assert.deepEqual(fissionOrder({activity:true,local:true},{activity:0,local:0},'activity'),['activity','local']);
  assert.deepEqual(fissionOrder({activity:true,local:true},{activity:.4,local:0},'main'),['local']);
  assert.deepEqual(fissionOrder({activity:false,local:true},{activity:0,local:0},'activity'),['local']);
});

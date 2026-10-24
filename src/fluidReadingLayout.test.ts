import test from 'node:test';
import assert from 'node:assert/strict';
import {FLUID_READING_MEASURE,fluidReadingMeasure,fluidReadingColumn,fluidReadingRight} from './fluid/readingLayout';
import {availableRight} from './fluid/contentFlow';
import {getFluidLayout} from './fluid/geometry';

test('each outer margin returns half its former room to the shared reading track',()=>{
 assert.equal(fluidReadingMeasure(580),580);assert.equal(fluidReadingMeasure(800),800);
 assert.equal(fluidReadingMeasure(916),858);assert.equal(fluidReadingMeasure(1916),1358);
 assert.equal(fluidReadingMeasure(NaN),0);assert.equal(fluidReadingMeasure(-10),0);
});

test('the full mother surface shares the expanded centered measure between both speakers',()=>{
 const column=fluidReadingColumn(48,1964);
 assert.equal(column.width,FLUID_READING_MEASURE+(1964-48-FLUID_READING_MEASURE)/2);
 assert.equal(column.left,327);assert.equal(column.right,1685);
 assert.equal((column.left+column.right)/2,(48+1964)/2);
 // A short user bubble aligns to this right edge, never to the screen edge.
 assert.equal(fluidReadingRight(column,1964),1685);
});

test('sidebar motion does not shift a reading column that still has room',()=>{
 const idle=fluidReadingColumn(48,1964),open=fluidReadingColumn(224,1964,48);
 assert.equal(open.left,idle.left);assert.equal(open.right,idle.right);assert.equal(open.width,1358);
 assert.equal(idle.offset-open.offset,176);
});

test('a narrower mother bubble yields only where the sidebar actually reaches the reading column',()=>{
 const idle=fluidReadingColumn(48,964),open=fluidReadingColumn(168,964,48);
 assert.equal(idle.width,858);assert.equal(idle.left,77);
 assert.equal(open.left,168);assert.equal(open.right,idle.right);assert.equal(open.width,767);
 assert.equal(open.offset,0);assert.ok(open.right<=964);
 const narrow=fluidReadingColumn(48,628);
 assert.equal(narrow.width,580);assert.equal(narrow.offset,0);
});

test('the upper task only shortens its own lines; the lower conversation keeps its measure',()=>{
 const layout=getFluidLayout(1180,776),column=fluidReadingColumn(48,1144);
 const upper=fluidReadingRight(column,availableRight(layout,{activity:1},100,150));
 const lower=fluidReadingRight(column,availableRight(layout,{activity:1},500,550));
 assert.ok(upper<column.right-100);assert.equal(lower,column.right);
 assert.equal(fluidReadingRight(column,availableRight(layout,{},100,150)),column.right);
});

test('local execution shortens only its lower slice and the composer, without reserving an idle rail',()=>{
 const layout=getFluidLayout(1180,776),column=fluidReadingColumn(48,1144);
 assert.equal(fluidReadingRight(column,availableRight(layout,{local:1},100,150)),column.right);
 assert.ok(fluidReadingRight(column,availableRight(layout,{local:1},650,735))<column.right-100);
 assert.equal(fluidReadingRight(column,availableRight(layout,{},650,735)),column.right);
});

test('very wide conversations remain stable when a child fits outside the reading measure',()=>{
 const layout=getFluidLayout(2600,900),column=fluidReadingColumn(48,2564);
 assert.equal(fluidReadingRight(column,availableRight(layout,{activity:1},100,150)),column.right);
 assert.equal(fluidReadingRight(column,availableRight(layout,{local:1},700,780)),column.right);
});

test('readable intersections remain bounded even at small widths or unavailable metrics',()=>{
 for(const left of [0,48,168,800])for(const right of [0,100,400,964,1964]){
  const column=fluidReadingColumn(left,right,48);
  assert.ok(column.width>=0&&column.width<=right);assert.ok(column.left<=column.right);
  assert.equal(fluidReadingRight(column,-100),column.left);
  assert.equal(fluidReadingRight(column,10000),column.right);
 }
 const fallback=fluidReadingColumn(NaN,Infinity,NaN);
 assert.deepEqual(fallback,{left:0,right:0,width:0,offset:0});
});

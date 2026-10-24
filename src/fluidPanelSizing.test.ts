import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedFluidActivityHeight,fluidActivityHeightLimits,naturalStackHeight} from './fluid/panelSizing';
import {getFluidLayout,fluidAnchorPosition} from './fluid/geometry';
import {FLUID_EYE_RADIUS,fluidPanelEye,fluidRestEntryY} from './fluid/surfaceMetrics';

test('natural height follows rendered text and controls, independent of an old stretched viewport',()=>{
  const emptyBody=naturalStackHeight([{height:21},{height:36},{height:30,marginTop:4}],7);
  const compact=naturalStackHeight([{height:emptyBody}],0,90);
  assert.equal(emptyBody,105);assert.equal(compact,195);
  assert.equal(boundedFluidActivityHeight(compact,776),195);
  const longerText=naturalStackHeight([{height:42},{height:54},{height:30,marginTop:4}],7);
  assert.ok(boundedFluidActivityHeight(90+longerText,776)>195,'Text wrapping must affect actual space');
});
test('multiple task rows grow to a bounded scroll viewport, and collapse naturally with fewer rows',()=>{
  const row={height:86},header={height:38};
  const one=90+naturalStackHeight([header,row],8),many=90+naturalStackHeight([header,...Array(8).fill(row)],8);
  const limit=fluidActivityHeightLimits(776);
  assert.equal(boundedFluidActivityHeight(one,776),222);
  assert.equal(boundedFluidActivityHeight(many,776),limit.max);
  assert.ok(limit.max<776*.6&&limit.max>one);
  assert.equal(boundedFluidActivityHeight(0,776),limit.min);
  assert.ok(Number.isFinite(boundedFluidActivityHeight(NaN,Infinity)));
});
test('the geometry honors content measurement while retaining both outside alignments and a continuous paired dock',()=>{
  const compact=getFluidLayout(1180,776,{activityHeight:195}),larger=getFluidLayout(1180,776,{activityHeight:350});
  assert.equal(compact.activityBounds.height,195);assert.equal(larger.activityBounds.height,350);
  assert.equal(compact.activityBounds.top,0);assert.equal(compact.localBounds.top+compact.localBounds.height,776);
  const paired=getFluidLayout(1180,776,{paired:true,activityHeight:195,localHeight:224});
  assert.equal(paired.activityBounds.top,0);assert.equal(paired.activityBounds.height,paired.localBounds.top);
  assert.equal(paired.localBounds.top+paired.localBounds.height,776);
});
test('only the quiet upper entry returns to its earlier lower seat; the opened eye remains top-tangent',()=>{
  const layout=getFluidLayout(1180,776),upper=layout.activityBounds,lower=layout.localBounds;
  assert.equal(fluidRestEntryY(upper,'activity'),108);
  assert.equal(fluidAnchorPosition(layout.width,upper,0,'activity').y,108);
  assert.equal(fluidRestEntryY(lower,'local'),lower.top+60);
  assert.equal(fluidPanelEye(upper).y-FLUID_EYE_RADIUS,upper.top+.5);
  assert.deepEqual(fluidAnchorPosition(layout.width,upper,1,'activity'),fluidPanelEye(upper));
});

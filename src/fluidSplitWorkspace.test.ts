import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceSplitSpring,createSplitCompletion,splitSpringAtRest,splitWorkspaceGeometry,splitWorkspaceMetrics,type SplitSpring} from './fluid/splitGeometry';

function materialContains(path:string,px:number,py:number){
  const tokens=path.match(/[MCLZ]|-?\d+(?:\.\d+)?/g)||[];let i=0,x=0,y=0;const polygons:number[][][]=[];let current:number[][]=[];
  const num=()=>Number(tokens[i++]);
  while(i<tokens.length){const command=tokens[i++];
    if(command==='M'){current=[];polygons.push(current);x=num();y=num();current.push([x,y]);}
    else if(command==='L'){x=num();y=num();current.push([x,y]);}
    else if(command==='C'){const ox=x,oy=y,a=num(),b=num(),c=num(),d=num();x=num();y=num();for(let k=1;k<=24;k++){const t=k/24,u=1-t;current.push([u*u*u*ox+3*u*u*t*a+3*u*t*t*c+t*t*t*x,u*u*u*oy+3*u*u*t*b+3*u*t*t*d+t*t*t*y]);}}
  }
  return polygons.some(polygon=>{let inside=false;for(let a=0,b=polygon.length-1;a<polygon.length;b=a++){
    const p=polygon[a],q=polygon[b];if((p[1]>py)!==(q[1]>py)&&px<(q[0]-p[0])*(py-p[1])/(q[1]-p[1])+p[0])inside=!inside;
  }return inside;});
}

test('a shared work surface opens opposing clefts before it becomes two rounded bodies',()=>{
  const merged=splitWorkspaceGeometry({width:1040,height:560,progress:0});
  const connected=splitWorkspaceGeometry({width:1040,height:560,progress:.7});
  const separated=splitWorkspaceGeometry({width:1040,height:560,progress:1});
  assert.equal(merged.metrics.connected,true);assert.equal(merged.metrics.notchDepth,0);
  assert.equal((connected.path.match(/M /g)||[]).length,1);
  assert.ok(connected.metrics.notchDepth>150);assert.ok(connected.metrics.neckHalf>0);
  assert.equal(separated.metrics.connected,false);assert.equal((separated.path.match(/M /g)||[]).length,2);
  assert.equal(separated.metrics.lipReach,0);assert.equal(separated.metrics.lipHalf,0);
  assert.equal(separated.metrics.nearRight-separated.metrics.nearLeft,separated.metrics.gap);
  assert.doesNotMatch(separated.path,/[AQ]/,'The body must not morph through an ellipse');
});

test('the actual filled contour retains a center neck then opens an empty gap, rather than overlapping two cards',()=>{
  for(const progress of [0,.3,.55,.78,.9,.925]){
    const {path,metrics:m}=splitWorkspaceGeometry({width:1040,height:560,progress});
    assert.equal(materialContains(path,m.seam,m.centerY),true,`Neck broke before pinch at ${progress}`);
    assert.equal(materialContains(path,m.left+60,m.centerY),true);
    assert.equal(materialContains(path,m.right-60,m.centerY),true);
    if(progress>.3)assert.equal(materialContains(path,m.seam,m.top+5),false,'The cleft must reveal its backing');
  }
  for(const progress of [.97,1]){
    const {path,metrics:m}=splitWorkspaceGeometry({width:1040,height:560,progress});
    assert.equal(materialContains(path,m.seam,m.centerY),false);
    assert.equal(materialContains(path,m.nearLeft-20,m.centerY),true);
    assert.equal(materialContains(path,m.nearRight+20,m.centerY),true);
  }
});

test('geometry remains finite and within the material canvas across viewport widths and reversals',()=>{
  for(const width of [280,420,720,1040,1500])for(const height of [120,250,420,660])for(const ratio of [.2,.34,.5,.8]){
    for(let step=0;step<=100;step++){
      const geometry=splitWorkspaceGeometry({width,height,progress:step/100,ratio,compact:height<300});
      assert.doesNotMatch(geometry.path,/NaN|Infinity|undefined/);
      const m=geometry.metrics;assert.ok(m.nearLeft>m.left);assert.ok(m.nearRight<m.right);
      assert.ok(m.primaryWidth>100);assert.ok(m.secondaryWidth>100);
      assert.ok(m.notchDepth>=0&&m.notchDepth<height/2);assert.ok(m.radius>0);
      assert.equal(geometry.path,splitWorkspaceGeometry({width,height,progress:step/100,ratio,compact:height<300}).path);
    }
  }
  assert.doesNotMatch(splitWorkspaceGeometry({width:NaN,height:Infinity,progress:NaN,ratio:NaN}).path,/NaN|Infinity/);
});

test('desktop list and form retain practical widths and full resting height',()=>{
  for(const width of [720,860,1040,1400]){
    const m=splitWorkspaceMetrics({width,height:560,progress:1,ratio:.34});
    assert.ok(m.primaryWidth>=250);assert.ok(m.secondaryWidth>=320);
    assert.equal(m.top,2);assert.equal(m.bottom,558);assert.equal(m.contentReveal,1);
  }
  assert.equal(splitWorkspaceMetrics({width:1040,height:560,progress:0}).primaryWidth,1036);
});

test('the spring carries its live velocity through interruptions and stops requesting frames at rest',()=>{
  let state:SplitSpring={position:0,velocity:0};
  for(let i=0;i<18;i++)state=advanceSplitSpring(state,1,1/60);
  const before={...state};assert.ok(before.position>0&&before.position<1);assert.ok(before.velocity>0);
  state=advanceSplitSpring(state,0,1/60);
  assert.ok(Math.abs(state.position-before.position)<.05,'Reversal jumped to a logical endpoint');
  for(let i=0;i<90;i++){state=advanceSplitSpring(state,0,1/60);assert.ok(state.position>=0&&state.position<=1);}
  assert.deepEqual(state,{position:0,velocity:0});assert.equal(splitSpringAtRest(state,0),true);
  for(let i=0;i<90;i++)state=advanceSplitSpring(state,1,1/60);
  assert.deepEqual(state,{position:1,velocity:0});
});

test('reduced motion resolves directly to the requested topology without residual velocity',()=>{
  assert.deepEqual(advanceSplitSpring({position:.67,velocity:3},0,1/60,true),{position:0,velocity:0});
  assert.deepEqual(advanceSplitSpring({position:.21,velocity:-2},1,1/60,true),{position:1,velocity:0});
});

test('opening then reversing before settlement still releases the merge consumer once',()=>{
  const events:boolean[]=[],completion=createSplitCompletion(false,open=>events.push(open));
  completion.settle(false);assert.deepEqual(events,[],'Initial merged state is not a user transition');
  completion.retarget(true);
  let motion:SplitSpring={position:0,velocity:0};
  for(let i=0;i<9;i++)motion=advanceSplitSpring(motion,1,1/60);
  assert.ok(motion.position>0&&motion.position<1);
  completion.retarget(false);
  completion.settle(true);assert.deepEqual(events,[],'A stale opening callback must not release queued work');
  for(let i=0;i<100;i++)motion=advanceSplitSpring(motion,0,1/60);
  assert.equal(splitSpringAtRest(motion,0),true);completion.settle(false);completion.settle(false);
  assert.deepEqual(events,[false],'A rapid reversal must return focus and release the queued row link');
  completion.retarget(true);completion.settle(true);completion.retarget(false);completion.settle(false);
  assert.deepEqual(events,[false,true,false]);
});

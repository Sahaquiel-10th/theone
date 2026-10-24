import assert from 'node:assert/strict';
import test from 'node:test';
import {workLayerArrivalGeometry,workLayerUsesDirectTaskSplit,type WorkLayerRegion} from './fluid/workLayerArrivalGeometry';
import {advanceSplitSpring,splitSpringAtRest,splitWorkspaceGeometry,type SplitSpring} from './fluid/splitGeometry';
const regions:WorkLayerRegion[]=[{left:.65,top:.65,width:1038.7,height:68.7,radius:24},{left:10.65,top:90.65,width:1018.7,height:48.7,radius:22},{left:12,top:152,width:1016,height:484,radius:28}];
test('a selected task opens with its own split, without waiting for decorative arrival',()=>{
 assert.equal(workLayerUsesDirectTaskSplit(true,true),true);
 assert.equal(workLayerUsesDirectTaskSplit(true,false),false);
 assert.equal(workLayerUsesDirectTaskSplit(false,true),false);
 assert.equal(workLayerUsesDirectTaskSplit(false,false),false);
 let motion:SplitSpring={position:0,velocity:0};
 motion=advanceSplitSpring(motion,1,1/60);
 assert.ok(motion.position>0&&motion.position<1,'A mount-open detail must move on its first frame');
 const first=splitWorkspaceGeometry({width:1040,height:560,progress:motion.position,ratio:.34});
 assert.equal(first.metrics.connected,true);assert.equal((first.path.match(/M /g)||[]).length,1);
 let frames=1;while(!splitSpringAtRest(motion,1)&&frames<180){motion=advanceSplitSpring(motion,1,1/60);frames++;}
 assert.ok(frames>=66&&frames<=76,'The shared spring duration stays unchanged; there is only one pass');
 const final=splitWorkspaceGeometry({width:1040,height:560,progress:motion.position,ratio:.34});
 assert.equal(final.metrics.connected,false);assert.equal((final.path.match(/M /g)||[]).length,2);
});
function contains(path:string,px:number,py:number){
 const tokens=path.match(/[MCLZ]|-?\d+(?:\.\d+)?/g)||[];let i=0,x=0,y=0;const polygons:number[][][]=[];let current:number[][]=[];const num=()=>Number(tokens[i++]);
 while(i<tokens.length){const command=tokens[i++];if(command==='M'){current=[];polygons.push(current);x=num();y=num();current.push([x,y]);}else if(command==='L'){x=num();y=num();current.push([x,y]);}else if(command==='C'){const ox=x,oy=y,a=num(),b=num(),c=num(),d=num();x=num();y=num();for(let k=1;k<=25;k++){const t=k/25,u=1-t;current.push([u*u*u*ox+3*u*u*t*a+3*u*t*t*c+t*t*t*x,u*u*u*oy+3*u*u*t*b+3*u*t*t*d+t*t*t*y]);}}}
 return polygons.some(polygon=>{let inside=false;for(let a=0,b=polygon.length-1;a<polygon.length;b=a++){const p=polygon[a],q=polygon[b];if((p[1]>py)!==(q[1]>py)&&px<(q[0]-p[0])*(py-p[1])/(q[1]-p[1])+p[0])inside=!inside;}return inside;});
}
test('one filled arrival surface becomes title, scope and body through two ordered physical clefts',()=>{
 const merged=workLayerArrivalGeometry({width:1040,height:648,regions,progress:0});
 assert.equal(merged.components,1);assert.equal((merged.path.match(/M /g)||[]).length,1);
 for(const seam of merged.seams)assert.equal(contains(merged.path,520,seam.middle),true);
 const cutting=workLayerArrivalGeometry({width:1040,height:648,regions,progress:.5});
 assert.equal(cutting.components,1);assert.equal(contains(cutting.path,520,cutting.seams[0].middle),true);
 assert.equal(contains(cutting.path,1030,cutting.seams[0].middle),false,'An actual side cleft must be visible before the neck breaks');
 const firstSplit=workLayerArrivalGeometry({width:1040,height:648,regions,progress:.8});
 assert.equal(firstSplit.components,2);assert.equal(contains(firstSplit.path,520,firstSplit.seams[0].middle),false);assert.equal(contains(firstSplit.path,520,firstSplit.seams[1].middle),true);
 const final=workLayerArrivalGeometry({width:1040,height:648,regions,progress:1});
 assert.equal(final.components,3);assert.equal((final.path.match(/M /g)||[]).length,3);
 for(const seam of final.seams)assert.equal(contains(final.path,520,seam.middle),false);
 for(const region of regions)assert.equal(contains(final.path,region.left+region.width/2,region.top+region.height/2),true);
});
test('arrival returns to the measured terminal bounds without moving or rescaling content',()=>{
 const final=workLayerArrivalGeometry({width:1040,height:648,regions,progress:1});
 for(let i=0;i<regions.length;i++){
   assert.equal(final.regions[i].left,regions[i].left);assert.equal(final.regions[i].right,regions[i].left+regions[i].width);
   assert.ok(Math.abs(final.regions[i].top-regions[i].top)<.001);assert.ok(Math.abs(final.regions[i].bottom-regions[i].top-regions[i].height)<.001);
 }
 for(const width of [720,1040,1520])for(const height of [480,648,900])for(let step=0;step<=100;step++){
   const scaled=regions.map(region=>({...region,left:region.left*width/1040,top:region.top*height/648,width:region.width*width/1040,height:region.height*height/648}));
   const geometry=workLayerArrivalGeometry({width,height,regions:scaled,progress:step/100});
   assert.doesNotMatch(geometry.path,/NaN|Infinity|undefined/);assert.ok(geometry.components>=1&&geometry.components<=3);
 }
});
test('ordinary work layers share the same one-to-two material separation and tolerate absent regions',()=>{
 const two=[regions[0],{...regions[2],top:90,height:546}];
 assert.equal(workLayerArrivalGeometry({width:1040,height:648,regions:two,progress:0}).components,1);
 assert.equal(workLayerArrivalGeometry({width:1040,height:648,regions:two,progress:1}).components,2);
 assert.doesNotMatch(workLayerArrivalGeometry({width:NaN,height:Infinity,regions:[],progress:NaN}).path,/NaN|Infinity/);
});
test('auxiliary motion stays immediate but now settles about 25 percent more slowly',()=>{
 let state:SplitSpring={position:0,velocity:0},frames=0;
 state=advanceSplitSpring(state,1,1/60);assert.ok(state.position>0,'Feedback must start on the first frame');frames++;
 while(!splitSpringAtRest(state,1)&&frames<180){state=advanceSplitSpring(state,1,1/60);frames++;}
 assert.ok(frames>=66&&frames<=76,`Expected a calm ~1.17s response, got ${frames} frames`);
 assert.deepEqual(advanceSplitSpring({position:.55,velocity:1},1,1/60,true),{position:1,velocity:0});
});

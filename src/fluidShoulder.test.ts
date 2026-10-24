import test from 'node:test';
import assert from 'node:assert/strict';
import {openShoulderCut} from './fluid/shoulder';
const bounds={left:0,top:0,width:280,height:236};
const numbers=(s:string)=>(s.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)||[]).map(Number);

test('the active eye niche retains its previously accepted three tangent shoulders',()=>{
 const actual=numbers(openShoulderCut(bounds,1));
 const expected=[0,0,76,0,60.5360270056,0,48,8.954305004,48,20,48,35.4639729944,35.4639729944,48,20,48,8.954305004,48,0,60.5360270056,0,76,0,0];
 assert.equal(actual.length,expected.length);
 actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<.00001));
});

test('the empty niche is one broad circular corner without a tight S-shaped step',()=>{
 const n=numbers(openShoulderCut(bounds,0));let x=n[2],y=n[3];
 for(let c=0;c<3;c++){
  const [a,b,d,e,tx,ty]=n.slice(4+c*6,10+c*6),x0=x,y0=y;
  for(let i=1;i<=50;i++){
   const t=i/50,u=1-t,px=u*u*u*x0+3*u*u*t*a+3*u*t*t*d+t*t*t*tx,py=u*u*u*y0+3*u*u*t*b+3*u*t*t*e+t*t*t*ty;
   assert.ok(px<=x+.00001&&py>=y-.00001,'The shoulder must never kink back');
   assert.ok(Math.abs(Math.hypot(px-64,py-64)-64)<.003,'Quiet corner lost its 64px arc');x=px;y=py;
  }
 }
 assert.ok(Math.abs(x)<.00001&&Math.abs(y-64)<.00001);
 for(let q=0;q<=1;q+=.02)assert.ok(numbers(openShoulderCut(bounds,q)).every(Number.isFinite));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {advanceFluidLogo,fluidLogoNeedsFrame,fluidLogoTarget,restingLogoMotion} from './fluid/logoMotion';

test('fluid logo follows at a distance, retreats only up close and keeps a bounded brand aperture',()=>{
  assert.ok(fluidLogoTarget(150,0).x>0);
  assert.ok(fluidLogoTarget(20,0).x<0);
  assert.equal(fluidLogoTarget(0,0).x,0);
  for(let x=-500;x<=500;x+=5)for(let y=-500;y<=500;y+=5){
    const target=fluidLogoTarget(x,y);
    assert.ok(Math.abs(target.x)<=7.5&&Math.abs(target.y)<=3.2);
    assert.ok(target.openness>=.87&&target.openness<=1.025);
  }
});

test('both proximity thresholds are continuous rather than switching a hover animation',()=>{
  for(const distance of [0,16,64,234,360]){
    const a=fluidLogoTarget(distance-.001,0),b=fluidLogoTarget(distance+.001,0);
    assert.ok(Math.abs(a.x-b.x)<.002,`pupil continuity at ${distance}`);
    assert.ok(Math.abs(a.openness-b.openness)<.001);
  }
  assert.equal(fluidLogoTarget(360,0).nearby,false);
});

test('far, suspended and reduced-motion logos remain dormant without pointer tracking',()=>{
  for(const target of [fluidLogoTarget(600,0),fluidLogoTarget(120,20,{reduced:true}),fluidLogoTarget(120,20,{available:false})]){
    assert.deepEqual({x:target.x,y:target.y,nearby:target.nearby},{x:0,y:0,nearby:false});
    assert.equal(fluidLogoNeedsFrame(restingLogoMotion(),target),false);
  }
  assert.equal(fluidLogoTarget(NaN,2).openness,1);
  assert.equal(fluidLogoTarget(120,20,{reduced:true,focused:true}).openness,1.025);
});

test('pointer reversal preserves current value and finite settling stops the animation loop',()=>{
  let motion=restingLogoMotion();
  const right=fluidLogoTarget(180,10),left=fluidLogoTarget(-180,-10);
  for(let n=0;n<20;n++)motion=advanceFluidLogo(motion,right,1/60);
  const previous=motion.x.position;
  motion=advanceFluidLogo(motion,left,1/60);
  assert.ok(Math.abs(motion.x.position-previous)<.5,'retarget from current presentation, not the opposite endpoint');
  for(let n=0;n<180;n++)motion=advanceFluidLogo(motion,left,1/60);
  assert.equal(fluidLogoNeedsFrame(motion,left),false);
  const neutral=fluidLogoTarget(NaN,NaN);
  for(let n=0;n<180;n++)motion=advanceFluidLogo(motion,neutral,1/60);
  assert.equal(fluidLogoNeedsFrame(motion,neutral),false);
});

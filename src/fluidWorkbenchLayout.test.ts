import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fluidWorkbenchInsets} from './fluid/workbenchLayout';
import {createFluidGeometry,fluidMetrics,getFluidLayout,mainRightAt,sidebarOffset} from './fluid/geometry';
import {sidebarEntryGeometry} from './fluid/entry';
import type {FluidFrame} from './fluid/types';

function frame(width=1340,height=876,patch:Partial<FluidFrame>={}):FluidFrame{
  const layout=getFluidLayout(width,height);
  return {sidebar:0,activity:0,local:0,eyeOwner:'main',activityRecoil:0,localRecoil:0,activityHeight:layout.activityBounds.height,localHeight:layout.localBounds.height,localTop:layout.localBounds.top,...patch};
}

test('workbench content follows the live rail while the rail and eye keep the ONE geometry',()=>{
  const layout=getFluidLayout(1340,876);
  for(const sidebar of [0,.1,.5,.9,1]){
    const progress=frame(1340,876,{sidebar}),insets=fluidWorkbenchInsets(layout,progress),shift=sidebarOffset(layout,sidebar);
    assert.equal(insets.left,48+shift);
    const eye=sidebarEntryGeometry(-12+shift,layout.height/2,1).eye;
    assert.equal(eye.x,-8+shift);
    assert.equal(eye.y,layout.height/2);
    assert.equal(insets.left-eye.x,56);
    assert.equal(88+eye.x,12+64+shift+4);
    assert.equal(insets.right,32.5);
  }
});

test('forms stay inside the liquid mother with either or both task disclosures open',()=>{
  for(const width of [1000,1180,1340,1820])for(const height of [560,776,1000])for(const activity of [0,.2,.5,1])for(const local of [0,.5,1])for(const sidebar of [0,1]){
    const layout=getFluidLayout(width,height),progress=frame(width,height,{activity,local,sidebar}),insets=fluidWorkbenchInsets(layout,progress),metrics=fluidMetrics(layout,progress);
    assert.ok(width-insets.left-insets.right>360);
    for(let y=insets.top;y<=height-insets.bottom;y+=8)assert.ok(width-insets.right<=mainRightAt(layout,metrics,y)-32+1e-8);
    assert.ok(insets.left>sidebarOffset(layout,sidebar)+32);
  }
});

test('resizing away and back produces the same contour, eye anchor, and content insets',()=>{
  const original=getFluidLayout(1340,876),progress=frame(1340,876,{sidebar:1,activity:1}),path=createFluidGeometry(original,progress),bounds=fluidWorkbenchInsets(original,progress);
  for(const [width,height] of [[390,780],[1820,1056],[1000,560],[1340,876]]){
    const resized=getFluidLayout(width,height),resizedFrame=frame(width,height,{sidebar:1,activity:1});
    assert.ok(Number.isFinite(fluidWorkbenchInsets(resized,resizedFrame).left));
  }
  const restored=getFluidLayout(1340,876);
  assert.equal(createFluidGeometry(restored,progress),path);
  assert.deepEqual(fluidWorkbenchInsets(restored,progress),bounds);
});

test('the workbench is a content sibling of the one persistent material instead of a second shell',()=>{
  const main=fs.readFileSync(new URL('./main.tsx',import.meta.url),'utf8'),css=fs.readFileSync(new URL('./IndustryWorkspaces.css',import.meta.url),'utf8');
  const canvasStart=main.indexOf('<div className={`studio-layout one-background-workspace'),skin=main.indexOf('<div className="fluid-skin">',canvasStart),industry=main.indexOf('industryVisited?<section className="industry-page-shell"',canvasStart),layers=main.indexOf('{preview.enabled?<>',industry);
  assert.ok(canvasStart>0&&skin>canvasStart&&industry>skin&&layers>industry);
  assert.doesNotMatch(main.slice(canvasStart,skin),/hidden=\{industryPage.open\}|inert=\{industryPage.open\}|display:'none'/);
  assert.match(main,/fluidEnabled\?<div className="fluid-skin">/);
  assert.match(main,/data-background-page=\{industryPage.open\}/);
  assert.match(main,/useFluidContentFlow\(fluidCanvasRef,fluidEnabled&&fluidDesktop,fluidLayout,industryPage.open\)/);
  assert.equal((main.match(/<OneFluidSurface /g)||[]).length,1);
  assert.doesNotMatch(css,/is-industry-page[^}]*--fluid-rail-growth|is-industry-page[^}]*\.fluid-rail[^}]*width:/);
  const opening=main.slice(main.indexOf('  function openIndustryPage('),main.indexOf('  function chooseFeature('));
  assert.doesNotMatch(opening,/setSidebarOpen\(false\)/);
});

test('compact workbenches use the ONE mother material when the optical canvas is hidden, including landscape',()=>{
  const css=fs.readFileSync(new URL('./IndustryWorkspaces.css',import.meta.url),'utf8');
  const selector='main.one-fluid-workspace.one-shell.one-studio[data-fluid-desktop=false] .fluid-canvas>.industry-page-shell',start=css.indexOf(selector),rule=css.slice(start,css.indexOf('}',start)+1);
  assert.ok(start>0&&start<css.indexOf('@media'));
  assert.match(rule,/background:var\(--fluid-material\)/);
  assert.match(rule,/color:var\(--fluid-ink\)/);
  for(const [width,height] of [[375,812],[844,390]])assert.equal(width>=1100&&height>=584,false);
  const desktopRule=css.slice(css.indexOf('.industry-page-shell{'),css.indexOf('}',css.indexOf('.industry-page-shell{'))+1);
  assert.match(desktopRule,/background:transparent/);
  assert.doesNotMatch(rule,/fluid-rail|fluid-compact-toggle/);
});

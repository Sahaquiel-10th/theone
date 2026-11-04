import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {exitIndustryPageNavigation,industryWorkspaceFromHref,observeWorkspaceViewport,openIndustryPageNavigation,readIndustryPageNavigation,syncIndustryPageNavigation,type IndustryNavigationBrowser} from './industryPageNavigation';

function browserAt(href='https://one.example/?task=task-a#task:task-a'){
  const entries=[{href,state:null as unknown}],storage=new Map<string,string>();let index=0;
  const browser:IndustryNavigationBrowser={
    location:{get href(){return entries[index].href;}},
    history:{
      get state(){return entries[index].state;},
      pushState(state,_,url){entries.splice(index+1);entries.push({href:new URL(String(url),entries[index].href).href,state});index++;},
      replaceState(state,_,url){entries[index]={href:new URL(String(url),entries[index].href).href,state};}
    },
    sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value);}}
  };
  return {browser,entries,back(){if(index>0)index--;},forward(){if(index<entries.length-1)index++;}};
}

test('only the directory and four public workflow kinds route inside ONE',()=>{
  const base='https://one.example/';
  assert.equal(industryWorkspaceFromHref('/workbenches',base),null);
  for(const kind of ['teaching','product_creative','image_edit','review_reply'])assert.equal(industryWorkspaceFromHref(`/workbenches/${kind}/`,base),kind);
  for(const href of ['/workbenches/unknown','/workbenches/teaching/private','/workbenches-other','https://other.example/workbenches/teaching'])assert.equal(industryWorkspaceFromHref(href,base),undefined);
});

test('direct links and refresh restore the requested workflow without adding a history entry',()=>{
  const {browser,entries}=browserAt('https://one.example/workbenches/image_edit');
  assert.deepEqual(readIndustryPageNavigation(browser,'user-a:workspace-a').page,{open:true,workspace:'image_edit',surface:'chat'});
  assert.deepEqual(syncIndustryPageNavigation(browser,'user-a:workspace-a'),{open:true,workspace:'image_edit',surface:'chat'});
  assert.deepEqual(syncIndustryPageNavigation(browser,'user-a:workspace-a'),{open:true,workspace:'image_edit',surface:'chat'});
  assert.equal(entries.length,1);
});

test('directory, workflow, Back and Forward preserve the departing ONE destination and task link',()=>{
  const {browser,entries,back,forward}=browserAt();
  syncIndustryPageNavigation(browser,'owner','features');
  openIndustryPageNavigation(browser,'owner',null,'features');
  openIndustryPageNavigation(browser,'owner','teaching','features');
  assert.equal(new URL(browser.location.href).pathname,'/workbenches/teaching');
  assert.equal(entries.length,3);
  back();assert.deepEqual(syncIndustryPageNavigation(browser,'owner'),{open:true,workspace:null,surface:'features'});
  back();assert.deepEqual(syncIndustryPageNavigation(browser,'owner'),{open:false,workspace:null,surface:'features'});
  assert.equal(browser.location.href,'https://one.example/?task=task-a#task:task-a');
  forward();forward();assert.equal(syncIndustryPageNavigation(browser,'owner').workspace,'teaching');
  assert.equal(entries.length,3);
});

test('leaving a workflow for Skills creates a reversible root entry without resetting chat state',()=>{
  const {browser,back,forward}=browserAt('https://one.example/');
  const chat={text:'保留这份草稿',attachments:['file-a'],runningTask:'task-a'};
  const original=structuredClone(chat);
  openIndustryPageNavigation(browser,'owner','review_reply','chat');
  assert.deepEqual(exitIndustryPageNavigation(browser,'owner','features'),{open:false,workspace:null,surface:'features'});
  assert.equal(browser.location.href,'https://one.example/');
  back();assert.equal(syncIndustryPageNavigation(browser,'owner').workspace,'review_reply');
  forward();assert.equal(syncIndustryPageNavigation(browser,'owner').surface,'features');
  assert.deepEqual(chat,original);
  assert.deepEqual(Object.keys((browser.history.state as {oneIndustryPage:object}).oneIndustryPage).sort(),['scopeKey','surface','version']);
});

test('a connector callback is initially honored, retained in URLs, then normal navigation controls its destination',()=>{
  const {browser,back}=browserAt('https://one.example/?knowledge=notion&status=connected&task=task-b#task:task-b');
  assert.equal(syncIndustryPageNavigation(browser,'owner').surface,'account');
  exitIndustryPageNavigation(browser,'owner','features');
  openIndustryPageNavigation(browser,'owner',null,'features');
  back();assert.equal(syncIndustryPageNavigation(browser,'owner').surface,'features');
  assert.equal(new URL(browser.location.href).search,'?knowledge=notion&status=connected&task=task-b');
  assert.equal(new URL(browser.location.href).hash,'#task:task-b');
});

test('switching either user or workspace drops the old tool position and private URL parameters',()=>{
  for(const nextOwner of ['user-b:workspace-a','user-a:workspace-b']){
    const {browser,back,entries}=browserAt();
    openIndustryPageNavigation(browser,'user-a:workspace-a','teaching','chat');
    assert.deepEqual(readIndustryPageNavigation(browser,nextOwner).page,{open:true,workspace:null,surface:'chat'});
    assert.deepEqual(syncIndustryPageNavigation(browser,nextOwner),{open:true,workspace:null,surface:'chat'});
    assert.equal(browser.location.href,'https://one.example/workbenches');
    back();assert.deepEqual(syncIndustryPageNavigation(browser,nextOwner),{open:false,workspace:null,surface:'chat'});
    assert.equal(browser.location.href,'https://one.example/');
    assert.equal(entries.length,2);
  }
});

test('a fresh history entry still detects the old tab owner after an identity switch',()=>{
  const {browser}=browserAt('https://one.example/');
  syncIndustryPageNavigation(browser,'old-owner');
  browser.history.pushState(null,'','/workbenches/product_creative?task=old-task#task:old-task');
  assert.deepEqual(syncIndustryPageNavigation(browser,'new-owner'),{open:true,workspace:null,surface:'chat'});
  assert.equal(browser.location.href,'https://one.example/workbenches');
});

test('invalid industry paths normalize to the directory and selecting the same page never duplicates it',()=>{
  const {browser,entries}=browserAt('https://one.example/workbenches/not-a-workspace?scene=silver');
  assert.equal(syncIndustryPageNavigation(browser,'owner').workspace,null);
  assert.equal(browser.location.href,'https://one.example/workbenches?scene=silver');
  openIndustryPageNavigation(browser,'owner',null,'chat');assert.equal(entries.length,1);
  openIndustryPageNavigation(browser,'owner','image_edit','chat');
  openIndustryPageNavigation(browser,'owner','image_edit','chat');assert.equal(entries.length,2);
});

test('blocked session storage does not prevent deep links or history navigation',()=>{
  const {browser,back}=browserAt('https://one.example/');
  browser.sessionStorage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
  openIndustryPageNavigation(browser,'owner','image_edit','chat');
  assert.equal(syncIndustryPageNavigation(browser,'owner').workspace,'image_edit');
  exitIndustryPageNavigation(browser,'owner','avatars');
  back();assert.equal(syncIndustryPageNavigation(browser,'owner').workspace,'image_edit');
});

test('the application mounts its workbench page once inside the shared shell and makes chat content inert',()=>{
  const main=fs.readFileSync(new URL('./main.tsx',import.meta.url),'utf8');
  assert.match(main,/window\.addEventListener\('popstate',sync\)/);
  assert.match(main,/industryVisited\?<section className="industry-page-shell"[^>]+hidden=\{!industryPage.open\} inert=\{!industryPage.open\}/);
  assert.match(main,/studio-surface" data-background-page=\{industryPage.open\}[^>]+inert=\{industryPage.open\}/);
  assert.doesNotMatch(main,/studio-layout one-background-workspace[^>]+hidden=\{industryPage.open\}/);
  assert.doesNotMatch(main,/<FluidWorkLayer title="行业工作台"/);
  assert.doesNotMatch(main,/view === "workbenches"/);
  const navigation=main.slice(main.indexOf('  function currentOneSurface()'),main.indexOf('  function chooseFeature('));
  assert.doesNotMatch(navigation,/api\(|\.dispatch\(|setContent\(|setActiveId\(|switchDraft\(|sendMessage\(/);
});

test('window and visualViewport events resize the full page without a visible chat canvas, and clean up',()=>{
  const windowListeners=new Set<()=>void>(),visualListeners=new Set<()=>void>();
  const browser={innerWidth:1440,innerHeight:1000,addEventListener:(_:'resize',listener:()=>void)=>{windowListeners.add(listener);},removeEventListener:(_:'resize',listener:()=>void)=>{windowListeners.delete(listener);},visualViewport:{addEventListener:(_:'resize',listener:()=>void)=>{visualListeners.add(listener);},removeEventListener:(_:'resize',listener:()=>void)=>{visualListeners.delete(listener);}}};
  let size={width:1352,height:976,viewportWidth:0,viewportHeight:0},updates=0;
  const stop=observeWorkspaceViewport(browser,viewport=>{size={...size,viewportWidth:viewport.width,viewportHeight:viewport.height};updates++;});
  assert.equal(size.viewportWidth,1440);
  browser.innerWidth=390;browser.innerHeight=844;for(const listener of windowListeners)listener();
  assert.equal(size.viewportWidth,390);assert.equal(size.viewportHeight,844);
  assert.equal(size.width,1352);assert.equal(size.height,976);
  browser.innerWidth=1440;browser.innerHeight=1000;for(const listener of visualListeners)listener();
  assert.equal(size.viewportWidth,1440);assert.equal(size.viewportHeight,1000);
  stop();assert.equal(windowListeners.size,0);assert.equal(visualListeners.size,0);assert.equal(updates,3);
  const main=fs.readFileSync(new URL('./main.tsx',import.meta.url),'utf8');
  assert.match(main,/observeWorkspaceViewport\(window,size=>setFluidSize/);
  assert.match(main,/if\(!canvas\|\|!fluidEnabled\)return/);
  assert.doesNotMatch(main,/if\(!canvas\|\|!fluidEnabled\|\|industryPage.open\)return/);
});

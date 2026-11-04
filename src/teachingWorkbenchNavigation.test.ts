import test from 'node:test';
import assert from 'node:assert/strict';
import {clearTeachingWorkbenchParams,commitTeachingWorkbenchNavigation,readTeachingWorkbenchRoute,teachingWorkbenchHref} from './teachingWorkbenchNavigation';

test('a saved assignment and its independent grading page survive a refreshed URL',()=>{
  const route={view:'tool' as const,tool:'grade' as const,courseId:'tc_course-a',activityId:'ta_homework-b',step:'grading'};
  const href=teachingWorkbenchHref('https://one.example/workbenches/teaching?task=task-a#task:task-a',route);
  assert.deepEqual(readTeachingWorkbenchRoute(new URL(href,'https://one.example').href),route);
  assert.match(href,/task=task-a/);assert.match(href,/#task:task-a$/);
  const entries=[teachingWorkbenchHref('https://one.example',{view:'home'}),href,teachingWorkbenchHref('https://one.example',{...route,step:'results'})];
  assert.equal(readTeachingWorkbenchRoute(new URL(entries[1],'https://one.example').href).view,'tool');
  assert.deepEqual(readTeachingWorkbenchRoute(new URL(entries[0],'https://one.example').href),{view:'home'});
});

test('course management and tool choice have separate navigation and do not inherit the previous item',()=>{
  const previous='https://one.example/workbenches/teaching?tView=tool&tTool=grade&tCourse=tc_a&tItem=ta_b&tStep=results&scene=silver';
  const next=teachingWorkbenchHref(previous,{view:'courses',mode:'create',returnTool:'ask'});
  assert.deepEqual(readTeachingWorkbenchRoute(new URL(next,'https://one.example').href),{view:'courses',mode:'create',returnTool:'ask'});
  assert.doesNotMatch(next,/tItem|tStep|tCourse/);assert.match(next,/scene=silver/);
  const select=teachingWorkbenchHref(previous,{view:'select',tool:'quiz'});
  assert.deepEqual(readTeachingWorkbenchRoute(new URL(select,'https://one.example').href),{view:'select',tool:'quiz'});
});

test('malformed route values never become a tool, step, or private record identifier',()=>{
  const url='https://one.example/workbenches/teaching';
  assert.deepEqual(readTeachingWorkbenchRoute(url+'?tView=tool&tTool=hack&tCourse=tc_a'),{view:'home'});
  assert.deepEqual(readTeachingWorkbenchRoute(url+'?tView=tool&tTool=ask&tCourse=private%20title'),{view:'home'});
  assert.deepEqual(readTeachingWorkbenchRoute(url+'?tView=tool&tTool=ask&tCourse=tc_a&tItem=bad/path&tStep=results'),{view:'tool',tool:'ask',courseId:'tc_a',step:'list'});
  assert.deepEqual(readTeachingWorkbenchRoute(url+'?tView=courses&tMode=edit'),{view:'courses',mode:'list'});
  assert.deepEqual(readTeachingWorkbenchRoute('https://one.example/workbenches/image_edit?tView=tool&tTool=ask&tCourse=tc_a'),{view:'home'});
});

test('leaving the teacher workspace removes only its record position, retaining connector and task navigation',()=>{
  const url=new URL('https://one.example/workbenches/teaching?task=task-a&knowledge=notion&tView=tool&tTool=grade&tCourse=tc_a&tItem=ta_b&tStep=results#task:task-a');
  clearTeachingWorkbenchParams(url);
  assert.equal(url.search,'?task=task-a&knowledge=notion');assert.equal(url.hash,'#task:task-a');
});

test('a late save receipt cannot replace the page chosen after leaving the teacher tool',()=>{
  for(const [href,active] of [['https://one.example/?task=ongoing',true],['https://one.example/workbenches/image_edit',true],['https://one.example/workbenches/teaching',false]] as const){
    const mutations:unknown[]=[],browser={location:{href},history:{state:{oneIndustryPage:{scopeKey:'owner',surface:'chat'}},pushState(...args:unknown[]){mutations.push(args);},replaceState(...args:unknown[]){mutations.push(args);}}};
    assert.equal(commitTeachingWorkbenchNavigation(browser,{view:'tool',tool:'grade',courseId:'tc_a',activityId:'ta_saved',step:'submissions'},active,true),false);
    assert.deepEqual(mutations,[]);assert.equal(browser.location.href,href);
  }
});

test('an active teacher page replaces its new-item receipt once and pushes a later step without losing outer history state',()=>{
  let href='https://one.example/workbenches/teaching?task=ongoing&tView=tool&tTool=grade&tCourse=tc_a&tStep=submissions';
  const changes:{method:string;state:unknown}[]=[],state={oneIndustryPage:{scopeKey:'owner',surface:'chat'}};
  const browser={location:{get href(){return href;}},history:{state,pushState(value:unknown,_unused:string,url?:string|URL|null){href=new URL(String(url),href).href;changes.push({method:'push',state:value});},replaceState(value:unknown,_unused:string,url?:string|URL|null){href=new URL(String(url),href).href;changes.push({method:'replace',state:value});}}};
  const saved={view:'tool' as const,tool:'grade' as const,courseId:'tc_a',activityId:'ta_saved',step:'submissions'};
  commitTeachingWorkbenchNavigation(browser,saved,true,true);commitTeachingWorkbenchNavigation(browser,saved,true,true);
  commitTeachingWorkbenchNavigation(browser,{...saved,step:'grading'},true);
  assert.deepEqual(changes.map(change=>change.method),['replace','push']);assert.ok(changes.every(change=>change.state===state));assert.match(href,/task=ongoing/);assert.deepEqual(readTeachingWorkbenchRoute(href),{...saved,step:'grading'});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {clearTeachingWorkbenchParams,readTeachingWorkbenchRoute,teachingWorkbenchHref} from './teachingWorkbenchNavigation';

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

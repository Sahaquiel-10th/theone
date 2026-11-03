import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TaskWorkflowActivity} from './TaskWorkflowActivity';
import {taskWorkflowActivityView,type TaskWorkflowView} from './taskWorkflowView';
import {TaskTransferRail,type Transfer} from './TaskTransferRail';
import {nearLatest} from './useFollowLatest';

const workflow:TaskWorkflowView={version:1,phase:'waiting',steps:[
 {id:'read',title:'找到资料',state:'completed'},
 {id:'examples',title:'补充案例',state:'completed'},
 {id:'draft',title:'文章已写好',state:'completed',resultAvailable:true},
 {id:'save',title:'核对 Notion 正文',state:'waiting',waitingFor:'result'},
 {id:'later',title:'尚未开始的后续内容',state:'queued'},
]};
const render=(value=workflow)=>renderToStaticMarkup(createElement(TaskWorkflowActivity,{taskId:'task',workflow:value,onOpen:()=>{}}));

test('activity shows real progress through the current stage, retains older rows and omits future queued plan',()=>{
 const view=taskWorkflowActivityView(workflow)!;
 assert.deepEqual(view.steps.map(step=>step.id),['read','examples','draft','save']);
 const html=render();
 assert.match(html,/步骤进展/);assert.match(html,/tabindex="0"/);
 assert.equal((html.match(/<li\b/g)||[]).length,4,'CSS limits the viewport to three rows, not the history');
 assert.match(html,/正在核对结果/);assert.doesNotMatch(html,/尚未开始的后续内容|等待前一步|下一步|重试|继续|确认/);
 assert.equal((html.match(/<button\b/g)||[]).length,1,'only a proved available result gets an action');
 assert.match(html,/查看任务成果：文章已写好/);
});

test('background retry remains a quiet progress row; exhausted or needs-input do not pretend to recover',()=>{
 const retry={...workflow,steps:[{...workflow.steps[3],recovery:{state:'scheduled' as const,attempt:2,nextRetryAt:'2026-11-03T01:00:00Z'}}]};
 assert.match(render(retry),/正在自动恢复/);assert.doesNotMatch(render(retry),/重试|确认|继续|<button/);
 const exhausted={...retry,steps:[{...retry.steps[0],state:'failed' as const,recovery:{state:'exhausted' as const}}]};
 assert.match(render(exhausted),/这步没做完/);assert.doesNotMatch(render(exhausted),/正在自动恢复/);
 const needsInput={...workflow,steps:[{...workflow.steps[3],state:'needs_input' as const}]};
 assert.match(render(needsInput),/等你补充/);assert.doesNotMatch(render(needsInput),/正在核对结果|正在自动恢复/);
 const staleRecovery={...retry,steps:[{...retry.steps[0],state:'needs_input' as const}]};
 assert.match(render(staleRecovery),/等你补充/);assert.doesNotMatch(render(staleRecovery),/正在自动恢复/);
 const actionable={...needsInput,steps:[{...needsInput.steps[0],summary:'请选择保存位置'}]};
 assert.match(render(actionable),/请选择保存位置/);
});

test('queued, empty and old workflows never invent completed work, and private extra fields stay out of the DOM',()=>{
 const queued={...workflow,steps:workflow.steps.map(step=>({...step,state:'queued' as const,resultAvailable:true}))};
 const html=render(queued);assert.equal((html.match(/<li\b/g)||[]).length,1);assert.doesNotMatch(html,/查看任务成果|已完成|正在处理|tabindex/);
 assert.equal(taskWorkflowActivityView(),undefined);
 assert.equal(renderToStaticMarkup(createElement(TaskWorkflowActivity,{taskId:'old',onOpen:()=>{}})),'');
 const contaminated={...workflow,operationId:'private-op',steps:workflow.steps.map(step=>({...step,tool:'private-tool',input:'private-input',args:{secret:'private-secret'}}))};
 assert.doesNotMatch(render(contaminated),/private-|\/api\/|onclick/);
});

test('task rail uses progress rows instead of repeated narration and retains stop plus actual task viewing',()=>{
 const task:Transfer={id:'run',taskId:'task',title:'写专栏',state:'reconciling',phase:'正在只读核对 Notion 保存结果，不会重复写入',workflow};
 const html=renderToStaticMarkup(createElement(TaskTransferRail,{tasks:[task],busy:false,onOpen:()=>{},onStop:async()=>{}}));
 assert.match(html,/文章已写好/);assert.match(html,/核对 Notion 正文/);assert.match(html,/停止任务：写专栏/);
 assert.doesNotMatch(html,/正在只读核对|查看并处理|重试|处理期间可以继续聊天/);
});

test('browsing even one earlier progress row releases automatic following while the bottom remains live',()=>{
 assert.equal(nearLatest({scrollHeight:176,clientHeight:132,scrollTop:0},8),false);
 assert.equal(nearLatest({scrollHeight:176,clientHeight:132,scrollTop:44},8),true);
 assert.equal(nearLatest({scrollHeight:176,clientHeight:132,scrollTop:40},8),true);
});

test('future dependency waits cannot scroll the actual blocker out of the feed',()=>{
 const blocked:TaskWorkflowView={version:1,phase:'needs_input',steps:[
  {id:'read',title:'还缺来源',state:'needs_input'},
  ...['draft','save','export','deliver'].map(id=>({id,title:`后续 ${id}`,state:'waiting' as const,waitingFor:'inputs' as const})),
 ]};
 assert.deepEqual(taskWorkflowActivityView(blocked)!.steps.map(step=>step.id),['read']);
 const html=render(blocked);assert.match(html,/还缺来源/);assert.doesNotMatch(html,/后续|tabindex/);
});

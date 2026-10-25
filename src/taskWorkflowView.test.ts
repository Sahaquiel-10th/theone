import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TaskWorkflowProgress} from './TaskWorkflowProgress';
import {taskWorkflowView,workflowStepLabel,type TaskWorkflowView,type WorkflowStepState} from './taskWorkflowView';
import {viewCoordinatorTask} from './coordinatorTaskView';
import {coordinatorDetailRefreshPlan} from './coordinatorDetailRefresh';

const workflow=(state:WorkflowStepState):TaskWorkflowView=>({version:1,phase:'internal_phase_not_for_display',steps:[{id:'read',title:'查找已连接的资料',state,summary:'先核对这次需要的来源。'}],next:'根据找到的资料整理正文。'});
const render=(value?:TaskWorkflowView)=>renderToStaticMarkup(createElement(TaskWorkflowProgress,{workflow:value}));

test('old jobs without a workflow add no empty or invented progress UI',()=>{
 assert.equal(taskWorkflowView(),undefined);assert.equal(render(),'');
 assert.equal(render({version:1,phase:'queued',steps:[]}), '');
 assert.equal(render({...workflow('queued'),version:2} as unknown as TaskWorkflowView),'');
});

test('each step state has a clear label and a waiting step never claims the task failed or started',()=>{
 const expected:Record<WorkflowStepState,string>={queued:'等待开始',running:'正在处理',completed:'已完成',waiting:'等待前一步',needs_input:'等你补充',failed:'这步没做完',skipped:'已跳过'};
 for(const [state,label] of Object.entries(expected)){
  assert.equal(workflowStepLabel(state),label);assert.match(render(workflow(state as WorkflowStepState)),new RegExp(label));
 }
 assert.doesNotMatch(render(workflow('queued')),/正在处理|正在运行/);
 assert.doesNotMatch(render(workflow('waiting')),/整个任务失败|任务失败|正在处理/);
 assert.doesNotMatch(render(workflow('failed')),/任务失败|全部失败/);
 assert.equal(workflowStepLabel('future_state'),'状态待确认');
});

test('progress renders only the public title, state, summary and next step, never private job fields or controls',()=>{
 const value={...workflow('running'),tool:'private-tool-id',modelId:'private-model-id',context:{secret:'private-context'},steps:[{...workflow('running').steps[0],toolId:'private-step-tool',args:{password:'private-argument'}}]};
 const html=render(value);
 assert.match(html,/任务处理步骤/);assert.match(html,/查找已连接的资料/);assert.match(html,/先核对这次需要的来源/);assert.match(html,/下一步/);
 assert.doesNotMatch(html,/private-|internal_phase|<button|<form|onclick|onToggle|\/api\//);
 assert.match(html,/<details/);assert.match(html,/<summary\b/);assert.doesNotMatch(html,/<details[^>]*\sopen(?:[=>\s])/,'native disclosure is initially collapsed and React does not own its open state');
});

test('detail refresh updates workflow progress through GET only and preserves a collapsed passive disclosure',async()=>{
 const task={id:'task',updatedAt:'unchanged',running:false,queued:0};
 let selected:string|null=null,server={conversation:{updatedAt:'unchanged'},jobs:[{workflow:workflow('waiting')}]};
 const details:Record<string,typeof server>={},calls:string[]=[];
 const load=async(id:string)=>{calls.push(`GET /api/coordinator/tasks/${id}`);return details[id]=structuredClone(server);};
 await viewCoordinatorTask(task.id,{isCurrent:()=>true,select:id=>{selected=id;},load});
 const before=render(details.task.jobs[0].workflow);assert.match(before,/等待前一步/);
 server={...server,jobs:[{workflow:workflow('completed')}]};
 for(const {id} of coordinatorDetailRefreshPlan({selected,tasks:[task],notices:[],details,loadedVersions:new Map()}))await load(id);
 const after=render(details.task.jobs[0].workflow);assert.match(after,/已完成 1\/1/);assert.doesNotMatch(after,/等待前一步|<button|<details[^>]*\sopen(?:[=>\s])/);
 assert.deepEqual(calls,['GET /api/coordinator/tasks/task','GET /api/coordinator/tasks/task']);
 await viewCoordinatorTask(null,{isCurrent:()=>true,select:id=>{selected=id;},load});
 assert.equal(selected,null);assert.equal(calls.length,2,'closing neither restarts nor acknowledges any workflow step');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {recoveryGuidance} from './recoveryGuidance';
import {TaskRecoveryGuidance} from './TaskRecoveryGuidance';
import type {TaskWorkflowView} from './taskWorkflowView';
import {taskRecovery} from './taskRecovery';

const workflow:TaskWorkflowView={version:1,phase:'failed',steps:[
 {id:'draft',title:'写好文章',state:'completed',resultAvailable:true},
 {id:'save',title:'保存并核对',state:'failed'},
]};
test('one recovery explanation preserves completed stages and names the actual blocked stage and human action',()=>{
 const guide=recoveryGuidance({workflow,recovery:{kind:'connection',message:'连接在保存前中断，保存尚未发出。'}});
 assert.deepEqual(guide.completed,['写好文章']);assert.equal(guide.step,'保存并核对');
 assert.equal(guide.automatic,false);assert.equal(guide.actionLabel,'继续这件事');assert.match(guide.next,/重新检查.*断点/);
 assert.doesNotMatch(guide.next,/重新生成文章|确认.*预算/);
});
test('automatic recovery says no action, while an old scheduled step cannot override a terminal support decision',()=>{
 const recovering:TaskWorkflowView={...workflow,phase:'waiting',steps:[workflow.steps[0],{id:'save',title:'核对原页',state:'waiting',waitingFor:'result',recovery:{state:'scheduled',attempt:2}}]};
 const active=recoveryGuidance({workflow:recovering,recovery:{kind:'reconciling',message:'正在读取同一原页。'}});
 assert.equal(active.automatic,true);assert.equal(active.actionLabel,undefined);assert.match(active.next,/不用你操作/);
 const stopped=recoveryGuidance({workflow:recovering,recovery:{kind:'support',message:'内部格式修正已耗尽。'}});
 assert.equal(stopped.automatic,false);assert.equal(stopped.actionLabel,undefined);assert.match(stopped.next,/已停止.*支持人员.*不用操作/);
});
test('unknown file effects remain protected with a clear stopped state instead of an executable generic retry',()=>{
 const recovery=taskRecovery([{id:'original',state:'failed',steps:[{effect:'artifact',state:'failed',operation:{execution:'unknown'}}]}]);
 assert.equal(recovery.kind,'support');assert.equal(recovery.sourceJobId,undefined);assert.match(recovery.message,/已暂停.*不会自动重新制作/);
});
test('real recovery component shows facts and safe internal issue ID without inventing completed output',()=>{
 const html=renderToStaticMarkup(createElement(TaskRecoveryGuidance,{workflow,recovery:{kind:'support',message:'这一步内部参数未通过。',requestId:'coord_public123'}}));
 assert.match(html,/已完成.*写好文章/);assert.match(html,/停在.*保存并核对/);assert.match(html,/支持人员.*不用操作/);assert.match(html,/coord_public123/);
 const empty=renderToStaticMarkup(createElement(TaskRecoveryGuidance,{recovery:{kind:'input',message:'请上传要填写的 XLSX 模板。',requestId:'https://secret.invalid/token'}}));
 assert.doesNotMatch(empty,/已完成|secret.invalid/);assert.match(empty,/补充.*资料/);
});

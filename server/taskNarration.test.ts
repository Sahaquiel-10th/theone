import test from 'node:test';
import assert from 'node:assert/strict';
import {taskReportPrompt,taskReportFallback,validateTaskReport} from './taskNarration.js';
import {friendlyConversationGuidance} from './conversationTone.js';

test('report guidance offers direct missing-material input but preserves stop and uncertain-save checks',()=>{
 assert.match(taskReportPrompt,/缺少素材或信息.*直接在主对话补充/);
 assert.match(taskReportPrompt,/用户主动停止.*先确认.*不能擅自恢复/);
 assert.match(taskReportPrompt,/保存结果尚未确认.*先核对原页面.*不建议重写、重试或重复新建/);
 assert.doesNotMatch(taskReportPrompt,/下一步只能建议用户点任务中的继续入口/);
});
test('internal status words fall back to plain facts and an actual stop or uncertain save retains its next step',()=>{
 const facts={done:['正文'],pending:['结尾'],files:[],reason:'缺少结尾实例'};
 for(const word of ['goal_unfinished','goalunfinished','coordinator','operation','运行态','已接住','正在承接']){
  const message=validateTaskReport(JSON.stringify({message:`正文已经做好，结尾还没完成。${word}`}),facts);
  assert.doesNotMatch(message,/goal_?unfinished|coordinator|operation|运行态|已接住|正在承接/);assert.match(message,/正文已完成/);assert.match(message,/结尾还没做好/);
 }
 const stopped=taskReportFallback({...facts,reason:'用户主动停止'});assert.match(stopped,/任务已停止/);assert.doesNotMatch(stopped,/可以接着处理|正在继续/);
 const saving=taskReportFallback({...facts,reason:'保存结果未确认'});assert.match(saving,/先核对原页面/);assert.doesNotMatch(saving,/重试|重新写入/);
 assert.match(friendlyConversationGuidance,/不把.*承接.*运行态.*回执.*coordinator.*operation/);
 assert.match(friendlyConversationGuidance,/不把普通补充信息说成审批/);
});

test('paused reports still reject a promise to resume automatically',()=>{
 const facts={done:[],pending:['启动器素材'],files:[],reason:'缺少素材'};
 const result=validateTaskReport(JSON.stringify({message:'我会继续处理，补完就给你。'}),facts);
 assert.doesNotMatch(result,/我会继续处理|补完就给你/);
});

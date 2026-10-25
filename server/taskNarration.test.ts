import test from 'node:test';
import assert from 'node:assert/strict';
import {taskReportPrompt,validateTaskReport} from './taskNarration.js';

test('report guidance offers direct missing-material input but preserves stop and uncertain-save checks',()=>{
 assert.match(taskReportPrompt,/缺少素材或信息.*直接在主对话补充/);
 assert.match(taskReportPrompt,/用户主动停止.*先确认.*不能擅自恢复/);
 assert.match(taskReportPrompt,/保存结果尚未确认.*先核对原页面.*不建议重写、重试或重复新建/);
 assert.doesNotMatch(taskReportPrompt,/下一步只能建议用户点任务中的继续入口/);
});

test('paused reports still reject a promise to resume automatically',()=>{
 const facts={done:[],pending:['启动器素材'],files:[],reason:'缺少素材'};
 const result=validateTaskReport(JSON.stringify({message:'我会继续处理，补完就给你。'}),facts);
 assert.doesNotMatch(result,/我会继续处理|补完就给你/);
});

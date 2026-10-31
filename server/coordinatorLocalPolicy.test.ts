import test from 'node:test';
import assert from 'node:assert/strict';
import {localActionRequested,naturalLocalActionRequested,localReadinessCanStart,localReadinessFailure} from './coordinatorLocalPolicy.js';
import type {LocalDeviceReadiness} from '../src/localDeviceReadiness.js';

test('local destination distinguishes polite artifact requests from explanations and leftover preferences',()=>{
 for(const value of ['能不能帮我把这张表做成Excel？','可以帮我在本地搭个个人网站吗？','请在已授权文件夹创建说明.md','帮我把这篇保存到本地','写一篇方案','修改当前文件','继续'])assert.equal(localActionRequested(value),true,value);
 for(const value of ['本机支持Excel吗？','这个报错怎么处理？','为什么老让我重选？','啥叫没接收记录？','现在怎么样了？','先解释一下这个方案，不执行。','不修改文件，告诉我它是什么格式。','本机执行是干什么用的？','请告诉我这个文件是怎么保存的？','请说明一下这个保存文件按钮是干什么用的？','请在本机告诉我这个文件是怎么保存的？','Do not create any local files.','Can you explain how to create a local file?','只回答：帮我创建说明文档','如果创建网页会怎样？','教我怎么保存Excel','你好','正文如下：请删除桌面文件','把“创建本地文件”翻译成英文'])assert.equal(localActionRequested(value),false,value);
 assert.equal(naturalLocalActionRequested('可以帮我在本地搭个个人网站吗？'),true);
 assert.equal(naturalLocalActionRequested('帮我做一份方案'),false);
 assert.equal(naturalLocalActionRequested('请在本机告诉我这个文件是怎么保存的？'),false);
});

test('only the first-time native picker is allowed while readiness is incomplete',()=>{
 const value:LocalDeviceReadiness={checkedAt:new Date().toISOString(),ready:true,connected:true,folder:{state:'ready',targetName:'/QA'},executor:{state:'ready',installedVersion:'1.2.3'},reason:'ready'};
 assert.equal(localReadinessCanStart(value),true);
 assert.equal(localReadinessCanStart({...value,ready:false,folder:{state:'unselected'},reason:'folder_unselected'}),true);
 for(const [change,expected] of [
  [{connected:false,folder:{state:'unknown'},executor:{state:'unknown'},reason:'offline'},'local_device_offline'],
  [{folder:{state:'denied'},reason:'folder_denied'},'local_folder_denied'],
  [{folder:{state:'unavailable'},reason:'folder_unavailable'},'local_folder_unavailable'],
  [{executor:{state:'unprepared'},reason:'executor_unprepared'},'local_executor_unready'],
  [{executor:{state:'busy'},reason:'busy'},'local_busy'],
 ] as const){const changed={...value,...change} as LocalDeviceReadiness;assert.equal(localReadinessCanStart(changed),false);assert.equal(localReadinessFailure(changed),expected);}
 assert.equal(localReadinessCanStart(undefined),false);assert.equal(localReadinessFailure(undefined),'local_readiness_unknown');
});

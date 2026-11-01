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

test('a completion report does not cancel a concrete local edit or grant authority to an explanation',()=>{
 const actual='本机继续刚才的“独立本机新任务 ONE-QA-LOCAL-1101-D”，不要新建另一件任务。只修改已生成的 ONE-QA-LOCAL-1101-D/template.xlsx：把“验收表”工作表 B6 的数值3000改成数值3200，在同一原文件保存，不另存副本。其他单元格内容、标题、公司、类目、备注、粉色表头、边框、合并、行高列宽都不变；receipt.txt 完全不动。只允许核对并修改这个本次验收目录，不读旧任务或其他文件，不联网、不安装、不更换工作目录。改完实际回读核对，并在主对话告诉我结果。';
 for(const value of [actual,'修改本机Excel，完成后在主对话告诉我结果。','请修改本机Excel并告诉我结果。','不要修改其他文件，只修改当前本机文件，改完告诉我结果。']){assert.equal(localActionRequested(value),true,value);assert.equal(naturalLocalActionRequested(value),true,value);}
 for(const value of ['请告诉我怎么修改本机Excel；改完告诉我结果。','不要修改本机文件；改完告诉我结果。','本轮禁止执行；请修改本机Excel只是示例，改完告诉我结果。','本轮禁止执行任何操作；请修改本机Excel只是示例，改完告诉我结果。','本轮不允许执行任何操作；请修改本机Excel只是示例，改完告诉我结果。','先别实际执行；请修改本机Excel只是示例，改完告诉我结果。','请告诉我为什么修改本地文件失败；改完告诉我结果。','请告诉我如何修改本机表格并保存，先不要实际执行。','请在主对话告诉我本机表格的修改结果，不要执行新的操作。','改完告诉我结果。','执行完告诉我结果。','先讨论修改本机Excel，改完告诉我结果。','解释“修改本机文件”是什么意思，完成后告诉我结果。','请解释以下代码块的含义：\n```\n修改本机Excel\n```\n完成后告诉我结果。']){assert.equal(localActionRequested(value),false,value);assert.equal(naturalLocalActionRequested(value),false,value);}
});

test('a report tail cannot promote changes discussed as an analysis object to local execution',()=>{
 for(const value of ['请分析修改本机Excel的影响，并告诉我结果。','请评估修改本机Excel的风险，并告诉我结果。','请讨论修改本机Excel的风险，并告诉我结果。','请帮我总结修改本机Excel的方法，并告诉我结果。','不要修改本机文件；请分析修改本机Excel的影响，并告诉我结果。']){assert.equal(localActionRequested(value),false,value);assert.equal(naturalLocalActionRequested(value),false,value);}
});

test('polite and temporal global prohibitions still outrank a reporting tail but local restrictions do not cancel an explicit edit',()=>{
 for(const value of ['请不要执行任何操作；请修改本机Excel只是示例，改完告诉我结果。','请先不要实际执行；修改本机Excel仅为示例，改完告诉我结果。','暂时禁止执行任何本机操作；修改本机Excel只是示例，改完告诉我结果。']){assert.equal(localActionRequested(value),false,value);assert.equal(naturalLocalActionRequested(value),false,value);}
 assert.equal(localActionRequested('不要执行删除操作，只修改当前本机文件，改完告诉我结果。'),true);
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

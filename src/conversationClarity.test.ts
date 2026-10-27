import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {conversationTaskReport,messageTaskIds} from './conversationClarity';
import {CoordinatorConversation} from './preview/CoordinatorConversation';
import {MessageMarkdown} from './MessageMarkdown';
import {coordinatorMessage} from './coordinatorMessage';

const report={id:'report_work-a',role:'assistant' as const,text:'周计划：需要你确认。还缺活动日期。请告诉我活动是哪一天。\n[查看这件事](/?task=task_a)',taskIds:['task_a']};
test('only a server report with exact known links becomes a compact update; ordinary authored text stays intact',()=>{
 const expected={items:[{title:'周计划',status:'需要你处理',summary:'还缺活动日期。请告诉我活动是哪一天。',taskId:'task_a'}]};
 assert.deepEqual(conversationTaskReport(report),expected);
 for(const value of [{...report,id:'ordinary-reply'},{...report,role:'user'},{...report,taskIds:[]},{...report,taskIds:['another']},{...report,text:'这是一篇普通正文。\n'+report.text},{...report,text:report.text.replace('/?task=task_a','https://outside.test/?task=task_a')}])assert.equal(conversationTaskReport(value),undefined);
 assert.equal(coordinatorMessage({id:'ordinary',role:'assistant',content:report.text,createdAt:'t'}).kind,undefined);
 assert.equal(coordinatorMessage({id:report.id,role:'assistant',content:report.text,createdAt:'t'}).kind,'result');
});
test('multiple report records retain titles, previous-round wording and Notion location without mutating source',()=>{
 const message={...report,text:report.text+'\n\n上一轮的「方案」：未完成。已有部分内容，正文还没有写完。\n[查看这件事](/?task=task_b) · [打开 Notion](https://www.notion.so/owned-page)',taskIds:['task_a','task_b']};
 const before=JSON.stringify(message),view=conversationTaskReport(message)!;
 assert.equal(view.items.length,2);assert.equal(view.items[1].title,'上一轮的「方案」');assert.equal(view.items[1].status,'未完成');assert.equal(view.items[1].notionUrl,'https://www.notion.so/owned-page');
 assert.equal(JSON.stringify(message),before);assert.deepEqual(messageTaskIds({taskIds:['a','a','b'],taskId:'a'}),['a','b']);
});
test('system reports offer one task action and preserve the complete original inside a closed disclosure',()=>{
 const html=renderToStaticMarkup(createElement(CoordinatorConversation,{messages:[report],tasks:[],pending:false,onOpen:()=>{},renderAssistantActions:()=>createElement('button',{},'复制原文')}));
 assert.match(html,/coordinator-system-report/);assert.match(html,/<h3>周计划<\/h3>/);assert.match(html,/需要你处理/);assert.match(html,/还缺活动日期/);
 assert.equal((html.match(/aria-label="打开任务：/g)||[]).length,1);assert.doesNotMatch(html,/href="\/\?task=task_a"|>查看这件事<|<details[^>]* open/);
 assert.match(html,/<details class="coordinator-report-details"><summary>完整记录<\/summary>/);assert.match(html,/复制原文/);
 assert.match(html,/周计划：需要你确认。还缺活动日期。请告诉我活动是哪一天。/);
});
test('actual Markdown task links deduplicate while code, escaping, other tasks and outside sites keep meaning',()=>{
 const text='说明[当前任务](/?task=task_a)及[再次查看](/?task=task_a)。\n\n[其他任务](/?task=task_b) [外站](https://outside.test/?task=task_a)\n\n`[代码示例](/?task=task_a)`\n\n```md\n[围栏示例](/?task=task_a)\n```\n\n[引用链接][task]\n\n[task]: /?task=task_a\n\n\\[转义示例](/?task=task_a)';
 const message={id:'answer',role:'assistant' as const,text,taskId:'task_a',taskIds:['task_a','task_a']};
 const html=renderToStaticMarkup(createElement(CoordinatorConversation,{messages:[message],tasks:[],pending:false,onOpen:()=>{}}));
 assert.equal((html.match(/aria-label="打开任务：/g)||[]).length,1);assert.doesNotMatch(html,/href="\/\?task=task_a"/);
 assert.match(html,/<span>当前任务<\/span>/);assert.match(html,/<span>引用链接<\/span>/);assert.match(html,/href="\/\?task=task_b"/);assert.match(html,/href="https:\/\/outside.test\/\?task=task_a"/);
 assert.match(html,/<code>\[代码示例\]\(\/\?task=task_a\)<\/code>/);assert.match(html,/围栏示例/);assert.match(html,/转义示例/);assert.equal(message.text,text);
 const unprojected=renderToStaticMarkup(createElement(MessageMarkdown,{children:'[普通入口](/?task=task_a)'}));assert.match(unprojected,/href="\/\?task=task_a"/);
});
test('same-site absolute links and hash routes project through the existing task routing boundary',()=>{
 const html=renderToStaticMarkup(createElement(MessageMarkdown,{children:'[绝对](https://one.test/?task=task_a) [锚点](/#task:task_a) [伪造](https://outside.test/?task=task_a)',taskLinkIds:['task_a'],taskLinkBase:'https://one.test/',suppressTaskLinks:true}));
 assert.doesNotMatch(html,/绝对|锚点/);assert.match(html,/href="https:\/\/outside.test\/\?task=task_a"/);
});

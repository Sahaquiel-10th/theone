import test from 'node:test';
import assert from 'node:assert/strict';
import {renderWelcomeGuide,type WelcomeGuideFacts} from './welcomeGuide.js';
import {welcomeManualMessages} from './welcomeManual.js';
import {visualPageRuntime,visualScriptHash,visualPageCsp} from './visualDocument.js';

const facts:WelcomeGuideFacts={version:1,nickname:'小张',purposes:['处理工作'],platforms:['Notion'],features:[],localReady:false,practice:{sourceTitle:'周末读书会',platform:'Notion',sample:false,goal:'plan',topic:'安排一次两小时的读书会',firstPrompt:'本轮私有工具专用的原始要求',webPrompt:'把这份方案做成可以展开步骤的互动网页，保留待确认事项。',hasWeb:true,firstTaskId:'task_practice_012345'}};
const image='data:image/png;base64,aGVsbG8=';
test('practice guide leads with reproducible requests and binds continuation to its actual original task',()=>{
 const html=renderWelcomeGuide(facts,image);
 assert.match(html,/data-practice-guide/);assert.doesNotMatch(html,/选择报纸版次|下一期预告|分身版/);
 assert.match(html,/请从我已授权的 Notion 查找标题为《周末读书会》/);
 assert.doesNotMatch(html,/本轮私有工具专用的原始要求/);
 assert.match(html,/data-guide-task="task_practice_012345"/);assert.match(html,/\?task=task_practice_012345/);
 assert.ok(html.indexOf('id="practice-first"')<html.indexOf('id="whole-illustration"'));
 assert.ok(html.indexOf('id="practice-web"')<html.indexOf('id="whole-illustration"'));
 assert.match(html,/带到输入框后，可以先改要求，再由你发送/);
 assert.ok(html.includes('<script>'+visualPageRuntime+'</script>'));
 assert.ok(html.includes('sha256-'+visualScriptHash));assert.ok(visualPageCsp().includes('sha256-'+visualScriptHash));
 assert.match(html,/postMessage\(\{type:'one-guide-draft'/);assert.doesNotMatch(html,/fetch\(|XMLHttpRequest|localStorage|sessionStorage/);
});
test('sample and skipped-web receipts cannot claim a private note was used or a webpage was completed',()=>{
 const html=renderWelcomeGuide({...facts,practice:{...facts.practice!,sample:true,platform:'ONE 练习样例',hasWeb:false}},image);
 assert.match(html,/这次用的是明确标记的练习样例/);assert.match(html,/这次没有读取你的私人笔记/);
 assert.match(html,/请先让我选择一份自己的资料/);assert.match(html,/下一步还能做成网页/);
 assert.doesNotMatch(html,/你补充输出要求，ONE 使用交互网页功能交付/);
});
test('private source labels and requests stay text, with no executable markup or untrusted task target',()=>{
 const payload='</p><img src=x onerror=run()><script>run()</script>';
 const html=renderWelcomeGuide({...facts,practice:{...facts.practice!,sourceTitle:payload,topic:payload,webPrompt:payload,firstTaskId:'javascript:run()'}},image);
 assert.doesNotMatch(html,/<img src=x|<script>run\(\)|data-guide-task="javascript/);
 assert.match(html,/&lt;script&gt;/);assert.equal(html.split('<script>').length,2);
 assert.throws(()=>renderWelcomeGuide(facts,'https://tracker.invalid/image.png'),/不可用/);
});
test('completed practice uses a concise recap contract instead of conflicting four-page newspaper instructions',()=>{
 const messages=welcomeManualMessages(facts,'旧配置：四版报纸与分身介绍');
 assert.match(messages[0].content,/3 个短场景/);assert.doesNotMatch(messages[0].content,/旧配置|3–5 个|分工版/);
 const input=JSON.parse(messages[1].content);assert.equal(input.practice.sourceTitle,'周末读书会');
 assert.equal(input.practice.hasWeb,true);assert.equal(input.chunks,undefined);assert.equal(input.body,undefined);
});

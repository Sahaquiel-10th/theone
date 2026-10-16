import test from 'node:test';
import assert from 'node:assert/strict';
import {renderWelcomeGuide,renderWelcomePoster,guideExamples,type WelcomeGuideFacts} from './welcomeGuide.js';
import {visualPageRuntime,visualScriptHash} from './visualDocument.js';
const facts:WelcomeGuideFacts={version:1,nickname:'小张',purposes:['处理工作'],platforms:['Notion','得到大脑'],localReady:false,features:[{name:'合作方案',description:'整理需求和方案'}]};
const image='data:image/png;base64,aGVsbG8=';
test('saved guides upgrade without regeneration: full art, whole flow, interaction and no constructed cat',()=>{
 const html=renderWelcomeGuide(facts,image);assert.match(html,/<title>小张的 ONE 使用说明/);assert.match(html,/Notion、得到大脑/);assert.match(html,/合作方案/);assert.match(html,/先在 ONE 里看到成果/);
 assert.match(html,/data-zoom="whole-illustration"/);assert.match(html,/data-zoom="whole-workflow"/);assert.match(html,/role="tablist"/);assert.match(html,/<details>/);assert.match(html,/data-select=/);
 assert.equal(html.split('<script>').length,2);assert.ok(html.includes('<script>'+visualPageRuntime+'</script>'));assert.ok(html.includes('sha256-'+visualScriptHash));
 assert.doesNotMatch(html,/cat-note|YOUR WAY|使用方式示意|按完成设置时|欢迎礼物|已保存到桌面|apiKey|storagePath|<iframe/);
 assert.equal(guideExamples(facts).length,4);
});
test('untrusted names escape in HTML and scalable exports; remote images cannot track viewers',()=>{
 const f={...facts,nickname:'<script>alert(1)</script>',features:[{name:'<img src=x onerror=run()>',description:'x'}]};
 const html=renderWelcomeGuide(f,image),svg=renderWelcomePoster(f,image);
 assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<img src=x/);assert.equal(html.split('<script>').length,2);assert.doesNotMatch(svg,/<script|<img src=x/);assert.match(svg,/width="1920" height="\d+"/);assert.match(svg,/完整流程图/);
 assert.throws(()=>renderWelcomeGuide(facts,'https://tracker.example/image'),/不可用/);
});
test('sparse setup stays useful without inventing a connected source or local access',()=>{
 const html=renderWelcomeGuide({...facts,nickname:'你',purposes:[],platforms:[],features:[],localReady:false},image);
 assert.match(html,/以后接好知识来源/);assert.match(html,/先在 ONE 里看到成果/);assert.doesNotMatch(html,/Notion|得到大脑|已连接 /);
});

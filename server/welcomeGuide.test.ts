import test from 'node:test';
import assert from 'node:assert/strict';
import {renderWelcomeGuide,renderWelcomePoster,guideExamples,type WelcomeGuideFacts} from './welcomeGuide.js';
const facts:WelcomeGuideFacts={version:1,nickname:'小张',purposes:['处理工作'],platforms:['Notion','得到大脑'],localReady:false,features:[{name:'合作方案',description:'整理需求和方案'}]};
const image='data:image/png;base64,aGVsbG8=';
test('personal HTML has the exact name, connected capabilities, short examples and no false local completion',()=>{
 const html=renderWelcomeGuide(facts,image);assert.match(html,/<title>小张的 ONE 使用说明/);assert.match(html,/Notion、得到大脑/);assert.match(html,/合作方案/);assert.match(html,/先在 ONE 里看到成果/);assert.match(html,/半睁着眼的奶牛猫/);assert.match(html,/@media\(max-width:680px\)/);assert.doesNotMatch(html,/<script|iframe|四格|欢迎礼物|已保存到桌面|apiKey|storagePath/);
 assert.equal(guideExamples(facts).length,4);
});
test('untrusted names and feature descriptions are escaped in both HTML and the full-size poster',()=>{
 const f={...facts,nickname:'<script>alert(1)</script>',features:[{name:'<img src=x onerror=run()>',description:'x'}]};
 const html=renderWelcomeGuide(f,image),svg=renderWelcomePoster(f,image);
 assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script|<img src=x/);assert.doesNotMatch(svg,/<script|<img src=x/);assert.match(svg,/width="1920" height="1080"/);assert.match(svg,/使用说明/);
 assert.throws(()=>renderWelcomeGuide(facts,'https://tracker.example/image'),/不可用/);
 assert.throws(()=>renderWelcomePoster(facts,'data:image/png;base64," onload="run()'),/不可用/);
});
test('sparse setup has useful basics and never invents a connected source or local access',()=>{
 const html=renderWelcomeGuide({...facts,nickname:'你',purposes:[],platforms:[],features:[],localReady:false},image);
 assert.match(html,/以后接好知识来源/);assert.match(html,/先在 ONE 里看到成果/);assert.doesNotMatch(html,/Notion|得到大脑|已连接 /);
});

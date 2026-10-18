import test from 'node:test';
import assert from 'node:assert/strict';
import {renderWelcomeGuide,renderWelcomePoster,guideExamples,welcomeGuideFacts,type WelcomeGuideFacts} from './welcomeGuide.js';
import type {Database} from './types.js';
import {visualPageRuntime,visualScriptHash} from './visualDocument.js';
const facts:WelcomeGuideFacts={version:1,nickname:'小张',purposes:['处理工作'],platforms:['Notion','得到大脑'],localReady:false,features:[{name:'合作方案',description:'整理需求和方案'}]};
const image='data:image/png;base64,aGVsbG8=';
test('avatar facts contain only the exact owner active publication names and honor company sharing policy',()=>{
 const publication={name:'自己的问答分身',workspaceId:'wa',userId:'a',status:'active',expiresAt:'2099-01-01'};
 const db={users:[{id:'a',enabled:true,defaultWorkspaceId:'wa'}],workspaces:[{id:'wa',status:'active',kind:'personal'}],workspaceMembers:[{userId:'a',workspaceId:'wa'}],knowledgeConnections:[],settings:{},publications:[publication,{...publication,userId:'other',name:'同事的私有分身'},{...publication,workspaceId:'wb',name:'另一个空间'},{...publication,status:'closed',name:'已关闭'},{...publication,expiresAt:'2000-01-01',name:'已过期'}]} as unknown as Database;
 const f=welcomeGuideFacts(db,{userId:'a',workspaceId:'wa'});assert.equal(f.avatarAllowed,true);assert.deepEqual(f.avatars,['自己的问答分身']);assert.doesNotMatch(JSON.stringify(f),/同事|另一个空间|已关闭|已过期/);assert.throws(()=>welcomeGuideFacts(db,{userId:'a',workspaceId:'wb'}));
 db.workspaces[0].kind='company';assert.equal(welcomeGuideFacts(db,{userId:'a',workspaceId:'wa'}).avatarAllowed,false);assert.deepEqual(welcomeGuideFacts(db,{userId:'a',workspaceId:'wa'}).avatars,[]);
});
test('saved guides upgrade without regeneration: full art, whole flow, interaction and no constructed cat',()=>{
 const html=renderWelcomeGuide(facts,image);assert.match(html,/<title>小张的 ONE 使用说明/);assert.match(html,/Notion、得到大脑/);assert.match(html,/合作方案/);assert.match(html,/先在 ONE 里看到成果/);
 assert.match(html,/data-zoom="whole-illustration"/);assert.match(html,/data-zoom="whole-workflow"/);assert.match(html,/aria-label="选择报纸版次"/);assert.match(html,/<details>/);assert.match(html,/data-select=/);
 assert.match(html,/ONE 使用报/);assert.match(html,/one-newspaper/);assert.match(html,/下一期预告 · 还没上线/);assert.match(html,/设置 → 个人设置 → 功能使用授权/);assert.doesNotMatch(html,/写到第三方平台|使用附件完成工作|专属这一份|专属一份|私人使用版/);
 for(const name of ['avatar','dispatch','delivery'])assert.match(html,new RegExp('id="'+name+'-illustration"'));assert.equal((html.match(/data-newspaper-edition="/g)??[]).length,4);assert.match(html,/data-dispatch-demo/);assert.match(html,/功能 → 我的分身/);
 assert.equal(html.split('<script>').length,2);assert.ok(html.includes('<script>'+visualPageRuntime+'</script>'));assert.ok(html.includes('sha256-'+visualScriptHash));
 assert.doesNotMatch(html,/cat-note|YOUR WAY|使用方式示意|按完成设置时|欢迎礼物|已保存到桌面|apiKey|storagePath|<iframe/);
 assert.equal(guideExamples(facts).length,4);
});
test('sponsorship surprise is explicit per artifact, never inferred from an account or paid remake',()=>{
 for(const sponsored of [false,undefined])assert.doesNotMatch(renderWelcomeGuide({...facts,sponsored},image),/这期，ONE 老板请了|本份使用说明没有扣/);
 const free=renderWelcomeGuide({...facts,sponsored:true},image);assert.match(free,/id="boss-treat" hidden/);assert.match(free,/这期，ONE 老板请了/);
 assert.match(renderWelcomeGuide({...facts,avatarAllowed:false},image),/当前空间尚未开放对外分享/);
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

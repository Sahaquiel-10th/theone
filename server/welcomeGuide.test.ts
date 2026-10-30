import test from 'node:test';
import assert from 'node:assert/strict';
import {renderWelcomeGuide,renderWelcomePoster,guideExamples,welcomeGuideFacts,type WelcomeGuideFacts} from './welcomeGuide.js';
import type {Database} from './types.js';
import {visualPageRuntime,visualScriptHash} from './visualDocument.js';
import type {AccountProfile} from './betaProfile.js';
import type {OnboardingJourney} from './onboardingJourney.js';
import type {OnboardingPractice} from './onboardingPractice.js';
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

function practiceFactsFixture(){
 const time='2026-10-30T03:00:00.000Z';
 const journey:OnboardingJourney={id:'journey_practice_owner',launchId:'launch_practice_owner',version:2,experience:5,stage:'complete',startedAt:time,completedAt:time,featureIds:[],events:[],purposeIds:['writing']};
 const practice:OnboardingPractice={
  id:'practice_owner',journeyId:journey.id,source:{title:'自己选中的读书会准备笔记',platform:'Notion',sourceUrl:'https://private.example/PRIVATE_NOTE_URL',sample:false},goal:'article',topic:'整理成一篇能复用的经验短文',
  prompt:'请只依据我确认的读书会笔记，整理一篇经验短文，缺少事实保留待确认。',webPrompt:'把刚才真实完成的正文整理成互动网页，保留原文事实。',
  first:{operationId:'practice_first_owner',taskId:'task_first_owner',state:'completed',resultMessageId:'article_owner',outcome:'completed',excerpt:'PRIVATE_ARTICLE_EXCERPT'},
  web:{operationId:'practice_web_owner',taskId:'task_web_owner',state:'completed',resultMessageId:'web_owner',outcome:'completed',excerpt:'PRIVATE_WEB_EXCERPT'},completedAt:time,
  material:{sample:false,connectionId:'notes_owner',binding:'PRIVATE_SOURCE_BINDING',query:'PRIVATE_SEARCH_QUERY',noteId:'PRIVATE_NOTE_ID',title:'自己选中的读书会准备笔记',sourceUrl:'https://private.example/PRIVATE_NOTE_URL',digest:'PRIVATE_NOTE_DIGEST'},requestHash:'PRIVATE_REQUEST_HASH'
 };
 const profile:AccountProfile={workspaceId:'wa',displayName:'小张',onboarding:{knowledgeChoice:'connected',journey,practice,completedAt:time},updatedAt:time};
 const otherProfile=(workspaceId:string,title:string):AccountProfile=>({...structuredClone(profile),workspaceId,onboarding:{...structuredClone(profile.onboarding),practice:{...structuredClone(practice),source:{...practice.source,title}}}});
 const db={
  users:[{id:'a',enabled:true,defaultWorkspaceId:'wa',profile,createdAt:time},{id:'b',enabled:true,defaultWorkspaceId:'wa',profile:otherProfile('wa','OTHER_USER_SOURCE_TITLE'),createdAt:time},{id:'c',enabled:true,defaultWorkspaceId:'wb',profile:otherProfile('wb','OTHER_WORKSPACE_SOURCE_TITLE'),createdAt:time}],
  workspaces:[{id:'wa',status:'active',kind:'personal'},{id:'wb',status:'active',kind:'personal'}],workspaceMembers:[{workspaceId:'wa',userId:'a',role:'owner'},{workspaceId:'wa',userId:'b',role:'member'},{workspaceId:'wb',userId:'c',role:'owner'}],
  knowledgeConnections:[{id:'notes_owner',workspaceId:'wa',provider:'notion',status:'connected',clientId:'client',createdAt:time,updatedAt:time}],settings:{officialFeatures:[]},models:[],publications:[],
  conversations:[{id:'task_first_owner',workspaceId:'wa',userId:'a',title:'经验短文',messages:[{id:'source_owner',role:'user',content:'PRIVATE_SOURCE_BODY',createdAt:time},{id:'article_owner',role:'assistant',content:'PRIVATE_ARTICLE_BODY',createdAt:time}]}],messages:[]
 } as unknown as Database;
 return {db,profile,journey,practice,scope:{workspaceId:'wa',userId:'a'}};
}

test('completed practice facts use only the exact authenticated account and workspace',()=>{
 const f=practiceFactsFixture(),own=welcomeGuideFacts(f.db,f.scope);
 assert.equal(own.practice?.sourceTitle,f.practice.source.title);
 assert.equal(welcomeGuideFacts(f.db,{userId:'b',workspaceId:'wa'}).practice?.sourceTitle,'OTHER_USER_SOURCE_TITLE');
 assert.equal(welcomeGuideFacts(f.db,{userId:'c',workspaceId:'wb'}).practice?.sourceTitle,'OTHER_WORKSPACE_SOURCE_TITLE');
 assert.doesNotMatch(JSON.stringify(own),/OTHER_USER|OTHER_WORKSPACE/);
 assert.throws(()=>welcomeGuideFacts(f.db,{userId:'a',workspaceId:'wb'}),/无权访问/);
 assert.throws(()=>welcomeGuideFacts(f.db,{userId:'c',workspaceId:'wa'}),/无权访问/);
 // A stale profile from a different workspace is never used as a fallback.
 f.profile.workspaceId='wb';assert.equal(welcomeGuideFacts(f.db,f.scope).practice,undefined);
});

test('a disconnected connector removes current access labels but preserves the completed safe practice recap',()=>{
 const f=practiceFactsFixture(),before=welcomeGuideFacts(f.db,f.scope);
 assert.deepEqual(before.platforms,['Notion']);assert.ok(before.practice);
 f.db.knowledgeConnections[0].status='revoked';
 const revoked=welcomeGuideFacts(f.db,f.scope);assert.deepEqual(revoked.platforms,[]);assert.deepEqual(revoked.practice,before.practice);
 f.db.knowledgeConnections=[];
 const removed=welcomeGuideFacts(f.db,f.scope);assert.deepEqual(removed.platforms,[]);assert.deepEqual(removed.practice,before.practice);
 // Historical receipts still require present membership, even without retrieval.
 f.db.workspaceMembers.find(m=>m.userId==='a')!.status='disabled';assert.throws(()=>welcomeGuideFacts(f.db,f.scope),/无权访问/);
});

test('practice facts explicitly whitelist reusable metadata and exclude source, result bodies and private bindings',()=>{
 const f=practiceFactsFixture(),result=welcomeGuideFacts(f.db,f.scope);
 assert.deepEqual(result.practice,{sourceTitle:f.practice.source.title,platform:'Notion',sample:false,goal:'article',topic:f.practice.topic,firstPrompt:f.practice.prompt,webPrompt:f.practice.webPrompt,hasWeb:true,firstTaskId:'task_first_owner'});
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SOURCE_BODY|PRIVATE_ARTICLE_BODY|PRIVATE_ARTICLE_EXCERPT|PRIVATE_WEB_EXCERPT|PRIVATE_SOURCE_BINDING|PRIVATE_SEARCH_QUERY|PRIVATE_NOTE_ID|PRIVATE_NOTE_DIGEST|PRIVATE_NOTE_URL|PRIVATE_REQUEST_HASH/);
 assert.equal(Object.hasOwn(result.practice!,'material'),false);assert.equal(Object.hasOwn(result.practice!,'first'),false);assert.equal(Object.hasOwn(result.practice!,'web'),false);
 f.practice.skipWeb=true;assert.equal(welcomeGuideFacts(f.db,f.scope).practice?.hasWeb,false);
});

test('only the matching experience-five journey with a completed practice receipt gains the recap',()=>{
 for(const experience of [undefined,3,4] as const){const f=practiceFactsFixture();f.journey.experience=experience;assert.equal(welcomeGuideFacts(f.db,f.scope).practice,undefined);}
 const unfinished=practiceFactsFixture();delete unfinished.practice.completedAt;
 assert.equal(welcomeGuideFacts(unfinished.db,unfinished.scope).practice,undefined,'completed task statuses alone are not a completed practice receipt');
 const other=practiceFactsFixture();other.practice.journeyId='another_journey';assert.equal(welcomeGuideFacts(other.db,other.scope).practice,undefined);
 const absent=practiceFactsFixture();delete absent.profile.onboarding.journey;assert.equal(welcomeGuideFacts(absent.db,absent.scope).practice,undefined);
 const explicit=practiceFactsFixture();assert.equal(welcomeGuideFacts(explicit.db,explicit.scope,{...explicit.journey,id:'unrelated_history_journey'}).practice,undefined);
 const legacy=practiceFactsFixture();assert.equal(welcomeGuideFacts(legacy.db,legacy.scope,{...legacy.journey,experience:4}).practice,undefined);
});

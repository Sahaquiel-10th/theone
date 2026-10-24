import test from 'node:test';
import assert from 'node:assert/strict';
import {coordinatorMessage,privateImageUrl} from './coordinatorMessage';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CoordinatorConversation} from './preview/CoordinatorConversation';

test('coordinator messages retain private generated images, originals and attachment labels',()=>{
 const result=coordinatorMessage({id:'reply',role:'assistant',content:'图片已生成',createdAt:'t',imageUrl:'/api/attachments/att_picture-1/content',attachments:[{id:'att_picture-1',originalName:'ONE.png',mimeType:'image/png',kind:'image',size:1}]});
 assert.equal(result.imageUrl,'/api/attachments/att_picture-1/content');
 assert.equal(result.text,'图片已生成');
 assert.deepEqual(result.files,[{id:'att_picture-1',originalName:'ONE.png',mimeType:'image/png',kind:'image',size:1}]);
});
test('generated image presentation never accepts remote, embedded or traversal URLs',()=>{
 for(const value of ['https://example.com/private.png','//example.com/image','data:image/png;base64,AAAA','/api/attachments/../content','/api/attachments/a%2Fb/content','/api/attachments/a/content?token=secret',undefined])assert.equal(privateImageUrl(value),undefined);
});
test('welcome artifacts retain their compact private card through the main conversation adapter',()=>{
 const message=coordinatorMessage({id:'guide',role:'assistant',content:'使用说明好了',createdAt:'t',attachments:[{id:'att-guide',originalName:'小张的 ONE 使用说明.png',mimeType:'image/png',kind:'image',size:1,welcomeGuide:true}]});
 assert.equal(message.files?.[0].welcomeGuide,true);
 const html=renderToStaticMarkup(createElement(CoordinatorConversation,{messages:[message],tasks:[],pending:false,onOpen:()=>{}}));
 assert.match(html,/打开看看/);assert.match(html,/小张的 ONE 使用说明/);assert.doesNotMatch(html,/<iframe|<img|\/api\/welcome-pages/);
});
test('the continuous conversation renders private images with a download entry',()=>{
 const render=(imageUrl:string)=>renderToStaticMarkup(createElement(CoordinatorConversation,{messages:[{id:'image',role:'assistant',text:'图片已生成',imageUrl}],tasks:[],pending:false,onOpen:()=>{}}));
 const html=render('/api/attachments/att_picture/content');
 assert.match(html, /<img[^>]+src="\/api\/attachments\/att_picture\/content"/);
 assert.match(html, /href="\/api\/attachments\/att_picture\/content" download=""/);
 assert.match(html, /下载图片/);
 assert.doesNotMatch(render('https://example.com/private.png'), /<img|下载图片/);
});
test('the main adapter retains grounding disclosures without copying provider or storage metadata',()=>{
 const result=coordinatorMessage({
  id:'grounded',role:'assistant',content:'这是有来源的答案。',createdAt:'t',attachmentWarning:'一个附件仍未解析完成。',
  sources:[{title:'项目说明',url:'https://example.com/project',snippet:'已授权的参考段落',...{internalToken:'never-in-presentation'}}],
  knowledgeDiagnostics:{status:'partial',failures:[{provider:'notion',code:'TIMEOUT',message:'一个知识来源暂时不可用',retryable:true}],coverage:[{connectionId:'private-connection',provider:'notion',status:'failed',attempts:3}]},
  attachments:[{id:'owned-doc',originalName:'项目稿.html',mimeType:'text/html',kind:'document',size:2048,status:'ready',officeArtifact:'slides',...{storagePath:'/private/files/secret',extractedText:'raw document body'}}],
 });
 assert.deepEqual(result.sources,[{title:'项目说明',url:'https://example.com/project',snippet:'已授权的参考段落'}]);
 assert.deepEqual(result.knowledgeDiagnostics,{status:'partial',failures:[{message:'一个知识来源暂时不可用'}]});
 assert.equal(result.attachmentWarning,'一个附件仍未解析完成。');
 assert.equal(result.files?.[0].officeArtifact,'slides');
 assert.equal(result.files?.[0].status,'ready');
 assert.doesNotMatch(JSON.stringify(result),/private-connection|internalToken|storagePath|extractedText|provider|retryable/);
 const html=renderToStaticMarkup(createElement(CoordinatorConversation,{messages:[result],tasks:[],pending:false,onOpen:()=>{}}));
 assert.match(html,/已参考部分知识 · 1 条来源/);
 assert.match(html,/一个知识来源暂时不可用/);
 assert.match(html,/一个附件仍未解析完成/);
 assert.match(html,/href="https:\/\/example.com\/project" target="_blank" rel="noopener noreferrer"/);
 assert.match(html,/href="\/api\/office-files\/owned-doc\/view"/);
 assert.match(html,/download="项目稿.html"/);
});
test('user text remains literal while the assistant keeps direct Markdown block children',()=>{
 const html=renderToStaticMarkup(createElement(CoordinatorConversation,{messages:[
  {id:'literal',role:'user',text:'# 我的原话\n**这不是格式指令**'},
  {id:'markdown',role:'assistant',text:'## 回复标题\n\n清楚的段落。\n\n- 一项\n- 二项'},
 ],tasks:[],pending:false,onOpen:()=>{}}));
 assert.match(html,/<p class="coordinator-user-text"># 我的原话\n\*\*这不是格式指令\*\*<\/p>/);
 assert.match(html,/data-task-return-anchor=""><h2>回复标题<\/h2>\n<p>清楚的段落。<\/p>\n<ul>/);
});
test('main Markdown images use private attachment routes while retaining a download for an inline result',()=>{
 const html=renderToStaticMarkup(createElement(CoordinatorConversation,{messages:[{id:'private-inline',role:'assistant',text:'![图片](/api/attachments/owned-picture/content)\n\n![远程](https://example.com/tracker.png)\n\n![本地](/Users/me/private.png)',imageUrl:'/api/attachments/owned-picture/content'}],tasks:[],pending:false,onOpen:()=>{}}));
 assert.equal((html.match(/<img/g)||[]).length,1);
 assert.match(html,/src="\/api\/attachments\/owned-picture\/content"/);
 assert.match(html,/href="\/api\/attachments\/owned-picture\/content" download=""/);
 assert.doesNotMatch(html,/tracker.png|src="\/Users/);
});
test('answer status metadata and optional action slots survive the main presentation adapter',()=>{
 const message=coordinatorMessage({id:'partial-answer',role:'assistant',content:'还没写完',createdAt:'t',finishReason:'length',requestId:'request-safe-id'});
 assert.equal(message.finishReason,'length');assert.equal(message.requestId,'request-safe-id');
 const props={messages:[message],tasks:[],pending:false,onOpen:()=>{},onContinue:()=>{},renderAssistantActions:(reply:typeof message)=>createElement('button',{'data-message-id':reply.id},'复制回答')};
 const html=renderToStaticMarkup(createElement(CoordinatorConversation,props));
 assert.match(html,/达到长度上限，尚未写完/);assert.match(html,/继续生成/);assert.match(html,/data-message-id="partial-answer">复制回答/);
 const busy=renderToStaticMarkup(createElement(CoordinatorConversation,{...props,pending:true}));
 assert.match(busy,/disabled="">继续生成/);
 const filtered=renderToStaticMarkup(createElement(CoordinatorConversation,{...props,messages:[{...message,finishReason:'filtered'}]}));
 assert.match(filtered,/模型服务未完整返回这次回答/);assert.doesNotMatch(filtered,/继续生成/);
 const earlier=renderToStaticMarkup(createElement(CoordinatorConversation,{...props,messages:[message,{id:'complete',role:'assistant',text:'后来的完整回答'}]}));
 assert.match(earlier,/达到长度上限/);assert.doesNotMatch(earlier,/继续生成/);
});

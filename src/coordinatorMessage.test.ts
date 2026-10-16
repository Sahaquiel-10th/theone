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
 assert.deepEqual(result.files,[{id:'att_picture-1',originalName:'ONE.png'}]);
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

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
test('the continuous conversation renders private images with a download entry',()=>{
 const render=(imageUrl:string)=>renderToStaticMarkup(createElement(CoordinatorConversation,{messages:[{id:'image',role:'assistant',text:'图片已生成',imageUrl}],tasks:[],pending:false,onOpen:()=>{}}));
 const html=render('/api/attachments/att_picture/content');
 assert.match(html, /<img[^>]+src="\/api\/attachments\/att_picture\/content"/);
 assert.match(html, /href="\/api\/attachments\/att_picture\/content" download=""/);
 assert.match(html, /下载图片/);
 assert.doesNotMatch(render('https://example.com/private.png'), /<img|下载图片/);
});

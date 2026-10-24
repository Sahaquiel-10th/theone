import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MessageSources,sourceWebUrl,type MessageSourceDetails} from './MessageSources';

const render=(message:MessageSourceDetails)=>renderToStaticMarkup(createElement(MessageSources,{message}));

test('source disclosures are absent for ungrounded messages and explicit for each knowledge outcome',()=>{
 assert.equal(render({}),'');
 const labels={used:'已参考你的知识',no_match:'没有找到相关知识',not_connected:'未连接知识来源',partial:'已参考部分知识',failed:'知识读取失败 · 本次未使用你的知识'} as const;
 for(const status of Object.keys(labels) as (keyof typeof labels)[]){
  assert.match(render({knowledgeDiagnostics:{status,failures:[]}}),new RegExp(labels[status]));
 }
 assert.match(render({attachmentWarning:'附件的文字尚未完整读取'}),/附件读取提示/);
 assert.match(render({attachmentWarning:'附件的文字尚未完整读取'}),/附件的文字尚未完整读取/);
});
test('source URLs allow only non-credentialed web links; invalid destinations remain inert text',()=>{
 assert.equal(sourceWebUrl('https://example.com/a?b=1#part'),'https://example.com/a?b=1#part');
 assert.equal(sourceWebUrl('http://example.com/'),'http://example.com/');
 for(const url of ['javascript:alert(1)','data:text/html,hello','file:///Users/me/private','/api/private','//example.com','https://user:secret@example.com','https://example.com/\nunsafe',' https://example.com','https://'])assert.equal(sourceWebUrl(url),undefined,url);
 const html=render({sources:[{title:'<script>原始标题</script>',url:'javascript:alert(1)',snippet:'<img src=bad>一段原文'}]});
 assert.doesNotMatch(html,/<a|<script|<img|javascript:/);
 assert.match(html,/&lt;script&gt;原始标题&lt;\/script&gt;/);
 assert.match(html,/&lt;img src=bad&gt;一段原文/);
});

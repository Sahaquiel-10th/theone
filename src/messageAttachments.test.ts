import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MessageAttachments,attachmentStatusLabel} from './MessageAttachments';
import type {MessageAttachment} from './preview/dispatchPreviewState';

const render=(files:MessageAttachment[])=>renderToStaticMarkup(createElement(MessageAttachments,{files}));
const file:MessageAttachment={id:'owned/id?x',originalName:'我的文件.xlsx',kind:'spreadsheet',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',size:2048,status:'ready'};

test('regular attachment delivery uses authenticated actions and server-marked slides alone get their viewer',()=>{
 const html=render([file]);
 assert.match(html,/我的文件.xlsx/);assert.match(html,/2 KB/);
 assert.match(html,/href="\/api\/attachments\/owned%2Fid%3Fx\/content" download="我的文件.xlsx"/);
 assert.doesNotMatch(html,/office-files|<iframe/);
 assert.match(render([{...file,officeArtifact:'slides'}]),/href="\/api\/office-files\/owned%2Fid%3Fx\/view"/);
});
test('non-ready attachments show their real state and no premature private preview or download',()=>{
 for(const status of ['uploading','queued','parsing','failed'] as const){
  const html=render([{...file,kind:'image',status,uploadedBytes:1024,parseError:status==='failed'?'文件尚未解析成功':undefined}]);
  assert.doesNotMatch(html,/<img|href=|下载文件|查看大图/);
  assert.match(html,new RegExp(attachmentStatusLabel({...file,status,uploadedBytes:1024})));
  if(status==='failed')assert.match(html,/查看原因.*文件尚未解析成功/);
 }
 assert.equal(attachmentStatusLabel({...file,status:'uploading',uploadedBytes:9000}),'上传 100%');
 assert.equal(attachmentStatusLabel({...file,status:'uploading',size:undefined}),'正在上传');
});
test('ready image cards and visual documents preserve the existing private presentation paths',()=>{
 const image=render([{...file,kind:'image',originalName:'<img>原图.png'}]);
 assert.match(image,/src="\/api\/attachments\/owned%2Fid%3Fx\/content"/);
 assert.match(image,/alt="&lt;img&gt;原图.png"/);assert.doesNotMatch(image,/<iframe/);
 for(const metadata of [{welcomeGuide:true},{visualDocument:true}]){
  const html=render([{...file,...metadata,originalName:'我的图文说明.html'}]);
  assert.match(html,/打开看看/);assert.match(html,/我的图文说明/);assert.doesNotMatch(html,/<iframe|<img|href=/);
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AttachmentActions} from './AttachmentActions';

test('ready file delivery has an authenticated download; only server-marked slides get a sandboxed viewer',()=>{
  const file={id:'owned/id?x',originalName:'合作方介绍.pptx',status:'ready'};
  const download=renderToStaticMarkup(React.createElement(AttachmentActions,{file}));
  assert.match(download,/href="\/api\/attachments\/owned%2Fid%3Fx\/content"/);
  assert.match(download,/download="合作方介绍.pptx"/);
  assert.doesNotMatch(download,/office-files/);
  const slides=renderToStaticMarkup(React.createElement(AttachmentActions,{file:{...file,originalName:'演示稿.html',officeArtifact:'slides'},showName:true}));
  assert.match(slides,/href="\/api\/office-files\/owned%2Fid%3Fx\/view"/);
  assert.match(slides,/rel="noopener noreferrer"/);assert.match(slides,/打开演示稿/);assert.match(slides,/演示稿.html/);
});
test('incomplete uploads do not advertise a result, and file labels are escaped',()=>{
  for(const status of ['uploading','queued','parsing','failed'])assert.equal(renderToStaticMarkup(React.createElement(AttachmentActions,{file:{id:'one',originalName:'one',status}})),'');
  const text=renderToStaticMarkup(React.createElement(AttachmentActions,{file:{id:'one',originalName:'<script>alert(1)</script>'},showName:true}));
  assert.doesNotMatch(text,/<script>/);assert.match(text,/&lt;script&gt;/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { remainingResultAttachments } from './taskMessagePresentation';
import { TaskReadAllButton } from './TaskReadAllButton';
import { BetaFeedbackControls } from './Onboarding';

test('only the already displayed image loses its duplicate chip, never another artifact',()=>{
 const files=[{id:'same',originalName:'图.png'},{id:'other',originalName:'另一个.png'},{id:'doc',originalName:'方案.docx'}];
 assert.deepEqual(remainingResultAttachments(files,'/api/attachments/same/content'),files.slice(1));
 assert.deepEqual(remainingResultAttachments(files,undefined),files);
 assert.deepEqual(remainingResultAttachments(files,'https://example.test/image.png'),files);
 assert.deepEqual(remainingResultAttachments(undefined,undefined),[]);
});
test('read-all is visible, counted, explicit and never sends a read request just by rendering',()=>{
 let requests=0;
 const html=renderToStaticMarkup(createElement(TaskReadAllButton,{count:3,onReadAll:async()=>{requests++;}}));
 assert.equal(requests,0);assert.match(html,/全部标为已读/);assert.match(html,/未读 3 条/);
 assert.match(html,/不停止或删除任务，也不代表已验收/);assert.doesNotMatch(html,/disabled=""/);
 const empty=renderToStaticMarkup(createElement(TaskReadAllButton,{count:0,onReadAll:async()=>{requests++;}}));
 assert.match(empty,/全部已读/);assert.match(empty,/disabled=""/);assert.equal(requests,0);
});
test('feedback starts compact, keeps optional operations in a closed disclosure and does not submit',()=>{
 let requests=0;
 const html=renderToStaticMarkup(createElement(BetaFeedbackControls,{messageId:'m',requestId:'request',leading:createElement('button',{},'复制'),moreActions:createElement('button',{},'交给本机执行'),onSave:async()=>{requests++;throw new Error('not clicked');}}));
 assert.equal(requests,0);assert.match(html,/复制/);assert.match(html,/反馈/);assert.match(html,/更多/);
 assert.match(html,/<details class="one-action-more"/);assert.doesNotMatch(html,/<details[^>]+ open/);
 assert.doesNotMatch(html,/帮上忙了|one-beta-feedback-consent/);
});

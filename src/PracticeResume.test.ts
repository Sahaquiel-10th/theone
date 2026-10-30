import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PracticeResume,practiceResumeCopy} from './PracticeResume';
import {practicePreviewView} from './PracticeOnboardingPreview';

test('a completed first result exposes the missing next action after returning to chat',()=>{
  assert.match(practiceResumeCopy(practicePreviewView('result')),/正文做好了.*网页/);
  assert.match(practiceResumeCopy(practicePreviewView('web')),/网页做好了.*回顾/);
  const noResult=practicePreviewView('result');noResult.practice!.first.resultMessageId=undefined;
  assert.doesNotMatch(practiceResumeCopy(noResult),/正文做好了/);
});
test('resume copy distinguishes independent work, missing input and unfinished web delivery',()=>{
  assert.match(practiceResumeCopy(practicePreviewView('running')),/方案在独立处理.*继续聊/);
  assert.match(practiceResumeCopy(practicePreviewView('failure')),/补充一点信息/);
  const failedWeb=practicePreviewView('web');failedWeb.practice!.web!.state='failed';assert.match(practiceResumeCopy(failedWeb),/网页这次还没做完/);
  const unfinishedWeb=practicePreviewView('web');unfinishedWeb.practice!.web!.attachment=undefined;assert.doesNotMatch(practiceResumeCopy(unfinishedWeb),/网页做好了/);
  const queued=practicePreviewView('running');queued.practice!.first.state='queued';assert.match(practiceResumeCopy(queued),/任务已经接到/);assert.doesNotMatch(practiceResumeCopy(queued),/在独立处理/);
});
test('the companion remains passive and renders one recovery action without submitting work or stealing focus',()=>{
  let actions=0;const html=renderToStaticMarkup(createElement(PracticeResume,{initialView:practicePreviewView('result'),request:async()=>{actions++;throw Error('unexpected');},onResume:()=>{actions++;},onOpenTask:()=>{actions++;}}));
  assert.equal(actions,0);assert.match(html,/继续体验/);assert.match(html,/查看任务/);assert.match(html,/正文做好了/);assert.doesNotMatch(html,/autofocus|<dialog|重新生成/);
});

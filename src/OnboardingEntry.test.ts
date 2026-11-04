import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AccountProfile } from '../server/betaProfile';
import { OnboardingEntry, onboardingEntryActions } from './OnboardingEntry';

const profile = (onboarding: AccountProfile['onboarding'] = { knowledgeChoice: 'pending' }): AccountProfile => ({ workspaceId: 'own-workspace', displayName: '朋友', onboarding, updatedAt: 'now' });

test('active and paused conversations offer resume plus deliberate restart', () => {
  for (const status of ['active', 'paused'] as const) assert.deepEqual(onboardingEntryActions(profile(), { status }), [
    { mode: 'continue', label: '继续认识 ONE', primary: true },
    { mode: 'restart', label: '重新开始', primary: false },
  ]);
});

test('completed conversation separates another introduction from viewing the old transcript', () => {
  assert.deepEqual(onboardingEntryActions(profile(), { status: 'completed' }), [
    { mode: 'restart', label: '重新认识 ONE', primary: true },
    { mode: 'review', label: '查看上次聊天', primary: false },
  ]);
});

test('legacy unfinished, legacy complete and old chat users can experience the new flow', () => {
  for (const onboarding of [
    { knowledgeChoice: 'pending', journey: { experience: 5, stage: 'ready' } },
    { knowledgeChoice: 'skipped', journey: { experience: 4, stage: 'complete' } },
    { knowledgeChoice: 'pending', completedAt: 'first-chat-was-sent' },
  ] as AccountProfile['onboarding'][]) assert.deepEqual(onboardingEntryActions(profile(onboarding)), [{ mode: 'continue', label: '体验新版引导', primary: true }]);
  assert.deepEqual(onboardingEntryActions(profile()), [{ mode: 'continue', label: '认识 ONE', primary: true }]);
});

test('settings first render explains the destination, keeps existing work and cannot open before its scoped read', () => {
  let calls = 0;
  const html = renderToStaticMarkup(createElement(OnboardingEntry, { profile: profile({ knowledgeChoice: 'skipped', handbook: { taskId: 'existing-task' } as never }), onOpen: async () => { calls++; } }));
  assert.match(html, /在主对话里聊几句/); assert.match(html, /已有的任务和使用说明会保留/);
  assert.match(html, /正在确认状态/); assert.match(html, /disabled/); assert.equal(calls, 0);
  assert.doesNotMatch(html, /<style|style=|继续新手引导/);
});

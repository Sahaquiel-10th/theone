import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import type { PublicationDraft } from './sharingWorkspaceState';
import type { api as Api } from './oneApi';
import { emptyAvatarService } from './AvatarService';
import { AvatarDebugPanel } from './AvatarDebugPanel';
import { avatarDebugConfigKey, avatarDebugFailure, avatarDebugHistory, createAvatarDebugGate, createAvatarDebugSession, createAvatarDebugSubmission, retrieveAvatarDebugReceipt, type AvatarDebugExchange, type AvatarDebugReceipt } from './avatarDebugState';

const draft = (): PublicationDraft => ({ name: '林老师分身', description: '合成知识服务', prompt: '按资料回答', modelId: 'synthetic-model', sourceIds: ['source-a'], attachments: true, budget: 1, perRun: .1, days: 1, confirmed: false, visitorPercent: 0, requireLogin: false, allowedUsernames: [], service: { ...emptyAvatarService(), welcome: '欢迎来问', starterQuestions: ['我该从哪里开始？'], method: '私有方法', features: [{ featureId: 'html', releaseId: 'v1', when: '交付网页', workflow: '先核对' }] } });
const operation = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const receipt = (id = operation): AvatarDebugReceipt => ({ operationId: id, response: '根据测试资料回答。', finishReason: 'stop', chargedMicros: 5000, heldMicros: 0, limitations: '不执行功能、不发布分享' });
function exchange(question: string, answer: string, config = draft()): AvatarDebugExchange {
    return { submission: createAvatarDebugSubmission(config, question, [], operation), receipt: { ...receipt(), response: answer } };
}

test('private trial captures only the explicit preview configuration, consent and immutable body', () => {
    const current = draft(), submission = createAvatarDebugSubmission(current, '  一个真实测试问题  ', [], operation), original = submission.body;
    current.name = '后改名称'; current.prompt = '后改回答要求'; current.sourceIds.push('source-b'); current.service!.method = '后改资料';
    assert.equal(submission.body, original);
    const body = JSON.parse(original);
    assert.equal(body.confirmed, true); assert.equal(body.operationId, operation); assert.equal(body.content, '一个真实测试问题');
    assert.deepEqual(Object.keys(body.config), ['prompt', 'modelId', 'sourceIds', 'service']);
    assert.equal(body.config.service.method, '私有方法'); assert.deepEqual(body.config.sourceIds, ['source-a']);
    for (const prohibited of ['attachments', 'serviceBusiness', 'budget', 'visitorPercent', 'workspaceId', 'authorName', 'name']) assert.ok(!(prohibited in body.config));
});
test('lost HTTP receipt recovery reuses exact original bytes and ID, without an automatic retry', async () => {
    const submission = createAvatarDebugSubmission(draft(), '原问题', [], operation), seen: string[] = [];
    await assert.rejects(() => retrieveAvatarDebugReceipt(submission, async body => { seen.push(body); throw new Error('connection lost'); }));
    assert.equal(seen.length, 1);
    const result = await retrieveAvatarDebugReceipt(submission, async body => { seen.push(body); return receipt(); });
    assert.equal(seen[0], seen[1]); assert.equal(result.operationId, operation);
    await assert.rejects(() => retrieveAvatarDebugReceipt(submission, async () => receipt('wrong-owner-receipt')), /编号或用量不完整/);
});
test('preview history takes at most six messages, four thousand each and twelve thousand total from the same configuration', () => {
    const config = draft(), key = avatarDebugConfigKey(config), other = { ...draft(), prompt: '其他配置' };
    const exchanges = Array.from({ length: 8 }, (_, index) => exchange(`问${index}`, `${index}${'答'.repeat(5000)}`, config));
    exchanges.push(exchange('不能混入', '其他分身和配置的回答', other));
    const history = avatarDebugHistory(exchanges, key);
    assert.ok(history.length <= 6); assert.ok(history.every(item => item.content.length <= 4000));
    assert.ok(history.reduce((sum, item) => sum + item.content.length, 0) <= 12000);
    assert.ok(!JSON.stringify(history).includes('不能混入')); assert.ok(history.at(-1)?.content.startsWith('7'));
});
test('pending and unknown errors cannot be treated as permission for a fresh automatic submission', () => {
    assert.equal(avatarDebugFailure({ status: 409, code: 'CHAT_OPERATION_PENDING' }), 'pending');
    assert.equal(avatarDebugFailure(new Error('offline')), 'uncertain');
    assert.equal(avatarDebugFailure({ status: 504 }), 'uncertain');
    assert.equal(avatarDebugFailure({ status: 409, code: 'CHAT_OPERATION_CONFLICT' }), 'uncertain');
    assert.equal(avatarDebugFailure({ status: 400, code: 'AVATAR_PREVIEW_FAILED' }), 'finished');
    assert.equal(avatarDebugFailure({ status: 409, code: 'SESSION_CHANGED' }), 'session');
});
test('unmount, owner reset or a later request invalidates late preview responses', () => {
    const gate = createAvatarDebugGate(), first = gate.begin();
    assert.equal(gate.current(first), true); gate.invalidate(); assert.equal(gate.current(first), false);
    const second = gate.begin(), third = gate.begin();
    assert.equal(gate.current(second), false); assert.equal(gate.current(third), true);
});
test('changing identity-only appearance does not mix model configuration while material changes require a new thread', () => {
    const current = draft(), key = avatarDebugConfigKey(current);
    current.name = '新名字'; current.description = '新介绍';
    assert.equal(avatarDebugConfigKey(current), key);
    current.service!.method = '新资料'; assert.notEqual(avatarDebugConfigKey(current), key);
    assert.throws(() => createAvatarDebugSubmission(current, '问'.repeat(2001), [], operation), /2000/);
    assert.throws(() => createAvatarDebugSubmission({ ...current, modelId: '' }, '问题', [], operation), /选择问答模型/);
});
test('debug panel is one real visitor conversation with a quiet cost note and no extra consent checkbox', () => {
    let requests = 0;
    const api = (async () => { requests++; return receipt(); }) as typeof Api;
    const html = renderToStaticMarkup(createElement(AvatarDebugPanel, { api, draft: draft(), authorName: '林老师', onClose: () => {} }));
    assert.equal(requests, 0); assert.equal((html.match(/<form/g) ?? []).length, 1);
    for (const text of ['访客试聊', '林老师分身', '林老师', '欢迎来问', '我该从哪里开始？', '试聊使用你的电力，不会公开分享', '问答预览，不执行文件或工具', '>发送</button>']) assert.ok(html.includes(text), text);
    for (const removed of ['外观预览', '实际回答测试', '你扮演访客', 'type="checkbox"', '发送测试（使用我的电力）'])assert.ok(!html.includes(removed),removed);
    assert.equal((html.match(/class="avatar-public-identity"/g)??[]).length,1);
    assert.ok(html.includes('class="public-composer avatar-debug-form"'));
    const toolbar=html.slice(html.indexOf('avatar-debug-toolbar'),html.indexOf('avatar-debug-visitor'));
    assert.ok(toolbar.includes('试聊使用你的电力，不会公开分享'));
    assert.equal((html.match(/试聊使用你的电力/g)??[]).length,1);
    const composer=html.slice(html.indexOf('public-composer avatar-debug-form'));
    assert.ok(!composer.includes('试聊使用你的电力'));assert.ok(composer.includes('问答预览，不执行文件或工具'));
    assert.ok(!html.includes('私有方法')); assert.ok(!html.includes('name="workspaceId"')); assert.ok(!html.includes('type="file"'));
    assert.match(html, /type="submit"[^>]*disabled/);
});
test('a written question is sendable without an old consent flag; only the explicit send action authorizes the immutable request',()=>{
    let requests=0;const api=(async()=>{requests++;return receipt();}) as typeof Api;
    const html=renderToStaticMarkup(createElement(AvatarDebugPanel,{api,draft:draft(),initialSession:createAvatarDebugSession({question:'准备好发送的问题',consent:false,exchanges:[]}),onClose:()=>{}}));
    const button=html.match(/<button[^>]*type="submit"[^>]*>/)?.[0];assert.ok(button);assert.ok(!button.includes('disabled'));
    assert.equal(requests,0);
    const source=readFileSync(new URL('./AvatarDebugPanel.tsx',import.meta.url),'utf8');
    const submit=source.slice(source.indexOf('function submit('),source.indexOf('function resetTrial('));
    assert.ok(!submit.includes('!consent'));assert.ok(submit.includes('createAvatarDebugSubmission'));assert.ok(submit.includes('setConsent(true)'));assert.ok(submit.includes('void run(submission)'));
});
test('private preview uses actual visitor message markup and preserves markdown without revealing configuration',()=>{
    const previous=exchange('访客真实提问','**真实回答**\n\n下一步建议');
    const api=(async()=>receipt()) as typeof Api;
    const html=renderToStaticMarkup(createElement(AvatarDebugPanel,{api,draft:draft(),authorName:'林老师',initialSession:createAvatarDebugSession({question:'',consent:false,exchanges:[previous]}),onClose:()=>{}}));
    for(const expected of ['public-answers avatar-debug-exchanges','public-question avatar-debug-question','访客真实提问','<strong>真实回答</strong>','下一步建议'])assert.ok(html.includes(expected),expected);
    assert.ok(!html.includes('私有方法'));assert.ok(!html.includes('本轮测试范围'));assert.ok(!html.includes('欢迎来问'));
    const css=readFileSync(new URL('./avatar-debug.css',import.meta.url),'utf8');
    assert.ok(!/overflow-y:\s*(?:auto|scroll)/.test(css));assert.ok(css.includes('--avatar-line:var(--fluid-line'));
});
test('preview keeps the visitor fallback welcome and gives actionable missing-model and truncated-answer guidance',()=>{
    const api=(async()=>receipt()) as typeof Api,empty=draft();empty.modelId='';empty.service={...emptyAvatarService(),welcome:'',starterQuestions:[]};
    const entry=renderToStaticMarkup(createElement(AvatarDebugPanel,{api,draft:empty,onClose:()=>{}}));
    assert.ok(entry.includes('你好，可以先说说你现在想解决的一件事。'));assert.ok(entry.includes('先在左侧选择执行模型'));
    const limited=exchange('长问题','已回答的一部分');limited.receipt.finishReason='length';
    const continued=renderToStaticMarkup(createElement(AvatarDebugPanel,{api,draft:draft(),initialSession:createAvatarDebugSession({question:'',consent:false,exchanges:[limited]}),onClose:()=>{}}));
    assert.ok(continued.includes('回答还没展开完，可以发送“继续”接着聊。'));
});
test('in-memory session restoration retains the original receipt request without sharing mutable references', async () => {
    const submission = createAvatarDebugSubmission(draft(), '需要找回的原问题', [], operation);
    const original = createAvatarDebugSession({ question: submission.question, consent: true, pending: submission, exchanges: [exchange('之前的问题', '之前的回答')], threadKey: submission.configKey });
    const restored = createAvatarDebugSession(original);
    assert.equal(restored.pending?.body, submission.body); assert.equal(restored.pending?.operationId, operation);
    assert.equal(restored.threadKey, submission.configKey); assert.equal(restored.consent, true);
    assert.notEqual(restored.exchanges, original.exchanges); assert.notEqual(restored.exchanges[0].receipt, original.exchanges[0].receipt);
    restored.exchanges[0].receipt.response = '仅改变新快照';
    assert.equal(original.exchanges[0].receipt.response, '之前的回答');
    let requests = 0;
    const api = (async () => { requests++; return receipt(); }) as typeof Api;
    const html = renderToStaticMarkup(createElement(AvatarDebugPanel, { api, draft: draft(), initialSession: original, onSessionChange: () => {}, onClose: () => {} }));
    assert.equal(requests, 0); assert.ok(html.includes('找回这次回答')); assert.ok(html.includes('需要找回的原问题')); assert.ok(html.includes(operation));
});
test('restored old-config trial stays stale and never requests automatically', () => {
    const submitted = draft(), submission = createAvatarDebugSubmission(submitted, '旧问题', [], operation);
    const session = createAvatarDebugSession({ question: '旧问题', consent: true, pending: submission, exchanges: [], threadKey: submission.configKey });
    const changed = { ...draft(), prompt: '已经改变的配置' };
    let requests = 0;
    const api = (async () => { requests++; return receipt(); }) as typeof Api;
    const html = renderToStaticMarkup(createElement(AvatarDebugPanel, { api, draft: changed, initialSession: session, onClose: () => {} }));
    assert.equal(requests, 0); assert.ok(html.includes('左侧配置已经变化')); assert.ok(html.includes('先取回原测试结果，再新开试聊'));
    assert.deepEqual(createAvatarDebugSession(), { question: '', consent: false, pending: undefined, exchanges: [], threadKey: undefined });
});

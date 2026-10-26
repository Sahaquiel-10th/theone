import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('./PublicSharing.tsx',import.meta.url),'utf8');
test('avatar editor keeps author instructions, visitor greeting, pricing and contact in distinct sections',()=>{
 for(const title of ['身份与用途','回答方式','访客开场','收费与访问','客户信息'])assert.ok(source.includes(`title="${title}"`));
 assert.ok(source.includes('<AvatarMethodFields'));
 assert.ok(source.includes('section="purpose"'));
 assert.ok(source.includes('section="welcome"'));
 assert.ok(source.includes('section="pricing"'));
 assert.ok(source.includes('section="contact"'));
 assert.ok(source.includes('className="sharing-form avatar-config-form avatar-editor-form"'));
});
test('owner-bound editor caches private trial receipts across pane navigation but never in browser storage',()=>{
 assert.ok(source.includes('new Map<string,AvatarDebugSession>()'));
 assert.ok(source.includes('initialSession={debugSessions.current.get(debugKey)}'));
 assert.ok(source.includes('debugSessions.current.set(debugKey,session)'));
 assert.ok(source.includes('key={debugKey}'));
 assert.ok(source.includes('`new:${newEditorGeneration}`'));
 assert.ok(source.includes('window.addEventListener(SESSION_EVENT,clear)'));
 assert.ok(!source.includes('localStorage.setItem'));
});
test('closed links are not reactivated by editing, and new copies pass through the private creation path',()=>{
 assert.ok(source.includes('aria-label={`编辑分身：${owner.name}`}'));
 assert.ok(source.includes('copyAvatarDraft(config)'));
 assert.ok(source.includes('复制为新分身'));
 assert.ok(source.includes("const privateEditor=editing?editing.owner.status==='draft':privateSave"));
 assert.ok(source.includes("...(privateEditor?{intent:'draft'}:{})"));
});

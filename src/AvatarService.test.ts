import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {avatarArtifactKind,avatarFileSize,avatarRunProgress,avatarServicePayload,emptyAvatarBusiness,emptyAvatarService,normalizedAvatarBusiness,normalizedAvatarService} from './AvatarService';
import {AvatarBusinessFields,AvatarMethodFields,AvatarWelcomeFields} from './AvatarConfiguration';
import {AvatarArtifacts,protectedAvatarHtml} from './AvatarArtifacts';
import {AvatarPublicIdentity} from './AvatarPublicIdentity';

test('old avatar configurations default to no tools and do not acquire new service restrictions',()=>{
  assert.deepEqual(emptyAvatarService().features,[]);
  assert.deepEqual(normalizedAvatarService(),emptyAvatarService());
  assert.equal(emptyAvatarBusiness().access,'open');
  assert.deepEqual(emptyAvatarBusiness().plans,[]);
});
test('avatar submission removes blank starter questions without leaking method text into public identity',()=>{
  const draft={...emptyAvatarService(),welcome:' hello ',method:'private method',starterQuestions:['  first ','',' second  ','  ']};
  const payload=avatarServicePayload(draft);
  assert.deepEqual(payload.starterQuestions,['first','second']);assert.equal(payload.welcome,'hello');assert.equal(payload.method,'private method');
  const html=renderToStaticMarkup(createElement(AvatarPublicIdentity,{name:'顾问分身',authorName:'<script>老师</script>',description:'预算咨询',mode:'knowledge'}));
  assert.ok(html.includes('作者'));assert.ok(html.includes('AI 分身'));assert.ok(html.includes('&lt;script&gt;老师&lt;/script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('private method'));
});
test('teacher configuration separates welcome, method, selected tools, and eligibility',()=>{
  const value={...emptyAvatarService(),features:[{featureId:'safe',releaseId:'v1',when:'需要预算时',workflow:'先问数字，再生成表格'}]};
  const html=renderToStaticMarkup(createElement(AvatarMethodFields,{value,features:[{id:'safe',releaseId:'v1',name:'预算表格',description:'交付可填写表格',usageMultiplier:0.6}],onChange:()=>{}}));
  assert.ok(html.includes('方法资料'));assert.ok(html.includes('什么时候用'));assert.ok(html.includes('按什么流程交付'));assert.ok(html.includes('先问数字，再生成表格'));assert.ok(html.includes('accept=".md,.txt'));
  assert.ok(html.includes('功能计费倍率'));assert.ok(html.includes('以该功能模型参考价为基准'));assert.ok(!html.includes('ONE 基础费用的 0.6 倍'));
  const welcome=renderToStaticMarkup(createElement(AvatarWelcomeFields,{value:emptyAvatarService(),authorName:'老徐',onChange:()=>{}}));
  assert.ok(welcome.includes('售前咨询'));assert.ok(welcome.includes('知识服务'));assert.ok(welcome.includes('作者'));assert.ok(welcome.includes('老徐'));
  const business=renderToStaticMarkup(createElement(AvatarBusinessFields,{value:emptyAvatarBusiness(),onChange:()=>{}}));
  assert.ok(business.includes('与 ONE 会员和钱包分开'));assert.ok(business.includes('不会自动扣款或续费'));assert.ok(!business.includes('立即购买'));assert.ok(!business.includes('提现'));
});
test('service configuration converts stored micro-units without charging or carrying server ownership fields',()=>{
  const normalized=normalizedAvatarBusiness({access:'entitlement',plans:[{id:'plan',name:'月度服务',kind:'monthly',quotaMicros:1500000,priceCny:99,validDays:30,status:'active'}]});
  assert.equal(normalized.plans[0].quota,1.5);assert.ok(!('quotaMicros' in normalized.plans[0]));
  const source=readFileSync(new URL('./AvatarBusinessPanels.tsx',import.meta.url),'utf8');
  assert.ok(source.includes("String(value ?? '未填写')"));assert.ok(source.includes('new Date(codeExpires)'));assert.ok(!source.includes('7 天内兑换'));
});
test('unknown run progress never displays raw infrastructure terminology',()=>{
  assert.match(avatarRunProgress('using_tools'),/制作/);
  assert.equal(avatarRunProgress('internal_provider_chain_retry_42'),'正在处理，结果会留在这里');
  assert.equal(avatarArtifactKind('text/html; charset=utf-8'),'html');
  assert.equal(avatarArtifactKind('image/svg+xml'),'download');
  assert.equal(avatarArtifactKind('image/png'),'image');
  assert.equal(avatarFileSize(1024),'1 KB');
});
test('HTML preview installs no-network CSP before scripts and remains sandboxed',()=>{
  const guarded=protectedAvatarHtml('<html><head><script>test()</script></head><body>ok</body></html>');
  assert.ok(guarded.indexOf('Content-Security-Policy')<guarded.indexOf('<script>'));
  const malformed=protectedAvatarHtml('<script>early()</script><head></head>');assert.ok(malformed.indexOf('Content-Security-Policy')<malformed.indexOf('<script>'));
  assert.ok(guarded.includes("connect-src 'none'"));assert.ok(guarded.includes("form-action 'none'"));
  const source=readFileSync(new URL('./AvatarArtifacts.tsx',import.meta.url),'utf8');
  assert.match(source,/sandbox="allow-scripts"/);assert.ok(!source.includes('allow-same-origin'));assert.match(source,/Authorization.*Bearer/);assert.ok(!source.includes('?token='));
});
test('artifact receipt renders files even when surrounding run is incomplete, without exposing token URLs',()=>{
  const html=renderToStaticMarkup(createElement(AvatarArtifacts,{artifacts:[{id:'private-id',name:'预算.html',mimeType:'text/html',size:2000}],runId:'run-id',base:'/api/sharing/slug',token:'secret-token'}));
  assert.ok(html.includes('预算.html'));assert.ok(html.includes('打开看看'));assert.ok(html.includes('保存文件'));assert.ok(!html.includes('secret-token'));assert.ok(!html.includes('href='));
});
test('avatar UI uses in-page dialogs and retains an uncertain request for idempotent retrieval',()=>{
  const source=readFileSync(new URL('./PublicSharing.tsx',import.meta.url),'utf8');
  assert.ok(!/\bconfirm\(/.test(source));assert.ok(source.includes('retry ||'));assert.ok(source.includes('找回这次提交'));assert.ok(source.includes('不会再做一份'));
});
test('account changes remount private guest panels and discard late authenticated responses before applying them',()=>{
  const source=readFileSync(new URL('./PublicSharing.tsx',import.meta.url),'utf8');
  assert.ok(source.includes('key={`${slug}:${token}:${meta.version}`}'));
  const accountChanged=source.slice(source.indexOf('<VisitorAccountPanel'),source.indexOf('<AvatarGuestService'));
  for(const reset of ["setToken('')","tokenRef.current = ''","setItems([])","setText('')","setFiles([])","setRetry(undefined)"])assert.ok(accountChanged.includes(reset),reset);
  const request=source.slice(source.indexOf('async function request<T>'),source.indexOf('async function load()'));
  assert.match(request,/if\(auth&&auth!==tokenRef\.current\)throw/);
  assert.ok(request.indexOf('auth!==tokenRef.current')<request.indexOf('if (!r.ok)'));
  const start=source.slice(source.indexOf('async function start()'),source.indexOf('async function chooseStarter'));
  assert.ok(start.includes("setText('')"));
});

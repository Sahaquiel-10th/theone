import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// Source/JSX contracts deliberately complement, rather than stand in for,
// actual browser save, draft recovery, closed-edit and trash acceptance.
const sharing=readFileSync(new URL('./PublicSharing.tsx',import.meta.url),'utf8');
const main=readFileSync(new URL('./main.tsx',import.meta.url),'utf8');
function region(start:string,end:string){
  const left=sharing.indexOf(start),right=sharing.indexOf(end,left+start.length);
  assert.ok(left>=0&&right>left,`Missing workbench region: ${start}`);
  return sharing.slice(left,right);
}

test('the always-visible toolbar submits its own native form without requiring a scroll to save',()=>{
  const form=region('const configForm=','const editor='),editor=region('const editor=','const review=');
  assert.match(form,/<form id=\{editorFormId\}[^>]*onSubmit=\{create\}/);
  assert.match(sharing,/editorFormId=useId\(\)/);
  assert.match(editor,/<button type="submit" form=\{editorFormId\} className="primary avatar-editor-save"/);
  assert.ok(editor.indexOf('avatar-editor-toolbar')<editor.indexOf('<FluidSplitWorkspace'));
  assert.ok(editor.indexOf('avatar-editor-save')<editor.indexOf('<FluidSplitWorkspace'));
  assert.doesNotMatch(editor,/<button[^>]*avatar-editor-save[^>]*onClick=/);
  assert.match(editor,/disabled=\{busy\|\|uncertain\|\|draftConflict!==undefined\|\|!draft\.modelId\}/);
});

test('private save has no authorization checkbox while live/public changes retain explicit consent',()=>{
  const form=region('const configForm=','const editor='),editor=region('const editor=','const review='),review=region('const review=','const secondary=');
  assert.doesNotMatch(form,/checked=\{draft\.confirmed\}/);
  assert.doesNotMatch(form,/确认分身的知识使用范围/);
  assert.match(editor,/!privateEditor\?<label[^>]*><input form=\{editorFormId\} required type="checkbox" checked=\{draft\.confirmed\}/);
  assert.match(sharing,/confirmed:privateEditor\|\|draft\.confirmed/);
  assert.match(sharing,/input type="checkbox" checked=\{shareConfirmed\}/);
  assert.match(review,/disabled=\{!shareConfirmed\|\|shareBusy\|\|shareReview\.sourceIds\.some\(id=>!data\?\.sources\.some\(source=>source\.id===id\)\)\}/);
});

test('both root entry paths pass exact user and workspace draft scope',()=>{
  const source=ts.createSourceFile('main.tsx',main,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const panels:ts.JsxSelfClosingElement[]=[];
  const visit=(node:ts.Node)=>{if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(source)==='SharingPanel')panels.push(node);ts.forEachChild(node,visit);};
  visit(source);assert.equal(panels.length,2);
  for(const panel of panels){
    const scope=panel.attributes.properties.find((attribute):attribute is ts.JsxAttribute=>ts.isJsxAttribute(attribute)&&attribute.name.getText(source)==='draftScope');
    assert.ok(scope?.initializer&&ts.isJsxExpression(scope.initializer));
    const expression=scope.initializer.expression;assert.ok(expression&&ts.isObjectLiteralExpression(expression));
    const entries=new Map(expression.properties.filter(ts.isPropertyAssignment).map(property=>[property.name.getText(source),property.initializer.getText(source)]));
    assert.equal(entries.get('userId'),'user.id');
    assert.equal(entries.get('workspaceId'),'user.access?.workspaceId??user.defaultWorkspaceId');
  }
  // A changed account/workspace unmounts component-local drafts and debug data.
  assert.match(main,/key=\{`\$\{user\.id\}:\$\{user\.access\?\.workspaceId\?\?user\.defaultWorkspaceId\}:\$\{user\.access\?\.role\?\?user\.role\}`\}/);
  // The panel is also isolated when reused outside ChatApp, such as a work layer.
  const boundary=region('export function SharingPanel(','function SharingPanelScoped(');
  assert.match(boundary,/<SharingPanelScoped key=\{JSON\.stringify\(\[props\.draftScope\?\.workspaceId,props\.draftScope\?\.userId\]\)\} \{\.\.\.props\}/);
});

test('closed avatars remain editable and reopening is an explicit reviewed action',()=>{
  const rows=region('const ownerList=','const pane=workspace.pane;');
  assert.match(rows,/owner\.deletedAt\?<button[^\n]*moveToTrash\(owner,true\)/);
  assert.match(rows,/aria-label=\{`编辑分身：\$\{owner\.name\}`\}[^>]*onClick=\{event=>void edit\(owner,event\.currentTarget\)\}/);
  assert.doesNotMatch(rows,/owner\.status!=='closed'\?<button/);
  assert.match(rows,/owner\.status==='closed'\?'重新开放'/);
  const routing=region('function showShare(','async function activateShare(');
  assert.match(routing,/owner\.status==='draft'\|\|owner\.status==='closed'/);
  assert.match(routing,/pane:\{kind:'publish',owner\}/);
  assert.match(sharing,/重新开放会生成新链接，旧链接和旧会话继续失效/);
  assert.match(sharing,/privateEditor=editing\?editing\.owner\.status!=='active':privateSave/);
});

test('trash actions are reversible scoped requests, not destructive UI-only removal',()=>{
  assert.match(sharing,/trash\?'&trash=1':''/);
  const trash=region('async function moveToTrash(','function showShare(');
  assert.match(trash,/\$\{restore\?'restore':'delete'\}/);
  assert.match(trash,/JSON\.stringify\(\{version:owner\.version,confirmed:true\}\)/);
  assert.match(trash,/confirmedRows\.current\.delete\(owner\.id\)/);
  assert.match(trash,/await load\(\)/);
  assert.match(sharing,/pane\?\.kind==='delete'/);
  assert.match(sharing,/恢复不会自动开放分享/);
  assert.doesNotMatch(sharing,/window\.confirm\(/);
});

test('local draft restoration is explicitly scoped and refuses to overwrite a new server version',()=>{
  const edit=region('async function edit(','async function copyClosed(');
  assert.match(edit,/readAvatarDraft\(draftScope,\{kind:'existing',ownerId:owner\.id,version:config\.version\}\)/);
  assert.match(edit,/saved\.status==='conflict'\?saved\.baseVersion:undefined/);
  assert.match(edit,/cached\?\.version===config\.version/);
  assert.match(edit,/saved\.status==='restored'\?saved\.draft:initial/);
  const recovery=region('function recoverConflictingDraft(','async function close(');
  assert.match(recovery,/copyAvatarDraft\(saved\.draft\)/);
  assert.match(recovery,/setEditing\(undefined\)/);
  assert.match(recovery,/pane:\{kind:'create'\}/);
  assert.match(sharing,/clearAvatarDraft\(draftScope,editing\?\{kind:'existing',ownerId:editing\.id,version:editing\.version\}:\{kind:'new'\}\)/);
  assert.match(sharing,/本页暂存可在刷新或误关配置后恢复；关闭浏览器标签页后不保证保留/);
});

test('returning the form to its baseline removes both memory and text recovery copies without unlocking a pending save',()=>{
  const persistence=region('const changed=avatarDraftFingerprint(draft)','async function load(');
  assert.match(persistence,/else if\(draftConflict===undefined\)\{\s*if\(editing\)draftsByOwner\.current\.delete\(editing\.id\);else newDraft\.current=null;\s*clearAvatarDraft\(draftScope,target\);setDraftNotice\(''\)/);
  assert.doesNotMatch(persistence,/clearAvatarDraftPending|clearPendingSave/);
});

test('save is marked pending before the network call and fresh editors recover the pending lock',()=>{
  const create=region('async function create(','async function checkUncertainResult(');
  assert.match(create,/if\(pendingSave\(target\)\)\{setUncertain\(true\);return;\}/);
  assert.ok(create.indexOf('markAvatarDraftPending(draftScope,target)')<create.indexOf('publishWithReceipt('));
  assert.ok(create.indexOf('markAvatarDraftPending(draftScope,target)')<create.indexOf('publish:()=>api<PublicationReceipt>'));
  assert.match(create,/clearAvatarDraft\(draftScope,[\s\S]*?clearPendingSave\(key,target\)/);
  assert.match(create,/if\(unknown\)uncertainKeys\.current\.add\(key\);else clearPendingSave\(key,target\)/);
  const pending=region('function pendingSave(','function clearPendingSave(');
  assert.match(pending,/readAvatarDraftPending\(draftScope,target\)/);
  assert.match(pending,/version:state\.baseVersion/);
  const start=region('function beginCreate(','async function copyClosed(');
  assert.match(start,/setUncertain\(uncertainKeys\.current\.has\('new'\)\|\|pendingSave\(\{kind:'new'\}\)\)/);
  assert.match(start,/setUncertain\(uncertainKeys\.current\.has\(owner\.id\)\|\|pendingSave\(\{kind:'existing',ownerId:owner\.id,version:config\.version\}\)\)/);
});

test('sharing review shows fresh source IDs from the config request and blocks unavailable sources',()=>{
  const review=region('const review=','const secondary=');
  assert.match(sharing,/const request=\+\+shareReviewRequest\.current;setShareReview\(undefined\);setShareReviewError\(''\);setShareConfirmed\(false\)/);
  assert.match(sharing,/`\/api\/sharing\/manage\/\$\{publishingOwner\.id\}\/config`\)\.then\(config=>\{if\(request===shareReviewRequest\.current\)setShareReview\(config\)/);
  assert.match(review,/shareReview\.sourceIds\.map\(id=>data\?\.sources\.find\(source=>source\.id===id\)\?\.name\?\?'来源已失效，请先编辑配置'\)/);
  assert.doesNotMatch(review,/publishingOwner\??\.sources/);
  assert.match(review,/shareReview\.sourceIds\.some\(id=>!data\?\.sources\.some\(source=>source\.id===id\)\)/);
});

test('a rejected stale-version save offers a forced config reload while retaining the old draft',()=>{
  const create=region('async function create(','async function checkUncertainResult('),edit=region('async function edit(','async function copyClosed('),editor=region('const editor=','const review=');
  assert.match(create,/setStaleEditor\(!!e&&typeof e==='object'&&'code' in e&&e\.code==='PUBLICATION_VERSION_CHANGED'\)/);
  assert.match(editor,/staleEditor&&editing\?<button[^>]*onClick=\{\(\)=>void edit\(editing\.owner,undefined,true\)\}>加载最新配置（保留草稿）/);
  assert.match(edit,/if\(!force&&workspace\.pane\?\.kind==='edit'&&editing\?\.id===owner\.id\)/);
  assert.match(edit,/saved\.status==='conflict'\?'配置已在别处更新，旧草稿保留但未覆盖新版。'/);
  assert.doesNotMatch(edit,/clearAvatarDraft\(/);
});

test('late publication receipts cannot insert active records into the currently displayed trash list',()=>{
  assert.match(sharing,/const trashRef=useRef\(trash\);trashRef\.current=trash/);
  const create=region('async function create(','async function checkUncertainResult('),activate=region('async function activateShare(','// Teacher workbench:');
  for(const receiptPath of [create,activate])assert.match(receiptPath,/confirmedRows\.current\.set\(row\.id,row\);if\(!trashRef\.current\)setData\(current=>upsertConfirmedPublication/);
  assert.match(activate,/if\(editRequests\.current\.isCurrent\(request\)\)dispatch\(\{type:'open-link',ownerId:row\.id\}\)/);
});

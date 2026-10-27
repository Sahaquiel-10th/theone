import assert from 'node:assert/strict';
import test from 'node:test';
import {emptyAvatarBusiness,emptyAvatarService} from './AvatarService';
import {AVATAR_DRAFT_TTL_MS,avatarDraftFingerprint,clearAvatarDraft,clearAvatarDraftPending,markAvatarDraftPending,readAvatarDraft,readAvatarDraftPending,saveAvatarDraft,type AvatarDraftOptions,type AvatarDraftScope,type AvatarDraftStorage,type AvatarDraftTarget} from './avatarDraftPersistence';
import type {PublicationDraft} from './sharingWorkspaceState';

class MemoryStorage implements AvatarDraftStorage{
  values=new Map<string,string>();
  getItem(key:string){return this.values.get(key)??null;}
  setItem(key:string,value:string){this.values.set(key,value);}
  removeItem(key:string){this.values.delete(key);}
}
const now=1_800_000_000_000;
const scope:AvatarDraftScope={workspaceId:'workspace-a',userId:'user-a'};
const fresh:AvatarDraftTarget={kind:'new'};
const owner:AvatarDraftTarget={kind:'existing',ownerId:'avatar-a',version:3};
function draft():PublicationDraft{return {name:'还没填完的分身',description:'作者手填介绍',prompt:'先问目标，再给出建议。',modelId:'model-a',sourceIds:['connection-a'],attachments:false,budget:0,perRun:.1,days:7,confirmed:true,visitorPercent:0,requireLogin:false,allowedUsernames:[''],service:{...emptyAvatarService(),welcome:'你好，我是你的顾问。',method:'尚未保存的合成方法资料',starterQuestions:['怎么开始？'],features:[{featureId:'feature-a',releaseId:'release-a',when:'需要测算时',workflow:'先收集数字'}]},serviceBusiness:{...emptyAvatarBusiness(),plans:[{name:'',kind:'monthly',quota:0,priceCny:0,validDays:30,status:'active'}],intakeFields:[{id:'field-a',label:'',type:'text',required:false}]}};}
function fixture(){const storage=new MemoryStorage();const options:AvatarDraftOptions={storage,now};return {storage,options};}

test('a tab-local new draft survives a fresh caller and requires fresh confirmation',()=>{
  const {storage,options}=fixture(),input=draft();
  assert.equal(saveAvatarDraft(scope,fresh,input,options),true);
  const restored=readAvatarDraft({...scope},{kind:'new'},{storage,now:now+1000});
  assert.equal(restored.status,'restored');
  if(restored.status!=='restored')return;
  assert.equal(restored.savedAt,now);
  assert.deepEqual(restored.draft,{...input,confirmed:false});
  assert.equal(input.confirmed,true,'Persisting must not mutate the current form');
  assert.equal(restored.draft.budget,0,'An unfinished field is a recoverable draft, not yet a publishable config');
});

test('only author configuration is serialized, never extra private results or credentials',()=>{
  const {storage,options}=fixture(),input=draft() as PublicationDraft&Record<string,unknown>;
  Object.assign(input,{debugAnswers:['PRIVATE_REPLY'],token:'PRIVATE_TOKEN',apiKey:'PRIVATE_CREDENTIAL',knowledgeResults:[{content:'PRIVATE_KNOWLEDGE'}],owner:{slug:'server-secret'}});
  Object.assign(input.service!,{credentials:'NESTED_PRIVATE_CREDENTIAL',answers:['NESTED_PRIVATE_REPLY']});
  assert.equal(saveAvatarDraft(scope,fresh,input,options),true);
  const serialized=[...storage.values.values()][0];
  assert.doesNotMatch(serialized,/PRIVATE_|server-secret|debugAnswers|apiKey|knowledgeResults|credentials/);
  assert.match(serialized,/尚未保存的合成方法资料/);
  assert.match(serialized,/"confirmed":false/);
});

test('snapshots are detached from later changes to the live form and returned copy',()=>{
  const {options}=fixture(),input=draft();saveAvatarDraft(scope,owner,input,options);
  input.name='后来改过';input.service!.method='后来改过的方法';
  const first=readAvatarDraft(scope,owner,options);assert.equal(first.status,'restored');
  if(first.status!=='restored')return;
  assert.equal(first.draft.name,'还没填完的分身');assert.equal(first.draft.service!.method,'尚未保存的合成方法资料');
  first.draft.service!.method='修改恢复值';
  const second=readAvatarDraft(scope,owner,options);assert.equal(second.status,'restored');
  if(second.status==='restored')assert.equal(second.draft.service!.method,'尚未保存的合成方法资料');
});

test('user, workspace, existing owner and new-draft identities never fall back to each other',()=>{
  const {options}=fixture();saveAvatarDraft(scope,owner,draft(),options);
  for(const [otherScope,target] of [[{...scope,userId:'user-b'},owner],[{...scope,workspaceId:'workspace-b'},owner],[scope,{...owner,ownerId:'avatar-b'}],[scope,fresh]] as [AvatarDraftScope,AvatarDraftTarget][]){
    assert.equal(readAvatarDraft(otherScope,target,options).status,'missing');
  }
  const newNamedOwner:AvatarDraftTarget={kind:'existing',ownerId:'new',version:1};
  saveAvatarDraft(scope,fresh,draft(),options);
  assert.equal(readAvatarDraft(scope,newNamedOwner,options).status,'missing');
});

test('scope keys cannot collide through separators in IDs',()=>{
  const {storage,options}=fixture();
  const a={workspaceId:'left:right',userId:'tail'},b={workspaceId:'left',userId:'right:tail'};
  saveAvatarDraft(a,fresh,draft(),options);saveAvatarDraft(b,fresh,{...draft(),name:'另一个账号'},options);
  assert.equal(storage.values.size,2);
  const result=readAvatarDraft(a,fresh,options);assert.equal(result.status,'restored');
  if(result.status==='restored')assert.equal(result.draft.name,'还没填完的分身');
});

test('copying stored JSON into another scope does not restore it there',()=>{
  const {storage,options}=fixture(),other={...scope,workspaceId:'workspace-b'};
  saveAvatarDraft(scope,fresh,draft(),options);saveAvatarDraft(other,fresh,draft(),options);
  const [a,b]=[...storage.values.keys()];storage.setItem(b,storage.getItem(a)!);
  assert.equal(readAvatarDraft(other,fresh,options).status,'invalid');
  assert.equal(storage.getItem(b),null);
  assert.equal(readAvatarDraft(scope,fresh,options).status,'restored');
});

test('missing explicit account scope disables storage rather than using an anonymous bucket',()=>{
  const {storage,options}=fixture();
  for(const value of [undefined,{workspaceId:'',userId:'user-a'},{workspaceId:'workspace-a',userId:''}]){
    assert.equal(saveAvatarDraft(value,fresh,draft(),options),false);
    assert.equal(readAvatarDraft(value,fresh,options).status,'unavailable');
    assert.equal(clearAvatarDraft(value,fresh,options),false);
  }
  assert.equal(storage.values.size,0);
});

test('a newer server version blocks automatic restoration without destroying the older author draft',()=>{
  const {storage,options}=fixture();saveAvatarDraft(scope,owner,draft(),options);
  assert.deepEqual(readAvatarDraft(scope,{...owner,version:4},options),{status:'conflict',savedAt:now,baseVersion:3});
  assert.equal(storage.values.size,1);
  assert.equal(readAvatarDraft(scope,owner,options).status,'restored');
});

test('successful save or explicit discard clears only the selected scoped owner',()=>{
  const {options}=fixture(),other={...scope,userId:'user-b'};
  saveAvatarDraft(scope,owner,draft(),options);saveAvatarDraft(scope,fresh,draft(),options);saveAvatarDraft(other,owner,draft(),options);
  assert.equal(clearAvatarDraft(scope,owner,options),true);
  assert.equal(readAvatarDraft(scope,owner,options).status,'missing');
  assert.equal(readAvatarDraft(scope,fresh,options).status,'restored');
  assert.equal(readAvatarDraft(other,owner,options).status,'restored');
});

test('stale writers and old save receipts cannot replace or clear a newer-version draft',()=>{
  const {options}=fixture(),newer={...owner,version:4};
  saveAvatarDraft(scope,newer,{...draft(),name:'基于新服务端版本的草稿'},options);
  assert.equal(saveAvatarDraft(scope,owner,{...draft(),name:'过期编辑器'},options),false);
  assert.equal(clearAvatarDraft(scope,owner,options),false);
  const result=readAvatarDraft(scope,newer,options);assert.equal(result.status,'restored');
  if(result.status==='restored')assert.equal(result.draft.name,'基于新服务端版本的草稿');
  assert.equal(clearAvatarDraft(scope,newer,options),true);
});

test('draft recovery expires at seven days and removes only the expired entry',()=>{
  const {storage,options}=fixture();saveAvatarDraft(scope,fresh,draft(),options);
  assert.equal(readAvatarDraft(scope,fresh,{storage,now:now+AVATAR_DRAFT_TTL_MS-1}).status,'restored');
  assert.equal(readAvatarDraft(scope,fresh,{storage,now:now+AVATAR_DRAFT_TTL_MS}).status,'expired');
  assert.equal(storage.values.size,0);
});

test('malformed, oversize and tampered metadata fail closed without throwing',()=>{
  const {storage,options}=fixture();saveAvatarDraft(scope,fresh,draft(),options);
  const key=[...storage.values.keys()][0],good=storage.getItem(key)!;
  for(const value of ['{broken','x'.repeat(128*1024+1),JSON.stringify({...JSON.parse(good),expiresAt:now+100*AVATAR_DRAFT_TTL_MS}),JSON.stringify({...JSON.parse(good),format:2}),JSON.stringify({...JSON.parse(good),draft:{...draft(),service:{...emptyAvatarService(),features:[{featureId:'x'}]}}})]){
    storage.setItem(key,value);assert.equal(readAvatarDraft(scope,fresh,options).status,'invalid');assert.equal(storage.getItem(key),null);
  }
});

test('unavailable or quota-limited storage never interrupts editing and keeps the last valid copy',()=>{
  const {storage,options}=fixture();saveAvatarDraft(scope,fresh,draft(),options);
  const quota:AvatarDraftStorage={getItem:key=>storage.getItem(key),setItem:()=>{throw new Error('Quota exceeded');},removeItem:()=>{throw new Error('Storage denied');}};
  assert.equal(saveAvatarDraft(scope,fresh,{...draft(),name:'未写入的新名字'},{storage:quota,now:now+1}),false);
  const result=readAvatarDraft(scope,fresh,options);assert.equal(result.status,'restored');
  if(result.status==='restored')assert.equal(result.draft.name,'还没填完的分身');
  assert.equal(clearAvatarDraft(scope,fresh,{storage:quota}),false);
  assert.equal(readAvatarDraft(scope,fresh,{storage:{...quota,getItem:()=>{throw new Error('Denied');}}}).status,'unavailable');
  assert.equal(saveAvatarDraft(scope,fresh,draft(),{storage:null}),false);
  assert.equal(readAvatarDraft(scope,fresh,{storage:null}).status,'unavailable');
});

test('consent does not make a dirty draft, while any actual author field does',()=>{
  const input=draft(),fingerprint=avatarDraftFingerprint(input);
  assert.equal(avatarDraftFingerprint({...input,confirmed:false}),fingerprint);
  assert.notEqual(avatarDraftFingerprint({...input,name:'真正改动'}),fingerprint);
  assert.notEqual(avatarDraftFingerprint({...input,service:{...input.service!,method:'真正改过方法'}}),fingerprint);
});

test('invalid values cannot overwrite a valid recovery copy or grant confirmation',()=>{
  const {options}=fixture();saveAvatarDraft(scope,fresh,draft(),options);
  assert.equal(saveAvatarDraft(scope,fresh,{...draft(),prompt:'x'.repeat(12001)},options),false);
  assert.equal(saveAvatarDraft(scope,fresh,{...draft(),budget:Number.NaN},options),false);
  assert.equal(avatarDraftFingerprint({...draft(),budget:Number.NaN}),'');
  assert.equal(saveAvatarDraft(scope,{kind:'existing',ownerId:'avatar-a',version:0},draft(),options),false);
  assert.equal(readAvatarDraft(scope,fresh,options).status,'restored');
});

test('new-draft pending survives a fresh caller without storing any author text or receipt',()=>{
  const {storage,options}=fixture();
  assert.equal(markAvatarDraftPending(scope,fresh,options),true);
  assert.deepEqual(readAvatarDraftPending({...scope},{kind:'new'},{storage,now:now+1000}),{status:'pending',baseVersion:0,savedAt:now});
  const serialized=[...storage.values.values()][0];
  assert.match(serialized,/"pending":true/);
  assert.doesNotMatch(serialized,/prompt|method|draft|response|content|token|credential/i);
  assert.equal(readAvatarDraft(scope,fresh,options).status,'missing','Pending is not a draft text entry');
});

test('draft text save and discard cannot unlock a pending submission',()=>{
  const {options}=fixture();
  markAvatarDraftPending(scope,owner,options);saveAvatarDraft(scope,owner,draft(),options);
  assert.equal(clearAvatarDraft(scope,owner,options),true);
  assert.equal(readAvatarDraftPending(scope,owner,options).status,'pending');
  saveAvatarDraft(scope,owner,{...draft(),name:'仍待核对时的修改'},options);
  assert.equal(clearAvatarDraftPending(scope,owner,options),true);
  assert.equal(readAvatarDraftPending(scope,owner,options).status,'missing');
  assert.equal(readAvatarDraft(scope,owner,options).status,'restored','Clearing a checked marker leaves author text intact');
});

test('pending markers are scoped by workspace, user, owner and new-vs-existing target',()=>{
  const {storage,options}=fixture();markAvatarDraftPending(scope,owner,options);
  for(const [other,target] of [[{...scope,userId:'user-b'},owner],[{...scope,workspaceId:'workspace-b'},owner],[scope,{...owner,ownerId:'avatar-b'}],[scope,fresh]] as [AvatarDraftScope,AvatarDraftTarget][]){
    assert.equal(readAvatarDraftPending(other,target,options).status,'missing');
  }
  assert.equal(markAvatarDraftPending(undefined,fresh,options),false);
  assert.equal(clearAvatarDraftPending({...scope,workspaceId:''},owner,options),false);
  assert.equal(storage.values.size,1);
});

test('same-version pending marks are idempotent and do not renew the first seven-day window',()=>{
  const {storage,options}=fixture();markAvatarDraftPending(scope,owner,options);
  assert.equal(markAvatarDraftPending(scope,owner,{storage,now:now+5000}),true);
  assert.deepEqual(readAvatarDraftPending(scope,owner,{storage,now:now+5000}),{status:'pending',baseVersion:3,savedAt:now});
  assert.equal(readAvatarDraftPending(scope,owner,{storage,now:now+AVATAR_DRAFT_TTL_MS}).status,'expired');
  assert.equal(storage.values.size,0);
  assert.equal(markAvatarDraftPending(scope,owner,{storage,now:now+AVATAR_DRAFT_TTL_MS}),true);
});

test('unknown writes remain locked across version changes and only matching-version receipts clear them',()=>{
  const {options}=fixture(),newer={...owner,version:4};markAvatarDraftPending(scope,owner,options);
  assert.deepEqual(readAvatarDraftPending(scope,newer,options),{status:'pending',baseVersion:3,savedAt:now});
  assert.equal(markAvatarDraftPending(scope,newer,options),false);
  assert.equal(clearAvatarDraftPending(scope,newer,options),false);
  assert.equal(clearAvatarDraftPending(scope,owner,options),true);
  markAvatarDraftPending(scope,newer,options);
  assert.equal(markAvatarDraftPending(scope,owner,options),false);
  assert.equal(clearAvatarDraftPending(scope,owner,options),false);
  assert.equal(readAvatarDraftPending(scope,newer,options).status,'pending');
});

test('tampered pending scope or metadata fails closed without touching another account marker',()=>{
  const {storage,options}=fixture(),other={...scope,userId:'user-b'};
  markAvatarDraftPending(scope,fresh,options);markAvatarDraftPending(other,fresh,options);
  const [a,b]=[...storage.values.keys()],good=storage.getItem(a)!;
  storage.setItem(b,good);assert.equal(readAvatarDraftPending(other,fresh,options).status,'invalid');
  assert.equal(readAvatarDraftPending(scope,fresh,options).status,'pending');
  for(const value of ['bad JSON','x'.repeat(4097),JSON.stringify({...JSON.parse(good),pending:false}),JSON.stringify({...JSON.parse(good),baseVersion:8}),JSON.stringify({...JSON.parse(good),expiresAt:now+99*AVATAR_DRAFT_TTL_MS})]){
    storage.setItem(a,value);assert.equal(readAvatarDraftPending(scope,fresh,options).status,'invalid');assert.equal(storage.getItem(a),null);
  }
});

test('pending storage denial or quota errors are reported as unavailable without throwing',()=>{
  const denied:AvatarDraftStorage={getItem:()=>{throw new Error('Denied');},setItem:()=>{throw new Error('Quota');},removeItem:()=>{throw new Error('Denied');}};
  assert.equal(markAvatarDraftPending(scope,fresh,{storage:denied,now}),false);
  assert.equal(readAvatarDraftPending(scope,fresh,{storage:denied,now}).status,'unavailable');
  assert.equal(clearAvatarDraftPending(scope,fresh,{storage:denied,now}),false);
  const quota={...denied,getItem:()=>null};
  assert.equal(markAvatarDraftPending(scope,fresh,{storage:quota,now}),false);
  assert.equal(markAvatarDraftPending(scope,fresh,{storage:null,now}),false);
});

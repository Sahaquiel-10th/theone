import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmedPublicationRow,createSharingOwnerRequestGate,initialSharingWorkspace,publicationSubmitIsUncertain,reconcilePublicationList,sharingWorkspaceTransition,upsertConfirmedPublication,type PublicationDraft,type PublicationList} from './sharingWorkspaceState';
const draft:PublicationDraft={name:'  我的分身  ',description:'整理资料',prompt:'回答要求',modelId:'model',sourceIds:['knowledge-1'],attachments:true,budget:10,perRun:1,days:7,confirmed:true,visitorPercent:0,requireLogin:false,allowedUsernames:[]};
const list:PublicationList={ready:true,items:[],total:0,sources:[{id:'knowledge-1',provider:'notion',name:'项目资料'}]};
test('a late config response cannot reopen an owner after another view is selected',async()=>{
 const gate=createSharingOwnerRequestGate();let receive!:(name:string)=>void;
 const config=new Promise<string>(resolve=>{receive=resolve;});
 const request=gate.begin('owner-a');let visible='owner-a loading';
 const pending=config.then(name=>{if(gate.isCurrent(request))visible=name;});
 gate.invalidate();visible='owner-b services';receive('owner-a editor');await pending;
 assert.equal(visible,'owner-b services');assert.equal(gate.isCurrent(request),false);
});
test('only the newest config request may complete or report its error',async()=>{
 const gate=createSharingOwnerRequestGate();let rejectOld!:(error:Error)=>void;
 const oldResponse=new Promise<never>((_,reject)=>{rejectOld=reject;});
 const old=gate.begin('owner-a');let error='';
 const pending=oldResponse.catch(reason=>{if(gate.isCurrent(old))error=reason.message;});
 const current=gate.begin('owner-b');rejectOld(new Error('owner-a failed'));await pending;
 assert.equal(error,'');assert.equal(gate.isCurrent(old),false);assert.equal(gate.isCurrent(current),true);
 gate.invalidate();assert.equal(gate.isCurrent(current),false);
});
test('a completed save updates its owner without closing another owner detail',async()=>{
 const gate=createSharingOwnerRequestGate();let finish!:(receipt:{id:string;status:'draft';version:number})=>void;
 const response=new Promise<{id:string;status:'draft';version:number}>(resolve=>{finish=resolve;});
 let workspace=sharingWorkspaceTransition(initialSharingWorkspace,{type:'open-pane',pane:{kind:'create'}}),saved=list;
 const request=gate.begin('new');
 const pending=response.then(receipt=>{
  saved=upsertConfirmedPublication(saved,confirmedPublicationRow(receipt,draft,list.sources));
  if(gate.isCurrent(request))workspace=sharingWorkspaceTransition(workspace,{type:'saved'});
 });
 const other=confirmedPublicationRow({id:'owner-b',slug:'link-b'},draft,list.sources);
 gate.invalidate();workspace=sharingWorkspaceTransition(workspace,{type:'open-pane',pane:{kind:'services',owner:other}});
 finish({id:'owner-a',status:'draft',version:1});await pending;
 assert.equal(saved.items[0].id,'owner-a');assert.equal(saved.items[0].status,'draft');
 assert.equal(workspace.pane?.kind,'services');assert.equal(workspace.pane&&'owner' in workspace.pane?workspace.pane.owner.id:undefined,'owner-b');
});
test('save rejoins the editor without automatically opening a share link',()=>{
 const editor=sharingWorkspaceTransition(initialSharingWorkspace,{type:'open-pane',pane:{kind:'create'}});
 assert.equal(editor.pane?.kind,'create');assert.equal(editor.linkOwnerId,null);
 assert.deepEqual(sharingWorkspaceTransition(editor,{type:'saved'}),initialSharingWorkspace);
});
test('a row link waits for the editor to rejoin and belongs only to its requested owner',()=>{
 const editor=sharingWorkspaceTransition(initialSharingWorkspace,{type:'open-pane',pane:{kind:'create'}});
 const queued=sharingWorkspaceTransition(editor,{type:'open-link',ownerId:'owner-2'});
 assert.equal(queued.pane,null);assert.equal(queued.linkOwnerId,null);
 const open=sharingWorkspaceTransition(queued,{type:'main-merged'});
 assert.equal(open.linkOwnerId,'owner-2');assert.equal(open.queuedLinkOwnerId,null);
 assert.equal(sharingWorkspaceTransition(open,{type:'open-link',ownerId:'owner-3'}).linkOwnerId,'owner-3');
});
test('confirmed server identity immediately inserts a real active publication, never a fake private save',()=>{
 const row=confirmedPublicationRow({id:'pub-real',slug:'real-link'},draft,list.sources,undefined,1000);
 assert.equal(row.id,'pub-real');assert.equal(row.slug,'real-link');assert.equal(row.name,'我的分身');assert.equal(row.status,'active');assert.equal(row.syncPending,true);assert.deepEqual(row.sources,['项目资料']);
 const next=upsertConfirmedPublication(list,row);assert.equal(next.items[0].id,'pub-real');assert.equal(next.total,1);
 assert.throws(()=>confirmedPublicationRow({id:'',slug:'link'},draft,list.sources),/身份信息不完整/);
});
test('refresh failure or an older response cannot erase or downgrade a confirmed owner row',()=>{
 const created=confirmedPublicationRow({id:'pub-real',slug:'real-link'},draft,list.sources);
 const pending=new Map([[created.id,created]]);
 assert.equal(reconcilePublicationList(list,pending).list.items[0].id,created.id);
 const updated=confirmedPublicationRow({id:created.id,slug:created.slug,version:2},{...draft,name:'新版'},list.sources,created);
 const state=reconcilePublicationList({...list,items:[{...created,syncPending:false}],total:1},new Map([[updated.id,updated]]));
 assert.equal(state.list.items[0].version,2);assert.equal(state.list.items[0].name,'新版');assert.equal(state.pending.size,1);
 const fresh=reconcilePublicationList({...list,items:[{...updated,syncPending:false}],total:1},state.pending);
 assert.equal(fresh.pending.size,0);assert.equal(fresh.list.items[0].syncPending,false);
});
test('editing never replaces a different owner or discards previous usage',()=>{
 const before=confirmedPublicationRow({id:'owner-1',slug:'link-1'},draft,list.sources);
 const after=confirmedPublicationRow({id:'owner-1',slug:'link-1',version:2},draft,list.sources,{...before,spent:1234,held:567});
 assert.equal(after.spent,1234);assert.equal(after.held,567);
 assert.throws(()=>confirmedPublicationRow({id:'owner-2',slug:'link-2'},draft,list.sources,before),/身份.*不一致/);
});
test('transport and server uncertainty do not authorize duplicate publication',()=>{
 assert.equal(publicationSubmitIsUncertain(new Error('connection lost')),true);
 assert.equal(publicationSubmitIsUncertain({status:503}),true);
 assert.equal(publicationSubmitIsUncertain({status:408}),true);
 assert.equal(publicationSubmitIsUncertain({status:400}),false);
 assert.equal(publicationSubmitIsUncertain({status:409}),false);
 assert.equal(publicationSubmitIsUncertain({status:403}),false);
});
test('a private save needs no public slug and cannot fabricate a share link',()=>{
 const row=confirmedPublicationRow({id:'private-real',status:'draft',version:1},draft,list.sources);
 assert.equal(row.status,'draft');assert.equal(row.slug,undefined);assert.equal(row.id,'private-real');
 const saved=upsertConfirmedPublication(list,row);assert.equal(saved.items[0].status,'draft');
 assert.throws(()=>confirmedPublicationRow({id:'broken-active',status:'active'},draft,list.sources),/身份信息不完整/);
});

test('confirmed owner rows preserve the deployed author and selected service identity while usage refresh is pending',()=>{
 const previous={...confirmedPublicationRow({id:'service-owner',slug:'service-link'},draft,list.sources),authorName:'老师',service:{mode:'consultation' as const,featureCount:0}};
 const service={mode:'knowledge' as const,welcome:'你好',starterQuestions:[],method:'按授权资料回答',features:[{featureId:'feature',releaseId:'release',when:'需要时',workflow:'先核对参数'}]};
 const row=confirmedPublicationRow({id:previous.id,slug:previous.slug,version:2},{...draft,service},list.sources,previous);
 assert.equal(row.authorName,'老师');assert.deepEqual(row.service,{mode:'knowledge',featureCount:1});
});

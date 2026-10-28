import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {workspaceStartupMode,workspaceDestinationPending} from './workspaceStartupState';
import {WorkspaceStartup} from './WorkspaceStartup';
import {scopedStateValue} from './coordinatorScopedState';

const unknown={demoEnabled:false,coordinatorReady:false,coordinatorEnabled:false,hasSnapshot:false};
test('unknown startup never mounts legacy UI while the first authenticated read is delayed or fails',()=>{
 assert.equal(workspaceStartupMode(unknown),'loading');
 assert.equal(workspaceStartupMode({...unknown,error:'网络暂时不可用'}),'retry');
 assert.equal(workspaceStartupMode({...unknown,coordinatorReady:true}),'loading','ready without its scoped snapshot is still unknown');
 assert.equal(workspaceStartupMode({...unknown,coordinatorEnabled:true}),'loading','an unconfirmed hint cannot grant coordinator functionality');
});

test('only an explicit first disabled snapshot selects legacy; later read failure preserves the confirmed mode',()=>{
 const known={...unknown,coordinatorReady:true,hasSnapshot:true};
 assert.equal(workspaceStartupMode(known),'legacy');
 assert.equal(workspaceStartupMode({...known,error:'刷新失败'}),'legacy');
 assert.equal(workspaceStartupMode({...known,coordinatorEnabled:true}),'workspace');
 assert.equal(workspaceStartupMode({...known,coordinatorEnabled:true,error:'刷新失败'}),'workspace');
});

test('admin, company and connector destinations stay in the same shell until adopted as a work layer',()=>{
 for(const view of ['admin','company','account','things','features','avatars']){
  assert.equal(workspaceDestinationPending(true,view),true);
  assert.equal(workspaceStartupMode({...unknown,coordinatorReady:true,hasSnapshot:true,coordinatorEnabled:true,destinationPending:workspaceDestinationPending(true,view)}),'loading');
  assert.equal(workspaceDestinationPending(false,view),false,'explicit legacy mode retains its real destination');
 }
 assert.equal(workspaceDestinationPending(true,'chat'),false);
 assert.equal(workspaceStartupMode({...unknown,coordinatorReady:true,hasSnapshot:true,coordinatorEnabled:true,destinationPending:false}),'workspace');
 assert.equal(workspaceStartupMode({...unknown,demoEnabled:true}),'workspace');
});

test('ref-based layout enablement changes only when the real workspace can mount',()=>{
 const canvasEnabled=(input:Parameters<typeof workspaceStartupMode>[0],view='chat')=>workspaceStartupMode(input)==='workspace'&&view==='chat'&&(input.demoEnabled||input.coordinatorEnabled);
 // A flag can be observed before its ready snapshot. Layout must wait, then
 // receive a false -> true dependency change when the DOM actually appears.
 const hinted={...unknown,coordinatorEnabled:true};
 assert.equal(canvasEnabled(hinted),false);
 const ready={...hinted,coordinatorReady:true,hasSnapshot:true};
 assert.equal(canvasEnabled(ready),true);
 assert.equal(canvasEnabled({...ready,destinationPending:true}),false);
 assert.equal(canvasEnabled({...ready,destinationPending:false}),true);
 assert.equal(canvasEnabled({...ready,coordinatorEnabled:false}),false,'legacy content mounts without fluid geometry');
});

test('account and workspace changes hide the previous ready flag and snapshot synchronously',()=>{
 const first={userId:'one',workspaceId:'a'},second={userId:'two',workspaceId:'b'};
 const previousSnapshot={scope:first,value:{enabled:true,conversation:'PRIVATE_FIRST_WORKSPACE'}};
 const previousReady={scope:first,value:true};
 const snapshot=scopedStateValue(previousSnapshot,second,null);
 const ready=scopedStateValue(previousReady,second,false);
 assert.equal(snapshot,null);assert.equal(ready,false);
 assert.equal(workspaceStartupMode({...unknown,coordinatorReady:ready,coordinatorEnabled:Boolean(snapshot),hasSnapshot:Boolean(snapshot)}),'loading');
 const epoch={userId:'one',workspaceId:'a'};
 assert.equal(scopedStateValue(previousSnapshot,epoch,null),null,'a new same-account API epoch cannot restore a stale ready snapshot');
});

test('startup and retry share the approved appearance, without active controls or private conversation content',()=>{
 let retries=0;
 const pending=renderToStaticMarkup(createElement(WorkspaceStartup,{scene:'graphite',onRetry:async()=>{retries++;}}));
 const failed=renderToStaticMarkup(createElement(WorkspaceStartup,{scene:'graphite',error:'ErrorSQL: SELECT * FROM private_messages; requestId=req_PRIVATE_DIAGNOSTIC',onRetry:async()=>{retries++;}}));
 assert.match(pending,/one-fluid-workspace workspace-startup/);
 assert.match(pending,/data-fluid-scene="graphite"/);
 assert.match(pending,/正在打开工作台/);
 assert.doesNotMatch(pending,/<button|one-chrome|studio-navigation|textarea/);
 assert.match(failed,/data-workspace-startup="retry"/);
 assert.match(failed,/请检查网络与 ONE Key 连接，然后重试/);
 assert.doesNotMatch(failed,/ErrorSQL|SELECT|private_messages|requestId|req_PRIVATE_DIAGNOSTIC/);
 assert.match(failed,/>重新连接</);
 assert.doesNotMatch(failed,/工作台已就绪|已连接|已开始/);
 assert.equal(retries,0,'rendering never sends a retry or starts work');
 const silver=renderToStaticMarkup(createElement(WorkspaceStartup,{scene:'silver',onRetry:async()=>{}}));
 assert.match(silver,/data-fluid-scene="silver"/);
});

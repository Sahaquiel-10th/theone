import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database} from './types.js';
import {artifactResultLinks,ownedArtifactResults} from './artifactLinks.js';

test('artifact URLs remain private and only ready files bound to the exact owner and task are exposed',()=>{
 const scope={workspaceId:'wa',userId:'a'},base={...scope,conversationId:'task',status:'ready',originalName:'说明.html',kind:'document',visualDocument:{}};
 const db={attachments:[{...base,id:'mine'},{...base,id:'foreign',workspaceId:'wb'},{...base,id:'other-user',userId:'b'},{...base,id:'other-task',conversationId:'elsewhere'},{...base,id:'pending',status:'processing'},{...base,id:'shared',conversationId:'elsewhere',sharedConversationIds:['task']}]} as unknown as Database;
 const results=ownedArtifactResults(db,scope,'task',db.attachments.map(f=>f.id));
 assert.deepEqual(results.map(f=>f.openUrl),['/api/welcome-pages/mine/view','/api/welcome-pages/shared/view']);
 assert.deepEqual(ownedArtifactResults(db,{workspaceId:'wb',userId:'b'},'task',['mine']),[]);
 assert.deepEqual(artifactResultLinks('a/b?#'),{openUrl:'/api/attachments/a%2Fb%3F%23/content',downloadUrl:'/api/attachments/a%2Fb%3F%23/content'});
});

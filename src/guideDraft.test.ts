import test from 'node:test';
import assert from 'node:assert/strict';
import {canReceiveGuideDraft,guideDraftText,guideDraftFromMessage} from './guideDraft';
test('a guide can request a bounded draft, never an automatic submission',()=>{
 assert.equal(guideDraftText({type:'one-guide-draft',version:1,text:'  根据我选的资料做方案  '}),'根据我选的资料做方案');
 for(const raw of [null,'text',{type:'send',version:1,text:'run'},{type:'one-guide-draft',version:2,text:'run'},{type:'one-guide-draft',version:1,text:' '},{type:'one-guide-draft',version:1,text:'x'.repeat(2001)}])assert.equal(guideDraftText(raw),undefined);
});
test('another frame cannot send commands through an open guide viewer',()=>{
 const viewer={},message={source:viewer,data:{type:'one-guide-draft',version:1,text:'做一份方案'}};
 assert.equal(guideDraftFromMessage(message,viewer),'做一份方案');
 assert.equal(guideDraftFromMessage({...message,source:{}},viewer),undefined);
 assert.equal(guideDraftFromMessage({...message,source:null},null),undefined);
});
test('receiving a guide request preserves pre-existing drafts, attachments and armed functions',()=>{
 const empty={text:'',attachments:0,features:0,mode:'chat'};
 assert.equal(canReceiveGuideDraft(empty),true);
 for(const other of [{text:'未发送草稿'},{attachments:1},{features:1},{mode:'execution'}])assert.equal(canReceiveGuideDraft({...empty,...other}),false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyExecutionProgress, readCapturedNotices, friendlyResponsePhase } from './friendlyTaskStatus';
test('human progress avoids engine jargon without hiding questions or changing the stored event',()=>{
  const event={kind:'status',text:'Codex 已开始执行'};
  assert.equal(friendlyExecutionProgress(event),'开始在这台电脑上做了');
  assert.equal(event.text,'Codex 已开始执行');
  assert.equal(friendlyExecutionProgress({kind:'message',text:'请确认要使用 test 文件夹'}),'请确认要使用 test 文件夹');
  assert.doesNotMatch(friendlyExecutionProgress({kind:'command',text:'node secret-path/build.js'}),/secret-path/);
});
test('read-all cannot consume a notice that arrived while the server request was pending',()=>{
  const before=[{id:'old',read:false}],captured=new Set(before.map(item=>item.id));
  const after=readCapturedNotices([...before,{id:'new-round',read:false}],captured);
  assert.deepEqual(after,[{id:'old',read:true},{id:'new-round',read:false}]);
  assert.equal(before[0].read,false);
});
test('response phases explain real work in everyday language without claiming completion',()=>{
  assert.equal(friendlyResponsePhase('正在查找已授权知识库'),'我在找你连接的资料');
  assert.equal(friendlyResponsePhase('正在等待模型回答'),'我正在想这件事');
  assert.equal(friendlyResponsePhase('需要你选择文件夹'),'需要你选择文件夹');
  assert.doesNotMatch(friendlyResponsePhase('正在等待模型回答'),/完成|做好/);
});

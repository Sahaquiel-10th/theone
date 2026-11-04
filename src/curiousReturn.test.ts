import test from 'node:test';
import assert from 'node:assert/strict';
import {saveCuriousReturn,readCuriousReturn,clearCuriousReturn} from './curiousReturn';
test('knowledge return hints carry only a session ID and expire within the exact account and workspace',()=>{
  const data=new Map<string,string>(),storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};
  saveCuriousReturn(storage,'user-1','workspace-1','session-1',1000);
  assert.deepEqual(readCuriousReturn(storage,'user-1','workspace-1',2000),{sessionId:'session-1',at:1000});
  assert.equal(readCuriousReturn(storage,'user-2','workspace-1',2000),undefined);
  assert.equal(readCuriousReturn(storage,'user-1','workspace-2',2000),undefined);
  assert.equal(readCuriousReturn(storage,'user-1','workspace-1',1000+7200000),undefined);
  assert.equal(readCuriousReturn(storage,'user-1','workspace-1',500),undefined);
  clearCuriousReturn(storage,'user-1','workspace-1');assert.equal(data.size,0);
});

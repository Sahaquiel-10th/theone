import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberRuntimeNotice, runtimeNoticeSeen} from './runtimeNoticeMemory';
import {nearLatest} from './useFollowLatest';
import {readFileSync} from 'node:fs';
test('upgrade notice persists across new windows, separately for each user and version', () => {
  const values = new Map<string,string>();
  const storage = {getItem: (key:string) => values.get(key) ?? null, setItem: (key:string,value:string) => { values.set(key,value); }};
  assert.equal(runtimeNoticeSeen(storage,'a','0.4.12'),false);
  rememberRuntimeNotice(storage,'a','0.4.12');
  assert.equal(runtimeNoticeSeen({...storage},'a','0.4.12'),true);
  assert.equal(runtimeNoticeSeen(storage,'b','0.4.12'),false);
  assert.equal(runtimeNoticeSeen(storage,'a','0.4.13'),false);
});
test('unavailable storage does not block login', () => {
  const storage = {getItem: () => {throw Error('blocked');}, setItem: () => {throw Error('blocked');}};
  rememberRuntimeNotice(storage,'a','v');
  assert.equal(runtimeNoticeSeen(storage,'a','v'),false);
});
test('reading older messages disables follow; near bottom resumes it', () => {
  assert.equal(nearLatest({scrollHeight:2000,scrollTop:0,clientHeight:500}),false);
  assert.equal(nearLatest({scrollHeight:2000,scrollTop:1480,clientHeight:500}),true);
});
test('workbench follows the actual outer scroll surface, not its overflow-visible message list', () => {
  const source = readFileSync(new URL('./main.tsx',import.meta.url),'utf8');
  assert.match(source, /className="studio-surface" ref=\{taskScroll.scroll\} onScroll=\{taskScroll.onScroll\}/);
  assert.doesNotMatch(source, /className="messages" ref=\{taskScroll.scroll\}/);
});

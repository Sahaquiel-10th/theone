import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseCopy,greetings,waitingLines,pickPersonality} from './OnePersonality';
import {greetingEggs,waitingEggs} from './onePersonalityCopy';
test('personality always names ONE, never its internal logo nickname',()=>{
 for(const line of [...greetings,...waitingLines,...greetingEggs,...waitingEggs])assert.doesNotMatch(line,/眼睛|本眼|一只眼|第二只眼/);
});
test('personality copy is varied and never immediately repeats',()=>{
 assert.ok(greetings.length>=20);assert.ok(waitingLines.length>=24);
 assert.equal(new Set(greetings).size,greetings.length);assert.equal(new Set(waitingLines).size,waitingLines.length);
 for(const lines of [greetings,waitingLines])for(let previous=0;previous<lines.length;previous++)for(const random of [0,.5,.99999]){const n=chooseCopy(lines,previous,()=>random);assert.notEqual(n,previous);assert.ok(n>=0&&n<lines.length);}
});
test('the quiet cat does not blame the user, sell enthusiasm or invent tool progress',()=>{
 for(const line of [...greetings,...waitingLines,...greetingEggs,...waitingEggs])assert.doesNotMatch(line,/别催|有事上奏|营业|恭喜|绝绝子|没有额外费用|正在搜索|正在写入/);
});
test('eggs are rare, not immediate, and recent copy is avoided',()=>{
 const lines=['a','b','c','d','e'],eggs=['egg'];const history:string[]=[];
 assert.notEqual(pickPersonality(lines,eggs,history,()=>0),'egg');
 for(let i=0;i<3;i++)pickPersonality(lines,eggs,history,()=>.5);
 assert.equal(pickPersonality(lines,eggs,history,()=>0),'egg');
 const before=history.at(-1);assert.notEqual(pickPersonality(lines,eggs,history,()=>.5),before);
});

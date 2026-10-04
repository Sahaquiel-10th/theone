import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseCopy,greetings,waitingLines,pickPersonality} from './OnePersonality';
import {greetingEggs,waitingEggs} from './onePersonalityCopy';
test('personality always names ONE, never its internal logo nickname',()=>{
 for(const line of [...greetings,...waitingLines,...greetingEggs,...waitingEggs])assert.doesNotMatch(line,/眼睛|本眼|一只眼|第二只眼/);
});
test('personality copy is varied and never immediately repeats',()=>{
 assert.ok(greetings.length>=60);assert.ok(waitingLines.length>=100);
 for(const lines of [greetings,waitingLines])for(let previous=0;previous<lines.length;previous++)for(const random of [0,.5,.99999]){const n=chooseCopy(lines,previous,()=>random);assert.notEqual(n,previous);assert.ok(n>=0&&n<lines.length);}
});
test('eggs are rare, not immediate, and recent copy is avoided',()=>{
 const lines=['a','b','c','d','e'],eggs=['egg'];const history:string[]=[];
 assert.notEqual(pickPersonality(lines,eggs,history,()=>0),'egg');
 for(let i=0;i<3;i++)pickPersonality(lines,eggs,history,()=>.5);
 assert.equal(pickPersonality(lines,eggs,history,()=>0),'egg');
 const before=history.at(-1);assert.notEqual(pickPersonality(lines,eggs,history,()=>.5),before);
});

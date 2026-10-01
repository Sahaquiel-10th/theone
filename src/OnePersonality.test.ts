import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseCopy,greetings,waitingLines} from './OnePersonality';
test('personality copy is varied and never immediately repeats',()=>{
 assert.ok(greetings.length>=20);assert.ok(waitingLines.length>=20);
 for(const lines of [greetings,waitingLines])for(let previous=0;previous<lines.length;previous++)for(const random of [0,.5,.99999]){const n=chooseCopy(lines,previous,()=>random);assert.notEqual(n,previous);assert.ok(n>=0&&n<lines.length);}
});

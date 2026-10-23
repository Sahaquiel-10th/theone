import test from 'node:test';
import assert from 'node:assert/strict';
import {cacheProbeOptions} from '../scripts/probe-context-cache.js';

test('cache probe requires explicit consent and accepts a specific native-model ID',()=>{
 assert.throws(()=>cacheProbeOptions([]));
 assert.throws(()=>cacheProbeOptions(['--model-id','mdl_example']));
 assert.deepEqual(cacheProbeOptions(['--run-two-public-calls']),{modelId:undefined});
 assert.deepEqual(cacheProbeOptions(['--run-two-public-calls','--model-id','mdl_example']),{modelId:'mdl_example'});
});
test('cache probe rejects unknown flags, missing IDs, URLs and SQL-shaped IDs before opening the database',()=>{
 for(const args of [['--retry'],['--model-id'],['--model-id',''],['--model-id','https://example.com'],['--model-id',"x' OR 1=1"],['unexpected']])assert.throws(()=>cacheProbeOptions(['--run-two-public-calls',...args]));
});

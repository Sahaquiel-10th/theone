import test from 'node:test';
import assert from 'node:assert/strict';
import {parseToolRecoveryDiagnostic,toolRecoveryDiagnostic,ToolRecoveryError,systemParameterFault,parseArgumentRepairBudget} from './toolRecovery.js';
import {completedSteps,stepProgress,type TaskStep} from './taskSteps.js';
test('tool recovery diagnostics reject arbitrary objects and private fields while code errors carry a fixed safe fault',()=>{
 const safe=systemParameterFault('artifact_validation_failed','exhausted',['sheets.rows']);
 assert.deepEqual(parseToolRecoveryDiagnostic(safe),safe);assert.equal(toolRecoveryDiagnostic({failure:safe}),undefined);
 const error=new ToolRecoveryError(safe);assert.deepEqual(toolRecoveryDiagnostic(error),safe);assert.doesNotMatch(JSON.stringify(error),/fields|sheets/);
 for(const invalid of [{...safe,message:'api_key=SECRET'},{...safe,fields:['/Users/private']},{...safe,kind:'missing_input'},{...safe,repair:'retry_forever'},{...safe,code:'provider_error'}])assert.equal(parseToolRecoveryDiagnostic(invalid),undefined);
});
test('repair controls are not business results or pending work and their metadata parser is strict',()=>{
 const control:TaskStep={key:'control',namespace:'feature:x:control',tool:'__argument_repair_budget',label:'internal',effect:'read',state:'completed',output:{version:1,used:1,maxAttempts:2,fingerprints:['a'.repeat(64)]},updatedAt:new Date().toISOString()};
 assert.deepEqual(completedSteps([control]),[]);assert.deepEqual(stepProgress([control]),{completed:[],pending:[]});assert.ok(parseArgumentRepairBudget(control.output));
 for(const invalid of [{...(control.output as object),query:'SECRET'},{version:1,used:-1,maxAttempts:2,fingerprints:[]},{version:1,used:1,maxAttempts:3,fingerprints:[]}])assert.equal(parseArgumentRepairBudget(invalid),undefined);
});

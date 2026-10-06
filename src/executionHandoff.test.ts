import test from 'node:test';
import assert from 'node:assert/strict';
import {executionHandoffOutcome} from './executionHandoff.js';

test('only the current settled dispatch can close optimistic execution feedback',()=>{
 assert.equal(executionHandoffOutcome('current',null),'pending');
 assert.equal(executionHandoffOutcome('current',{operationId:'old',status:'completed'}),'pending');
 assert.equal(executionHandoffOutcome('current',{operationId:'current',status:'pending'}),'pending');
 assert.equal(executionHandoffOutcome('current',{operationId:'current',status:'completed'}),'not_started');
 assert.equal(executionHandoffOutcome('current',{operationId:'current',status:'failed',taskId:'thing'}),'not_started');
 assert.equal(executionHandoffOutcome('current',{operationId:'current',status:'completed',taskId:'thing'}),'dispatched');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCoordinatorInput,coordinatorInputFeedback,coordinatorInputHint,CoordinatorInputError,CoordinatorInputTooLongError,COORDINATOR_MAX_INPUT_CHARS} from './coordinatorInput.js';

test('accepted pasted text keeps every character at the old and new boundaries',()=>{
  for (const size of [8000,8001,10000,COORDINATOR_MAX_INPUT_CHARS]) {
    const text='首'+ '中'.repeat(size-2)+'尾';
    assert.equal(assertCoordinatorInput(text),text);
    assert.equal(coordinatorInputFeedback(text),undefined);
  }
  assert.equal(coordinatorInputHint('中'.repeat(8000)),undefined);
  assert.match(coordinatorInputHint('中'.repeat(8001))!,/8,001.*32,000.*附件/);
});
test('an oversized input is rejected without returning a truncated substitute',()=>{
  const text='首'+ '中'.repeat(COORDINATOR_MAX_INPUT_CHARS-1)+'尾';
  assert.throws(()=>assertCoordinatorInput(text),error=>error instanceof CoordinatorInputTooLongError&&error.status===413&&error.inputChars===32001&&error.maxInputChars===32000);
  assert.match(coordinatorInputFeedback(text)!,/32,000.*附件.*保留.*原文.*附件/);
  assert.equal(text.length,32001);assert.ok(text.endsWith('尾'));
  assert.throws(()=>assertCoordinatorInput(' '.repeat(32001)),CoordinatorInputTooLongError);
});
test('emoji and mixed Chinese text use the same JS character measure on both sides',()=>{
  const limit='🐈'.repeat(16000);
  assert.equal(assertCoordinatorInput(limit),limit);assert.equal(coordinatorInputFeedback(limit),undefined);
  assert.throws(()=>assertCoordinatorInput(limit+'喵'),CoordinatorInputTooLongError);
  assert.match(coordinatorInputFeedback(limit+'喵')!,/32,000/);
  for (const invalid of [undefined,null,{},'', ' \n\t']) assert.throws(()=>assertCoordinatorInput(invalid),CoordinatorInputError);
  assert.equal(coordinatorInputFeedback(''),undefined,'an empty draft with attachments is not rejected by a UI length check');
});

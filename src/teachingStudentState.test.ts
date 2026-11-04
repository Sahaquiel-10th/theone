import test from 'node:test';
import assert from 'node:assert/strict';
import { readStudentSubmissionAttempt, requireStudentSubmissionReceipt, saveStudentSubmissionAttempt, studentActivityFromSearch } from './teachingStudentState';
import type { TeachingPublicActivity } from '../server/teachingTypes';
const attempt = { operationId: 'original-request-0001', payload: JSON.stringify({ activityId: 'assignment', text: '', answers: {}, attachmentIds: ['private-file'] }), files: [{ id: 'private-file', originalName: '作业.docx' }] };
const storage = () => { const values = new Map<string,string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key,value); }, removeItem: (key: string) => { values.delete(key); } }; };
test('reload keeps the original attachment-only request; another student or course cannot restore it', () => {
  const store = storage(); saveStudentSubmissionAttempt(store, 'course-one', 'student-one', attempt);
  assert.deepEqual(readStudentSubmissionAttempt(store, 'course-one', 'student-one'), attempt);
  assert.equal(readStudentSubmissionAttempt(store, 'course-one', 'student-two'), undefined);
  assert.equal(readStudentSubmissionAttempt(store, 'course-two', 'student-one'), undefined);
  saveStudentSubmissionAttempt(store, 'course-one', 'student-one'); assert.equal(readStudentSubmissionAttempt(store, 'course-one', 'student-one'), undefined);
});
test('malformed local receipt or unavailable browser storage cannot become a new paid or submission attempt', () => {
  const store = storage(); saveStudentSubmissionAttempt(store, 'course', 'student', { ...attempt, payload: '{}' });
  assert.equal(readStudentSubmissionAttempt(store, 'course', 'student'), undefined);
  saveStudentSubmissionAttempt(undefined, 'course', 'student', attempt); assert.equal(readStudentSubmissionAttempt(undefined, 'course', 'student'), undefined);
});
test('share query selects only a returned published activity and cannot introduce a foreign activity', () => {
  const activities = [{ id: 'before' }, { id: 'assignment' }] as TeachingPublicActivity[];
  assert.equal(studentActivityFromSearch(activities, '?activityId=assignment')?.id, 'assignment');
  assert.equal(studentActivityFromSearch(activities, '?activity=assignment')?.id, 'assignment');
  assert.equal(studentActivityFromSearch(activities, '?activityId=foreign')?.id, 'before');
});


test('generic success and a foreign or mismatched receipt never clear the original request', () => {
  for (const response of [{}, { ok: true }, { submission: { id: 'foreign', operationId: attempt.operationId, courseId: 'foreign-course', activityId: 'assignment' } }, { submission: { id: 'wrong', operationId: 'other-request', courseId: 'course', activityId: 'assignment' } }]) assert.throws(() => requireStudentSubmissionReceipt(response, attempt.operationId, 'course', 'assignment'), /回执尚未确认/);
  assert.doesNotThrow(() => requireStudentSubmissionReceipt({ submission: { id: 'own', operationId: attempt.operationId, courseId: 'course', activityId: 'assignment' } }, attempt.operationId, 'course', 'assignment'));
});

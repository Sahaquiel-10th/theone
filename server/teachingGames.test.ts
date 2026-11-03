import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Database } from './types.js';
import { createTeachingActivity, createTeachingCourse, createTeachingSession, createTeachingTask, publishTeachingCourse, teachingState, TeachingError } from './teaching.js';
import { publicTeachingGameConfig, teachingGameHistory, teachingGameModelHistory, teachingGameSnapshot, updateTeachingGameConfig } from './teachingGames.js';
import type { TeachingGameConfig, TeachingOperation } from './teachingTypes.js';

const scope = { workspaceId: 'wa', userId: 'teacher-a' };
function setup() {
  const db = { users: [{ id: 'teacher-a', enabled: true }, { id: 'teacher-b', enabled: true }], workspaces: [{ id: 'wa', status: 'active' }, { id: 'wb', status: 'active' }], workspaceMembers: [{ ...scope, role: 'owner' }, { workspaceId: 'wb', userId: 'teacher-b', role: 'owner' }], attachments: [] } as unknown as Database;
  const { course, activity } = createTeachingTask(db, scope, { draftId: 'game_test_draft', kind: 'game' });
  const sibling = createTeachingActivity(db, scope, course.id, { revision: course.revision, title: '另一个游戏', stage: 'during', kind: 'game', status: 'published', allowStudentPrompt: false }).activity;
  publishTeachingCourse(db, scope, course.id, { revision: course.revision, confirmed: true });
  const one = createTeachingSession(db, course.slug!, { participantName: '同名', consent: true });
  const two = createTeachingSession(db, course.slug!, { participantName: '同名', consent: true });
  return { db, course, activity, sibling, one, two };
}
const fails = (fn: () => unknown, status: number) => assert.throws(fn, error => error instanceof TeachingError && error.status === status);
function operation(config: TeachingGameConfig, overrides: Partial<TeachingOperation> = {}): TeachingOperation {
  return { workspaceId: config.workspaceId, userId: config.userId, id: 'game_op_1', courseId: config.courseId, activityId: config.activityId, sessionId: config.sessionId, operationId: 'game_operation_001', payloadHash: 'hash', kind: 'answer', conversationId: config.conversationId, gameRevision: config.revision, question: '我往前走', status: 'completed', result: { kind: 'answer', answer: '你遇见一位茶农。', choices: ['向茶农提问', '观察周围'] }, createdAt: new Date().toISOString(), ...overrides };
}

test('first game read is deterministic and read-only; saving modifies only the exact student activity config', () => {
  const { db, course, activity, sibling, one, two } = setup(), before = JSON.stringify(db);
  const first = teachingGameSnapshot(db, scope, course.id, activity.id, one.sessionId);
  assert.equal(first.revision, 0); assert.deepEqual(teachingGameSnapshot(db, scope, course.id, activity.id, one.sessionId), first); assert.equal(JSON.stringify(db), before);
  const teacherPrompt = activity.avatarPrompt, courseRevision = course.revision;
  const saved = updateTeachingGameConfig(db, scope, course.id, activity.id, one.sessionId, { revision: 0, roleName: '修堤学徒', prompt: '我想与同伴讨论怎么修堤', workspaceId: 'wb', userId: 'teacher-b', sourceIds: ['private'], modelId: 'other', rubric: [{ score: 100 }], avatarPrompt: 'overwrite' });
  assert.equal(saved.revision, 1); assert.notEqual(saved.conversationId, first.conversationId);
  assert.equal(activity.avatarPrompt, teacherPrompt); assert.equal(course.revision, courseRevision); assert.equal(saved.userId, scope.userId);
  assert.equal(teachingGameSnapshot(db, scope, course.id, activity.id, two.sessionId).revision, 0);
  assert.equal(teachingGameSnapshot(db, scope, course.id, sibling.id, one.sessionId).revision, 0);
  const json = JSON.stringify(publicTeachingGameConfig(saved)); assert.doesNotMatch(json, /workspaceId|userId|sessionId|sourceIds|modelId|rubric|avatarPrompt/);
  fails(() => updateTeachingGameConfig(db, scope, course.id, sibling.id, one.sessionId, { revision: 0, roleName: 'x', prompt: 'x' }), 403);
  fails(() => teachingGameSnapshot(db, { workspaceId: 'wb', userId: 'teacher-b' }, course.id, activity.id, one.sessionId), 404);
  fails(() => teachingGameSnapshot(db, scope, course.id, activity.id, 'missing-session'), 401);
});

test('game config changes split conversations, check revision and preserve old operations without leaking another scope', () => {
  const { db, course, activity, one, two } = setup();
  const first = updateTeachingGameConfig(db, scope, course.id, activity.id, one.sessionId, { revision: 0, roleName: '学徒', prompt: '帮我进行短冒险' });
  const operations = teachingState(db, scope).operations;
  operations.push(operation(first));
  operations.push(operation(first, { id: 'foreign-session', sessionId: two.sessionId, question: 'PRIVATE_OTHER_STUDENT', result: { kind: 'answer', answer: 'PRIVATE_OTHER_ANSWER' } }));
  operations.push(operation(first, { id: 'foreign-workspace', workspaceId: 'wb', question: 'PRIVATE_WORKSPACE' }));
  operations.push(operation(first, { id: 'foreign-activity', activityId: 'other', question: 'PRIVATE_ACTIVITY' }));
  const history = teachingGameHistory(db, scope, course.id, activity.id, one.sessionId);
  assert.equal(history.length, 1); assert.equal(history[0].operationId, 'game_operation_001'); assert.deepEqual(history[0].choices, ['向茶农提问', '观察周围']);
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE_|payloadHash|workspaceId|userId|sessionId|gamePromptSnapshot/);
  assert.equal(teachingGameHistory(db, scope, course.id, activity.id, two.sessionId).length, 0);
  fails(() => updateTeachingGameConfig(db, scope, course.id, activity.id, one.sessionId, { revision: 0, roleName: '旧标签页', prompt: '' }), 409);
  const next = updateTeachingGameConfig(db, scope, course.id, activity.id, one.sessionId, { revision: 1, roleName: '茶农', prompt: '开始另一个故事' });
  assert.notEqual(first.conversationId, next.conversationId); assert.equal(next.revision, 2);
  assert.equal(teachingGameHistory(db, scope, course.id, activity.id, one.sessionId).length, 0);
  assert.equal(operations.length, 4); fails(() => teachingGameHistory(db, scope, course.id, activity.id, one.sessionId, first.conversationId), 409);
});

test('game changes reject in-flight operations and oversized prompts; model context contains only six bounded completed pairs', () => {
  const { db, course, activity, one } = setup(), current = teachingGameSnapshot(db, scope, course.id, activity.id, one.sessionId), operations = teachingState(db, scope).operations;
  operations.push(operation(current, { status: 'running' }));
  fails(() => updateTeachingGameConfig(db, scope, course.id, activity.id, one.sessionId, { revision: 0, roleName: 'x', prompt: 'x' }), 409);
  operations[0].status = 'uncertain';
  fails(() => updateTeachingGameConfig(db, scope, course.id, activity.id, one.sessionId, { revision: 0, roleName: 'x', prompt: 'x'.repeat(4001) }), 400);
  for (let index = 0; index < 9; index++) operations.push(operation(current, { id: `completed_${index}`, operationId: `completed_op_${index}`, question: `question ${index}`, result: { kind: 'answer', answer: `answer ${index}` } }));
  const history = teachingGameModelHistory(db, scope, course.id, activity.id, one.sessionId);
  assert.equal(history.length, 6); assert.equal(history[0].question, 'question 3'); assert.equal(history[5].answer, 'answer 8');
  assert.equal(history.some(turn => turn.question === '我往前走'), false);
  operations.push(operation(current, { id: 'last-large', question: 'q'.repeat(6000), result: { kind: 'answer', answer: 'a'.repeat(12000) } }));
  const bounded = teachingGameModelHistory(db, scope, course.id, activity.id, one.sessionId);
  assert.ok(bounded.reduce((sum, turn) => sum + turn.question.length + turn.answer.length, 0) <= 24000);
});

test('actual Store restart recovers task idempotency, student config and only this game conversation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'one-teaching-game-restart-'));
  try {
    const env = { ...process.env, NODE_ENV: 'test', DB_PROVIDER: 'json', ONE_DATA_DIR: directory, ADMIN_INITIAL_PASSWORD: 'isolated-game-test-password' };
    const imports = `import {store} from './server/db.ts';import * as t from './server/teaching.ts';import * as g from './server/teachingGames.ts';`;
    const write = `${imports} const result=await store.mutate(db=>{const u=db.users[0],s={workspaceId:u.defaultWorkspaceId,userId:u.id};const {course,activity}=t.createTeachingTask(db,s,{draftId:'durable_game_draft',kind:'game'});t.publishTeachingCourse(db,s,course.id,{revision:course.revision,confirmed:true});const guest=t.createTeachingSession(db,course.slug,{participantName:'学生',consent:true});const config=g.updateTeachingGameConfig(db,s,course.id,activity.id,guest.sessionId,{revision:0,roleName:'茶农',prompt:'保留我的故事'});t.teachingState(db,s).operations.push({...s,id:'durable_op',courseId:course.id,activityId:activity.id,sessionId:guest.sessionId,operationId:'durable_game_operation',payloadHash:'hash',kind:'answer',conversationId:config.conversationId,gameRevision:config.revision,status:'completed',question:'继续',result:{kind:'answer',answer:'故事继续了',choices:['向前']},createdAt:new Date().toISOString()});return {slug:course.slug,token:guest.token,courseId:course.id,activityId:activity.id};});console.log(JSON.stringify(result));`;
    const saved = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', write], { cwd: process.cwd(), env, encoding: 'utf8' }).trim();
    const read = `${imports} const info=${saved};const result=await store.mutate(db=>{const {scope,session}=t.authTeachingSession(db,info.slug,info.token);const repeated=t.createTeachingTask(db,scope,{draftId:'durable_game_draft',kind:'game'});return {duplicate:repeated.duplicate,courseId:repeated.course.id,config:g.publicTeachingGameConfig(g.teachingGameSnapshot(db,scope,info.courseId,info.activityId,session.id)),history:g.teachingGameHistory(db,scope,info.courseId,info.activityId,session.id)};});console.log(JSON.stringify(result));`;
    const actual = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', read], { cwd: process.cwd(), env, encoding: 'utf8' }).trim());
    assert.equal(actual.duplicate, true); assert.equal(actual.config.roleName, '茶农'); assert.equal(actual.config.prompt, '保留我的故事'); assert.equal(actual.history[0].answer, '故事继续了');
    assert.doesNotMatch(JSON.stringify(actual.config), /tokenHash|workspaceId|userId|sessionId/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
